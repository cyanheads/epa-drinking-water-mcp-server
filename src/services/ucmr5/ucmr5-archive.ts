/**
 * @fileoverview Streaming, allowlisted UCMR ZIP acquisition and CP1252 TSV ingestion.
 * @module services/ucmr5/ucmr5-archive
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { z } from '@cyanheads/mcp-ts-core';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { parse } from 'csv-parse';
import { openPromise, type ZipFile } from 'yauzl';
import { additionalHeaders, occurrenceHeaders, zipHeaders } from '../../domain/ucmr5-schemas.js';
import { datasetChanged, Ucmr5Index } from './ucmr5-index.js';

/** The sole supported EPA bulk source, never caller-selected. */
export const UCMR5_ARCHIVE_URL =
  'https://www.epa.gov/system/files/other-files/2023-08/ucmr5-occurrence-data.zip';
const COMPRESSED_LIMIT = 32 * 1024 * 1024;
const EXPANDED_LIMIT = 400 * 1024 * 1024;
function isStringRow(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((cell: unknown) => typeof cell === 'string');
}
const supported = new Map<
  string,
  { relation: 'occurrence' | 'additional' | 'zip'; headers: readonly string[] }
>([
  ['UCMR5_All.txt', { relation: 'occurrence', headers: occurrenceHeaders }],
  ['UCMR5_AddtlDataElem.txt', { relation: 'additional', headers: additionalHeaders }],
  ['UCMR5_ZIPCodes.txt', { relation: 'zip', headers: zipHeaders }],
] as const);
const documentation = new Set([
  'InstructionsforAccessingUCMRResults_Jan2025_508.pdf',
  'UCMR5_DataSummary_Jul2026_508.pdf',
]);

/** HTTP metadata is separate from the publisher's final-release label. */
export interface Ucmr5Revision {
  archive_sha256: string;
  archive_url: string;
  etag: string | null;
  last_modified: string | null;
  published_release: string;
  retrieved_at: string;
}
/** Private compressed scratch owned by one awaited loader. */
export interface DownloadedArchive {
  cleanup(): Promise<void>;
  path: string;
  revision: Ucmr5Revision;
}

