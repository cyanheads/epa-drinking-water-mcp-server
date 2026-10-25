/**
 * @fileoverview Awaited, leased UCMR revision lifecycle with shared cancellable acquisition.
 * @module services/ucmr5/ucmr5-service
 */
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { Ucmr5Occurrence } from '../../domain/ucmr5-schemas.js';
import {
  archiveRequest,
  downloadArchive,
  parseArchive,
  type Ucmr5Revision,
} from './ucmr5-archive.js';
import type { Ucmr5Index, Ucmr5Selection } from './ucmr5-index.js';

const FRESH_MS = 6 * 60 * 60 * 1000;
const LOAD_MS = 180000;

function isTransient(cause: unknown): boolean {
  if (!(cause instanceof Error) || cause.name === 'AbortError') return false;
  if (cause instanceof TypeError || cause.name === 'TimeoutError') return true;
  if (
    'code' in cause &&
    ['ECONNRESET', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE', 'ConnectionClosed'].includes(
      String(cause.code),
    )
  )
    return true;
  return (
    'data' in cause &&
    typeof cause.data === 'object' &&
    cause.data !== null &&
    'status' in cause.data &&
    [408, 429, 500, 502, 503, 504].includes(Number(cause.data.status))
  );
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(cause);
      },
    );
  });
}

/** A caller must release its read lease after completing selection and companion retrieval. */
export interface Ucmr5Lease {
  companions(
    rows: readonly Ucmr5Occurrence[],
    signal: AbortSignal,
  ): ReturnType<Ucmr5Index['companions']>;
  contaminants(): string[];
  measurements(): ReturnType<Ucmr5Index['measurements']>;
  release(): void;
  revision: Ucmr5Revision;
  search(
    selection: Ucmr5Selection,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): ReturnType<Ucmr5Index['search']>;
  zipPwsids(zip: string): ReadonlySet<string>;
}
interface ActiveLoad {
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
}

