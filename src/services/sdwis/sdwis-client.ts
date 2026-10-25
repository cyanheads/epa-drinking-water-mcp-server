/**
 * @fileoverview Fixed-origin, paced DMAP reads with one deadline and public projection.
 * @module services/sdwis/sdwis-client
 */
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  type PublicRow,
  parseRows,
  sortColumns,
  type Table,
  tableSchemas,
} from '@/domain/sdwis-contracts.js';

/** Verified DMAP predicate spellings. */
export type Operator =
  | 'equals'
  | 'contains'
  | 'beginsWith'
  | 'greaterThan'
  | 'greaterThanEqual'
  | 'in';
/** One allowlisted column predicate; values are encoded as a single segment. */
export interface Predicate {
  column: string;
  operator: Operator;
  value: string;
}
/** A page with explicitly public rows and available HTTP metadata. */
export interface SourcePage {
  etag?: string;
  last_modified?: string;
  retrieved_at: string;
  rows: PublicRow[];
  url: string;
}
const origin = 'https://data.epa.gov';
let nextStart = 0;
let active = 0;

/** Abort-aware wait used by both admission and bounded retries. */
async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** Build paths only from fixed tables, projected columns and verified operators. */
export function dmapUrl(table: Table, predicates: Predicate[], first: number, size: number): URL {
  const columns = new Set(Object.keys(tableSchemas[table].shape));
  const operators = new Set<Operator>([
    'equals',
    'contains',
    'beginsWith',
    'greaterThan',
    'greaterThanEqual',
    'in',
  ]);
  const paths = [`sdwis.${table}`];
  for (const [index, predicate] of predicates.entries()) {
    if (
      !columns.has(predicate.column) ||
      !operators.has(predicate.operator) ||
      /[/\\?#%]/.test(predicate.value) ||
      Array.from(predicate.value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw validationError('Unsupported DMAP selector.', { reason: 'invalid_selector' });
    if (index) paths.push('and');
    paths.push(predicate.column, predicate.operator, encodeURIComponent(predicate.value));
  }
  paths.push('sort', sortColumns(table).join(','), `${first}:${first + size - 1}`, 'json');
  return new URL(`/dmapservice/${paths.join('/')}`, origin);
}
function matches(row: PublicRow, predicate: Predicate): boolean {
  const actual = row[predicate.column];
  if (actual === null || actual === undefined) return false;
  const value = String(actual).toUpperCase();
  const expected = predicate.value.toUpperCase();
  switch (predicate.operator) {
    case 'equals':
      return value === expected;
    case 'contains':
      return value.includes(expected);
    case 'beginsWith':
      return value.startsWith(expected);
    case 'in':
      return expected.split(',').includes(value);
    case 'greaterThan':
      return typeof actual === 'number' ? actual > Number(expected) : value > expected;
    case 'greaterThanEqual':
      return typeof actual === 'number' ? actual >= Number(expected) : value >= expected;
  }
}
/** Read one sorted, one-based inclusive page; retry only transport/transient status failures. */
export async function readPage(
  table: Table,
  predicates: Predicate[],
  first: number,
  size: number,
  signal: AbortSignal,
): Promise<SourcePage> {
  const url = dmapUrl(table, predicates, first, size);
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    while (active >= 2 || Date.now() < nextStart)
      await wait(Math.max(1, nextStart - Date.now(), active >= 2 ? 25 : 0), signal);
    nextStart = Date.now() + 1000;
    active++;
    let text: string;
    let response: Response | undefined;
    let retryAfterMs = 0;
    try {
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      response = await fetch(url, { signal: attemptSignal, redirect: 'manual' });
      if (!response.ok) {
        await response.body?.cancel();
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          retryAfterMs = Math.min(
            5000,
            Math.max(
              0,
              Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now(),
            ),
          );
        }
        const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        const code =
          response.status === 403
            ? JsonRpcErrorCode.Forbidden
            : response.status === 429
              ? JsonRpcErrorCode.RateLimited
              : response.status === 408
                ? JsonRpcErrorCode.Timeout
                : JsonRpcErrorCode.ServiceUnavailable;
        const error = new McpError(code, `EPA DMAP request failed with HTTP ${response.status}.`, {
          status: response.status,
          retryable,
        });
        if (!retryable) throw error;
        lastFailure = error;
        text = '';
      } else {
        text = await response.text();
        attemptSignal.throwIfAborted();
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof McpError && error.data?.retryable === false) throw error;
      lastFailure = error;
      text = '';
      response = undefined;
    } finally {
      active--;
    }
    if (text && response) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw serviceUnavailable('EPA returned invalid JSON.', {
          reason: 'upstream_contract_changed',
        });
      }
      const rows = parseRows(table, raw);
      if (rows.some((row) => predicates.some((predicate) => !matches(row, predicate))))
        throw serviceUnavailable('EPA did not apply the requested table predicates.', {
          reason: 'upstream_contract_changed',
        });
      const etag = response.headers.get('etag');
      const modified = response.headers.get('last-modified');
      return {
        rows,
        url: url.href,
        retrieved_at: new Date().toISOString(),
        ...(etag ? { etag } : {}),
        ...(modified ? { last_modified: modified } : {}),
      };
    }
    if (attempt < 2)
      await wait(
        Math.max(retryAfterMs, Math.min(5000, 500 * 2 ** attempt + Math.random() * 200)),
        signal,
      );
  }
  signal.throwIfAborted();
  if (lastFailure instanceof McpError) throw lastFailure;
  throw serviceUnavailable('EPA DMAP could not complete after three attempts.', undefined, {
    cause: lastFailure,
  });
}