/** Validate every redirect before any new outbound request. */
export async function archiveRequest(
  fetcher: typeof fetch,
  method: 'GET' | 'HEAD',
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<Response> {
  let url = new URL(UCMR5_ARCHIVE_URL);
  for (let hop = 0; hop <= 5; hop++) {
    signal.throwIfAborted();
    const response = await fetcher(url, {
      method,
      signal,
      redirect: 'manual',
      ...(headers ? { headers } : {}),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop === 5)
        throw datasetChanged('UCMR archive redirect is missing or exceeds the supported chain.');
      const destination = new URL(location, url);
      if (
        destination.origin !== new URL(UCMR5_ARCHIVE_URL).origin ||
        destination.pathname !== new URL(UCMR5_ARCHIVE_URL).pathname ||
        destination.search ||
        destination.hash ||
        destination.username ||
        destination.password
      )
        throw datasetChanged('UCMR archive redirected outside its supported HTTPS source.');
      url = destination;
      continue;
    }
    return response;
  }
  throw new Error('Unreachable UCMR redirect loop.');
}

/** Stream compressed bytes to mode-0600 scratch while hashing and enforcing size. */
export async function downloadArchive(
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<DownloadedArchive> {
  const directory = await mkdtemp(join(tmpdir(), 'epa-ucmr5-'));
  const path = join(directory, 'archive.zip');
  try {
    await chmod(directory, 0o700);
    const response = await archiveRequest(fetcher, 'GET', signal);
    if (!response.ok)
      throw await httpErrorFromResponse(response, { service: 'EPA UCMR', captureBody: false });
    if (!response.body) throw datasetChanged('EPA returned an empty UCMR archive body.');
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > COMPRESSED_LIMIT) {
      await response.body.cancel();
      throw datasetChanged('UCMR compressed archive exceeds 32 MiB.');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (chunks) {
        for await (const raw of chunks) {
          signal.throwIfAborted();
          const chunk = z.instanceof(Uint8Array).parse(raw);
          bytes += chunk.byteLength;
          if (bytes > COMPRESSED_LIMIT)
            throw datasetChanged('UCMR compressed archive exceeds 32 MiB.');
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(path, { mode: 0o600, flags: 'wx' }),
      { signal },
    );
    return {
      path,
      revision: {
        archive_url: UCMR5_ARCHIVE_URL,
        archive_sha256: hash.digest('hex'),
        last_modified: response.headers.get('last-modified'),
        etag: response.headers.get('etag'),
        retrieved_at: new Date().toISOString(),
        published_release: 'UCMR 5 final release, August 2026',
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}

/** Read named streams only; no ZIP entry is ever extracted to the filesystem. */
export async function parseArchive(path: string, signal: AbortSignal): Promise<Ucmr5Index> {
  let zip: ZipFile | undefined;
  const abort = () => zip?.close();
  const index = new Ucmr5Index();
  try {
    signal.throwIfAborted();
    zip = await openPromise(path, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    const entries = [];
    let expanded = 0;
    const names = new Set<string>();
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      if (
        names.has(entry.fileName) ||
        (!supported.has(entry.fileName) && !documentation.has(entry.fileName)) ||
        entry.isEncrypted()
      )
        throw datasetChanged(
          'UCMR archive entry names or encryption no longer match the supported publication.',
        );
      names.add(entry.fileName);
      expanded += entry.uncompressedSize;
      if (
        expanded > EXPANDED_LIMIT ||
        entry.compressedSize > COMPRESSED_LIMIT ||
        !Number.isSafeInteger(entry.crc32)
      )
        throw datasetChanged(
          'UCMR archive metadata exceeds supported expanded sizes or CRC contract.',
        );
      if (supported.has(entry.fileName)) entries.push(entry);
    }
    if (entries.length !== supported.size)
      throw datasetChanged('UCMR archive is missing a required relation.');
    let expandedRead = 0;
    for (const entry of entries) {
      signal.throwIfAborted();
      const contract = supported.get(entry.fileName);
      if (!contract) throw new Error('UCMR allowlist contract is missing.');
      const stream = await zip.openReadStreamPromise(entry);
      const decoder = new TextDecoder('windows-1252', { fatal: true });
      let checksum = 0;
      let entryBytes = 0;
      let header = false;
      // EPA also places literal quotation marks inside unquoted sample-point names.
      const parser = parse({
        delimiter: '\t',
        record_delimiter: ['\r\n', '\n'],
        bom: false,
        relax_quotes: true,
        relax_column_count: false,
        on_record: (raw: unknown) => {
          signal.throwIfAborted();
          if (!isStringRow(raw)) throw datasetChanged('UCMR parser returned an invalid row.');
          if (!header) {
            if (
              raw.length !== contract.headers.length ||
              raw.some((cell, position) => cell !== contract.headers[position])
            )
              throw datasetChanged(
                'UCMR TSV header no longer matches its supported column contract.',
              );
            header = true;
          } else index.append(contract.relation, raw);
          // Consume directly into columns instead of buffering millions of intermediate row arrays.
          return null;
        },
      });
      await pipeline(
        stream,
        async function* (chunks) {
          for await (const raw of chunks) {
            signal.throwIfAborted();
            const chunk = z.instanceof(Uint8Array).parse(raw);
            entryBytes += chunk.byteLength;
            expandedRead += chunk.byteLength;
            if (entryBytes > entry.uncompressedSize || expandedRead > EXPANDED_LIMIT)
              throw datasetChanged('UCMR expanded stream exceeds its declared size.');
            checksum = crc32(chunk, checksum);
            yield decoder.decode(chunk, { stream: true });
          }
          yield decoder.decode();
        },
        parser,
        async (records) => {
          for await (const _record of records)
            throw new Error('UCMR parser unexpectedly buffered a row.');
        },
        { signal },
      );
      if (!header || entryBytes !== entry.uncompressedSize || checksum !== entry.crc32)
        throw datasetChanged('UCMR ZIP stream failed its size or CRC integrity check.');
    }
    index.finish();
    return index;
  } catch (cause) {
    signal.throwIfAborted();
    if (cause instanceof Error && 'data' in cause) throw cause;
    throw datasetChanged(
      'UCMR archive could not be parsed under its supported TSV contract.',
      cause,
    );
  } finally {
    signal.removeEventListener('abort', abort);
    zip?.close();
  }
}
