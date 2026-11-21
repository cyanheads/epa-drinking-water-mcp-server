/** @fileoverview Complete EPA dictionary acquisition for row labels and empty-selector notices. */
import {
  conflict,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { PublicRow, Table } from '@/domain/sdwis-contracts.js';
import { labelColumns, labelField } from '@/domain/sdwis-label-columns.js';
import { readPage, type SourcePage } from './sdwis-client.js';

const PAGE_SIZE = 1000;
const TTL_MS = 3600000;
interface Dictionary {
  codes: Set<string>;
  expires: number;
  labels: Map<string, string | null>;
}
const codeLabels = new Map<string, Dictionary>();

async function loadDictionary(valueType: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const cached = codeLabels.get(valueType);
  if (cached && cached.expires >= Date.now()) return { dictionary: cached, pages: 0 };
  const labels = new Map<string, string | null>();
  const codes = new Set<string>();
  let offset = 1;
  let pages = 0;
  let publication: SourcePage | undefined;
  while (true) {
    const page = await readPage(
      'ref_code_value',
      [{ column: 'value_type', operator: 'equals', value: valueType }],
      offset,
      PAGE_SIZE,
      signal,
    );
    pages++;
    if (
      publication &&
      ((publication.etag && page.etag && publication.etag !== page.etag) ||
        (publication.last_modified &&
          page.last_modified &&
          publication.last_modified !== page.last_modified))
    )
      throw conflict('EPA label dictionary changed during retrieval.', {
        reason: 'source_changed',
      });
    publication = page;
    for (const row of page.rows) {
      const code = String(row.value_code);
      if (labels.has(code))
        throw serviceUnavailable('EPA repeated a label dictionary key without progress.', {
          reason: 'upstream_paging_changed',
        });
      labels.set(code, typeof row.value_description === 'string' ? row.value_description : null);
      codes.add(code.toUpperCase());
    }
    offset += page.rows.length;
    if (page.rows.length < PAGE_SIZE) break;
  }
  signal.throwIfAborted();
  const dictionary = { labels, codes, expires: Date.now() + TTL_MS };
  codeLabels.set(valueType, dictionary);
  return { dictionary, pages };
}

/** Attach dictionary descriptions in place before source rows are retained or staged. */
export async function enrichLabels(
  table: Table,
  rows: PublicRow[],
  signal: AbortSignal,
): Promise<number> {
  let pages = 0;
  for (const [column, valueType] of labelColumns[table] ?? []) {
    const fetched = rows.some((row) => typeof row[column] === 'string')
      ? await loadDictionary(valueType, signal)
      : undefined;
    pages += fetched?.pages ?? 0;
    const field = labelField(column);
    for (const row of rows) {
      const code = row[column];
      row[field] = typeof code === 'string' ? (fetched?.dictionary.labels.get(code) ?? null) : null;
    }
  }
  return pages;
}

// The UCMR family and analyte acronyms from EPA's UCMR 5 Table 2 that also fit a four-character SDWIS code.
const ucmrSelectors = new Set(['PFAS', 'PFBA', 'PFBS', 'PFDA', 'PFNA', 'PFOA', 'PFOS', 'PFTA']);
const dictionaryFailures = new Set([
  JsonRpcErrorCode.Conflict,
  JsonRpcErrorCode.Forbidden,
  JsonRpcErrorCode.RateLimited,
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
]);

/** Report absence only after successfully reading the entire corresponding dictionary. */
export async function emptySelectorNotices(
  table: Table,
  filters: Record<string, unknown>,
  signal: AbortSignal,
  callerSignal: AbortSignal,
): Promise<string[]> {
  const notices: string[] = [];
  for (const [, valueType, selector] of labelColumns[table] ?? []) {
    if (!selector) continue;
    const value = filters[selector];
    if (typeof value !== 'string') continue;
    try {
      const { dictionary } = await loadDictionary(valueType, signal);
      for (const code of selector === 'contaminant' ? value.split(',') : [value]) {
        if (dictionary.codes.has(code.toUpperCase())) continue;
        notices.push(
          `The ${selector} value ${JSON.stringify(code)} is absent from EPA's current ${valueType} dictionary.`,
        );
        if (selector === 'contaminant' && ucmrSelectors.has(code))
          notices.push(
            `For ${JSON.stringify(code)} occurrence measurements, use sdwis_search_contaminants with dataset "ucmr5".`,
          );
      }
    } catch (error) {
      callerSignal.throwIfAborted();
      if (
        !(error instanceof McpError && dictionaryFailures.has(error.code)) &&
        !(error instanceof Error && error.name === 'TimeoutError')
      )
        throw error;
      notices.push(`Could not complete the EPA ${valueType} dictionary lookup for ${selector}.`);
    }
  }
  return notices;
}