/** Public EPA index; dependency injection is limited to the actual HTTP boundary. */
export class Ucmr5Service {
  private readonly fetcher: typeof fetch;
  private index: Ucmr5Index | undefined;
  private revision: Ucmr5Revision | undefined;
  private checkedAt = 0;
  private loading: ActiveLoad | undefined;
  private readers = 0;
  private drained: (() => void)[] = [];
  private closed = false;

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.fetcher = options.fetch ?? fetch;
  }

  /** Revalidate only on an awaited request; never start detached refresh work. */
  async acquire(signal: AbortSignal): Promise<Ucmr5Lease> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('UCMR service is closed.');
    if (!this.index || Date.now() - this.checkedAt >= FRESH_MS || this.loading) {
      if (!this.loading) {
        const controller = new AbortController();
        const timer = setTimeout(
          () =>
            controller.abort(
              new DOMException('UCMR archive acquisition exceeded 180 seconds.', 'TimeoutError'),
            ),
          LOAD_MS,
        );
        const load: ActiveLoad = { controller, waiters: 0, promise: Promise.resolve() };
        this.loading = load;
        load.promise = this.refresh(controller.signal).finally(() => {
          clearTimeout(timer);
          if (this.loading === load) this.loading = undefined;
        });
      }
      const load = this.loading;
      load.waiters++;
      try {
        await waitFor(load.promise, signal);
      } catch (cause) {
        if (
          signal.aborted &&
          signal.reason instanceof Error &&
          signal.reason.name === 'TimeoutError' &&
          load.waiters > 1
        )
          throw serviceUnavailable(
            'UCMR acquisition continues for another active caller; retry with a longer client timeout.',
            { reason: 'dataset_loading', retryable: true },
          );
        throw cause;
      } finally {
        load.waiters--;
        if (load.waiters === 0 && this.loading === load) {
          load.controller.abort(
            new DOMException('No UCMR acquisition callers remain.', 'AbortError'),
          );
          // The wait above carries the failure; observe cleanup without replacing caller cancellation.
          await Promise.allSettled([load.promise]);
        }
      }
    }
    signal.throwIfAborted();
    if (!this.index || !this.revision)
      throw serviceUnavailable('UCMR archive is not available.', {
        reason: 'dataset_loading',
        retryable: true,
      });
    let held: Ucmr5Index | undefined = this.index;
    const current = () => {
      if (!held) throw new Error('UCMR read lease was released.');
      return held;
    };
    this.readers++;
    return {
      revision: { ...this.revision },
      search: (selection, offset, limit, requestSignal) =>
        current().search(selection, offset, limit, requestSignal),
      companions: (rows, requestSignal) => current().companions(rows, requestSignal),
      contaminants: () => current().contaminants(),
      zipPwsids: (zip) => current().zipPwsids(zip),
      measurements: () => current().measurements(),
      release: () => {
        if (!held) return;
        held = undefined;
        this.readers--;
        if (this.readers === 0) {
          const drained = this.drained;
          this.drained = [];
          for (const resolve of drained) resolve();
        }
      },
    };
  }

  private async refresh(signal: AbortSignal): Promise<void> {
    if (this.index && this.revision && (this.revision.etag || this.revision.last_modified)) {
      const revision = this.revision;
      const metadata = await withRetry(
        async ({ signal: attemptSignal }) => {
          const response = await archiveRequest(
            this.fetcher,
            'HEAD',
            attemptSignal,
            revision.etag
              ? { 'If-None-Match': revision.etag }
              : revision.last_modified
                ? { 'If-Modified-Since': revision.last_modified }
                : {},
          );
          await response.body?.cancel();
          if (!response.ok && ![304, 405, 501].includes(response.status))
            throw await httpErrorFromResponse(response, {
              service: 'EPA UCMR',
              captureBody: false,
            });
          return response;
        },
        {
          maxRetries: 2,
          baseDelayMs: 1000,
          maxDelayMs: 5000,
          deadlineMs: 45000,
          signal,
          isTransient,
        },
      );
      if (
        metadata.status === 304 ||
        (metadata.ok &&
          ((this.revision.etag && metadata.headers.get('etag') === this.revision.etag) ||
            (!this.revision.etag &&
              this.revision.last_modified &&
              metadata.headers.get('last-modified') === this.revision.last_modified)))
      ) {
        this.checkedAt = Date.now();
        return;
      }
      if (!metadata.ok && metadata.status !== 405 && metadata.status !== 501)
        throw await httpErrorFromResponse(metadata, { service: 'EPA UCMR', captureBody: false });
    }
    const downloaded = await withRetry(
      ({ signal: attemptSignal }) => downloadArchive(this.fetcher, attemptSignal),
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        deadlineMs: LOAD_MS,
        signal,
        isTransient,
      },
    );
    try {
      if (this.index && this.revision?.archive_sha256 === downloaded.revision.archive_sha256) {
        this.revision = downloaded.revision;
        this.checkedAt = Date.now();
        return;
      }
      if (this.readers > 0) {
        let resolveDrain: (() => void) | undefined;
        const drained = new Promise<void>((resolve) => {
          resolveDrain = resolve;
          this.drained.push(resolve);
        });
        try {
          await waitFor(drained, signal);
        } finally {
          if (resolveDrain)
            this.drained = this.drained.filter((resolve) => resolve !== resolveDrain);
        }
      }
      signal.throwIfAborted();
      // Drop the old revision before allocating replacement columns under the one-index budget.
      this.index = undefined;
      this.revision = undefined;
      this.index = await parseArchive(downloaded.path, signal);
      this.revision = downloaded.revision;
      this.checkedAt = Date.now();
    } finally {
      await downloaded.cleanup();
    }
  }

  /** Abort active acquisition and await scratch/stream cleanup before shutdown completes. */
  async close(): Promise<void> {
    this.closed = true;
    const load = this.loading;
    if (load) {
      load.controller.abort(new DOMException('UCMR service is shutting down.', 'AbortError'));
      try {
        await load.promise;
      } catch (cause) {
        if (!load.controller.signal.aborted) throw cause;
      }
    }
    this.index = undefined;
    this.revision = undefined;
  }
}

let service: Ucmr5Service | undefined;
/** Initialize once during runtime setup; returns the instance for awaited teardown. */
export function initUcmr5Service(options: { fetch?: typeof fetch } = {}): Ucmr5Service {
  service = new Ucmr5Service(options);
  return service;
}
/** Obtain the service initialized by runtime setup. */
export function getUcmr5Service(): Ucmr5Service {
  if (!service) throw new Error('UCMR service was not initialized.');
  return service;
}
