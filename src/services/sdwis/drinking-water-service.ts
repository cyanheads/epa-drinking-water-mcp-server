/**
 * @fileoverview Bounded membership-first source jobs and exact public-record continuations.
 * @module services/sdwis/drinking-water-service
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  conflict,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { resolveInlineLimit } from '@/domain/inline-limit.js';
import { type PublicRow, sortColumns, type Table } from '@/domain/sdwis-contracts.js';
import { normalizeSelectors, selectionFilters } from '@/domain/source-inputs.js';
import type { SourceOutput } from '@/domain/source-output.js';
import {
  matchesPredicates,
  type Predicate,
  pushdownPredicates,
  readPage,
  type SourcePage,
} from './sdwis-client.js';

/** A source partition submitted to the real canvas service; no synthetic handles are minted here. */
export interface SourcePartition {
  input: Record<string, unknown>;
  output: SourceOutput;
  rows: PublicRow[];
  table: Table;
}
/** Runtime-provided staging implementation; acquisition is complete before registration. */
export type StageProducer = (
  partition: SourcePartition,
  ctx: Context,
) => Promise<NonNullable<SourceOutput['dataset']>>;
let stageProducer: StageProducer | undefined;
/** Bind a real staging service at startup. */
export function setStageProducer(producer: StageProducer): void {
  stageProducer = producer;
}
/** Runtime dispatcher for the independently acquired UCMR archive. */
export interface UcmrInput {
  canvas_id?: string | undefined;
  contaminant?: string | undefined;
  county?: string | undefined;
  cursor?: string | undefined;
  dataset: 'ucmr5';
  date_from?: string | undefined;
  date_to?: string | undefined;
  detected_only?: boolean | undefined;
  limit?: number | undefined;
  pwsid?: string | undefined;
  stage?: boolean | undefined;
  stage_max_rows?: number | undefined;
  state?: string | undefined;
  state_basis?: string | undefined;
  zip?: string | undefined;
}
export type UcmrProducer = (input: UcmrInput, ctx: Context) => Promise<SourceOutput>;
let ucmrProducer: UcmrProducer | undefined;
/** Available analyte reference rows from an already loaded UCMR revision; never starts a detached load. */
export type UcmrReferenceProvider = () => readonly PublicRow[];
let ucmrReferenceProvider: UcmrReferenceProvider | undefined;
/** Bind the loaded archive catalog for the contaminants reference topic. */
export function setUcmrReferenceProvider(provider: UcmrReferenceProvider): void {
  ucmrReferenceProvider = provider;
}
/** Bind the archive-backed occurrence producer at startup. */
export function setUcmrProducer(producer: UcmrProducer): void {
  ucmrProducer = producer;
}
/** Dispatch only to an initialized real archive producer. */
export function produceUcmr(input: UcmrInput, ctx: Context): Promise<SourceOutput> {
  if (!ucmrProducer) throw serviceUnavailable('UCMR archive service has not been initialized.');
  const parsed = normalizeSelectors({ ...input });
  return ucmrProducer(
    {
      ...input,
      ...(typeof parsed.pwsid === 'string' ? { pwsid: parsed.pwsid } : {}),
      ...(typeof parsed.state === 'string'
        ? { state: parsed.state, state_basis: 'reported_legal_entity' }
        : {}),
      ...(typeof parsed.county === 'string' ? { county: parsed.county } : {}),
      ...(typeof parsed.date_from === 'string' ? { date_from: parsed.date_from } : {}),
      ...(typeof parsed.date_to === 'string' ? { date_to: parsed.date_to } : {}),
    },
    ctx,
  );
}

const caveat =
  'SDWIS is a quarterly publication of reported records; missing or resolved historical records do not establish current compliance or water safety.';
const key = randomBytes(32);
const JOB_TTL_MS = 900000;
const WORK_BUDGET_MS = 45000;
/** Reserve time to serialize a resumable checkpoint after an awaited membership read stops. */
const MEMBERSHIP_CHECKPOINT_RESERVE_MS = 5000;
const PAGE_SIZE = 1000;
/** PWSIDs per `pwsid in (...)` fact query. */
const BATCH_SIZE = 50;
interface Job {
  associationOffset: number;
  associations: Set<string>;
  associationsComplete: boolean;
  batch: number;
  deliveredRows: number;
  filters: Record<string, unknown>;
  geographicIds: Set<string>;
  id: string;
  ids: string[];
  inFlight: boolean;
  offset: number;
  partition: number;
  pending: PublicRow[];
  periodOffset: number;
  periods: Map<string, PublicRow>;
  periodsComplete: boolean;
  phase: 'inventory' | 'geography' | 'facts' | 'done';
  previousBoundary?: string;
  provenance?: SourcePage;
  referenceExtrasAdded: boolean;
  replay?: { step: number; fingerprint: string; result: SourceOutput };
  sourcePages: Map<string, { etag?: string; last_modified?: string; fingerprint: string }>;
  step: number;
  table: Table;
  tool: string;
  touched: number;
}
const jobs = new Map<string, Job>();
const tokenSchema = z.object({
  job: z.string(),
  step: z.number().int(),
});
function sign(job: Job): string {
  const data = Buffer.from(
    JSON.stringify({
      job: job.id,
      step: job.step,
    }),
  ).toString('base64url');
  return `${data}.${createHmac('sha256', key).update(data).digest('base64url')}`;
}
function token(value: string): z.infer<typeof tokenSchema> {
  const [data, signature, extra] = value.split('.');
  if (!data || !signature || extra)
    throw validationError('Invalid continuation token.', { reason: 'cursor_invalid' });
  const expected = createHmac('sha256', key).update(data).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual))
    throw validationError('Invalid continuation signature.', { reason: 'cursor_invalid' });
  try {
    return tokenSchema.parse(JSON.parse(Buffer.from(data, 'base64url').toString('utf8')));
  } catch {
    throw validationError('Invalid continuation payload.', { reason: 'cursor_invalid' });
  }
}
function sameFilters(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}
/** Case-insensitive substring match of `query` against any string field; no query matches all. */
function matchesQuery(row: PublicRow, query: unknown): boolean {
  if (!query) return true;
  const needle = String(query).toUpperCase();
  return Object.values(row).some(
    (value) => typeof value === 'string' && value.toUpperCase().includes(needle),
  );
}
function sweep(): void {
  for (const [id, job] of jobs) if (Date.now() - job.touched > JOB_TTL_MS) jobs.delete(id);
}
function capacity(): void {
  let bytes = 0;
  for (const job of jobs.values())
    bytes += new TextEncoder().encode(
      JSON.stringify({
        ...job,
        geographicIds: [...job.geographicIds],
        periods: [...job.periods],
        associations: [...job.associations],
      }),
    ).byteLength;
  if (bytes > 64 * 1024 * 1024)
    throw rateLimited(
      'Public retrieval cache is at capacity; narrow the selection or wait for expiry.',
      { reason: 'selection_capacity_exhausted' },
    );
}
function getJob(
  tool: string,
  table: Table,
  filters: Record<string, unknown>,
  cursor?: string,
): Job {
  sweep();
  if (cursor) {
    const parsed = token(cursor);
    const job = jobs.get(parsed.job);
    if (
      !job ||
      job.tool !== tool ||
      job.table !== table ||
      parsed.step !== job.step ||
      !sameFilters(job.filters, filters)
    )
      throw validationError('Continuation expired or selectors changed.', {
        reason: 'cursor_invalid',
      });
    job.touched = Date.now();
    return job;
  }
  if (jobs.size >= 100)
    throw rateLimited(
      'Too many live source selections; narrow the selection or wait fifteen minutes.',
      { reason: 'selection_capacity_exhausted' },
    );
  const membership =
    (!filters.pwsid || Boolean(filters.state) || Boolean(filters.county)) &&
    table !== 'water_system' &&
    table !== 'ref_code_value';
  const job: Job = {
    deliveredRows: 0,
    partition: 0,
    id: randomBytes(18).toString('base64url'),
    inFlight: false,
    tool,
    table,
    filters,
    step: 0,
    touched: Date.now(),
    phase: membership
      ? 'inventory'
      : filters.county && table === 'water_system'
        ? 'geography'
        : 'facts',
    offset: 1,
    ids: !membership && typeof filters.pwsid === 'string' ? [filters.pwsid] : [],
    sourcePages: new Map(),
    referenceExtrasAdded: false,
    geographicIds: new Set(),
    batch: 0,
    pending: [],
    periods: new Map(),
    periodsComplete: table !== 'lcr_sample_result',
    periodOffset: 1,
    associations: new Set(),
    associationsComplete: !(table === 'enforcement_action' && filters.violation_id),
    associationOffset: 1,
  };
  jobs.set(job.id, job);
  return job;
}
function predicate(
  column: string,
  value: unknown,
  operator: Predicate['operator'] = 'equals',
): Predicate[] {
  return value === undefined ? [] : [{ column, value: String(value), operator }];
}
function inventoryPredicates(filters: Record<string, unknown>): Predicate[] {
  return [
    ...predicate('pwsid', filters.pwsid),
    ...predicate('state_code', filters.state),
    ...predicate('pws_name', filters.name_contains, 'contains'),
    ...predicate('population_served_count', filters.population_min, 'greaterThanEqual'),
    ...predicate('primary_source_code', filters.source),
    ...predicate('pws_type_code', filters.system_type),
    ...predicate('primacy_agency_code', filters.primacy_agency),
    ...predicate('pwsid', filters.pwsid_prefix, 'beginsWith'),
    ...predicate(
      'is_school_or_daycare_ind',
      filters.school_or_daycare === undefined ? undefined : filters.school_or_daycare ? 'Y' : 'N',
    ),
    ...(filters.activity === 'active'
      ? predicate('pws_activity_code', 'A')
      : filters.activity === 'inactive'
        ? predicate('pws_activity_code', 'I')
        : []),
  ];
}
/** `pwsid in (...)` over the job's current membership batch. */
function batchPredicate(job: Job): Predicate {
  const batch = job.ids.slice(job.batch * BATCH_SIZE, (job.batch + 1) * BATCH_SIZE);
  return { column: 'pwsid', operator: 'in', value: batch.join(',') };
}
function factPredicates(job: Job): Predicate[] {
  const f = job.filters;
  const selected =
    job.table === 'water_system'
      ? inventoryPredicates(f)
      : job.table === 'ref_code_value'
        ? predicate('value_type', f.value_type)
        : [batchPredicate(job)];
  if (job.table === 'violation')
    selected.push(
      ...predicate(
        'contaminant_code',
        f.contaminant,
        f.contaminant === '1030,5000' ? 'in' : 'equals',
      ),
      ...predicate('violation_category_code', f.category),
      ...predicate(
        'is_health_based_ind',
        f.health_based === undefined ? undefined : f.health_based ? 'Y' : 'N',
      ),
      ...predicate('compliance_status_code', f.compliance_status),
    );
  if (job.table === 'lcr_sample_result')
    selected.push(...predicate('contaminant_code', f.contaminant));
  if (job.table === 'enforcement_action')
    selected.push(
      ...predicate('enforcement_action_type_code', f.action_type),
      ...predicate('originator_code', f.originator),
    );
  if (job.table === 'violation_enf_assoc')
    selected.push(...predicate('violation_id', f.violation_id));
  if (job.table === 'water_system_facility')
    selected.push(...predicate('facility_id', f.facility_id));
  return selected;
}
function overlap(
  row: PublicRow,
  filters: Record<string, unknown>,
  table: Table,
): boolean | undefined {
  if (!filters.date_from && !filters.date_to) return true;
  const [beginKey, endKey] =
    table === 'violation'
      ? (['compl_per_begin_date', 'compl_per_end_date'] as const)
      : table === 'lcr_sample_result'
        ? (['sampling_start_date', 'sampling_end_date'] as const)
        : (['enforcement_date', 'enforcement_date'] as const);
  const begin = row[beginKey];
  const end = row[endKey];
  const from = typeof filters.date_from === 'string' ? filters.date_from : undefined;
  const to = typeof filters.date_to === 'string' ? filters.date_to : undefined;
  if (typeof begin === 'string' && to && begin > to) return false;
  if (typeof end === 'string' && from && end < from) return false;
  // A known endpoint inside the requested interval proves overlap without inventing the other.
  if (typeof begin === 'string' && (!from || begin >= from)) return true;
  if (typeof end === 'string' && (!to || end <= to)) return true;
  if (typeof begin === 'string' && typeof end === 'string') return true;
  return undefined;
}
/** Tables whose sort key is unique, so a repeated page or boundary row means paging stalled. */
const uniqueKeyTables = new Set<Table>([
  'water_system',
  'water_system_facility',
  'violation',
  'enforcement_action',
  'lcr_sample',
  'ref_code_value',
]);
function retain(job: Job, table: Table, page: SourcePage): void {
  const sourceKey = `${table}:${job.batch}:${job.phase}`;
  const previous = job.sourcePages.get(sourceKey);
  if (
    previous &&
    ((previous.etag && page.etag && previous.etag !== page.etag) ||
      (previous.last_modified &&
        page.last_modified &&
        previous.last_modified !== page.last_modified))
  )
    throw conflict('EPA publication metadata changed during retrieval.', {
      reason: 'source_changed',
    });
  const fingerprint = createHmac('sha256', key).update(JSON.stringify(page.rows)).digest('hex');
  if (uniqueKeyTables.has(table) && page.rows.length && previous?.fingerprint === fingerprint)
    throw serviceUnavailable('EPA repeated a source page without progress.', {
      reason: 'upstream_paging_changed',
    });
  job.sourcePages.set(sourceKey, {
    fingerprint,
    ...(page.etag ? { etag: page.etag } : {}),
    ...(page.last_modified ? { last_modified: page.last_modified } : {}),
  });
  job.provenance = page;
}
/** One bounded entry per value type in labelColumns; install only fully acquired dictionaries. */
const codeLabels = new Map<string, { labels: Map<string, string | null>; expires: number }>();
/** Code columns decoded per table, each with its `ref_code_value` value type. */
const labelColumns: Partial<Record<Table, [column: string, valueType: string][]>> = {
  violation: [
    ['contaminant_code', 'CONTAMINANT_CODE'],
    ['violation_code', 'VIOLATION_CODE'],
    ['violation_category_code', 'VIOLATION_CATEGORY_CODE'],
  ],
  enforcement_action: [['enforcement_action_type_code', 'ENFORCEMENT_ACTION_TYPE_CODE']],
  water_system_facility: [['facility_type_code', 'FACILITY_TYPE_CODE']],
  treatment: [
    ['treatment_objective_code', 'TREATMENT_OBJECTIVE_CODE'],
    ['treatment_process_code', 'TREATMENT_PROCESS_CODE'],
  ],
  lcr_sample_result: [['contaminant_code', 'CONTAMINANT_CODE']],
};
/** Decode source codes through composite dictionary keys; absent descriptions remain null. */
async function enrichLabels(table: Table, rows: PublicRow[], signal: AbortSignal): Promise<number> {
  let pages = 0;
  for (const [column, valueType] of labelColumns[table] ?? []) {
    let cached = codeLabels.get(valueType);
    if (
      rows.some((row) => typeof row[column] === 'string') &&
      (!cached || cached.expires < Date.now())
    ) {
      const predicates: Predicate[] = [
        { column: 'value_type', operator: 'equals', value: valueType },
      ];
      const labels = new Map<string, string | null>();
      let offset = 1;
      let publication: SourcePage | undefined;
      while (true) {
        const page = await readPage('ref_code_value', predicates, offset, PAGE_SIZE, signal);
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
          labels.set(
            code,
            typeof row.value_description === 'string' ? row.value_description : null,
          );
        }
        offset += page.rows.length;
        if (page.rows.length < PAGE_SIZE) break;
      }
      cached = { labels, expires: Date.now() + 3600000 };
      codeLabels.set(valueType, cached);
    }
    for (const row of rows)
      row[column.replace(/_code$/, '_label')] =
        typeof row[column] === 'string' ? (cached?.labels.get(String(row[column])) ?? null) : null;
  }
  return pages;
}
/** Acquire source rows with scan checkpoints and a shared deadline, preserving pending rows exactly. */
async function advance(
  job: Job,
  target: number,
  signal: AbortSignal,
  membershipOnly = false,
): Promise<{ examined: number; unknown: number }> {
  let pages = 0;
  let examined = 0;
  let unknown = 0;
  const workDeadline = Date.now() + WORK_BUDGET_MS;
  const membershipDeadline = workDeadline - MEMBERSHIP_CHECKPOINT_RESERVE_MS;
  let readMembership = false;
  /** Read and retain one membership or companion page. */
  const read = async (table: Table, predicates: Predicate[], offset: number) => {
    const membership = job.phase === 'inventory' || job.phase === 'geography';
    const checkpoint = new AbortController();
    const timer = membership
      ? setTimeout(
          () =>
            checkpoint.abort(new DOMException('Membership checkpoint reached.', 'TimeoutError')),
          Math.max(0, membershipDeadline - Date.now()),
        )
      : undefined;
    try {
      const pageSignal = membership ? AbortSignal.any([signal, checkpoint.signal]) : signal;
      const page = await readPage(
        table,
        pushdownPredicates(predicates),
        offset,
        PAGE_SIZE,
        pageSignal,
      );
      // An upstream ignoring abort must not commit a page after the checkpoint.
      pageSignal.throwIfAborted();
      pages++;
      retain(job, table, page);
      return page;
    } catch (error) {
      signal.throwIfAborted();
      if (checkpoint.signal.aborted && error === checkpoint.signal.reason) return;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  while (pages < 17 && job.pending.length < target && job.phase !== 'done') {
    signal.throwIfAborted();
    if (
      (job.phase === 'inventory' || job.phase === 'geography') &&
      Date.now() >= membershipDeadline
    )
      break;
    if (membershipOnly && job.phase === 'facts') break;
    // Do not begin fact I/O with less than one normal request window after a slow membership walk.
    if (readMembership && job.phase === 'facts' && workDeadline - Date.now() < 15000) break;
    if (job.phase === 'inventory') {
      const predicates = inventoryPredicates(job.filters);
      const page = await read('water_system', predicates, job.offset);
      if (!page) break;
      readMembership = true;
      for (const row of page.rows)
        if (matchesPredicates(row, predicates)) job.ids.push(String(row.pwsid));
      job.ids = [...new Set(job.ids)];
      if (job.ids.length > 100000)
        throw rateLimited('Membership exceeds 100000 systems; narrow the geographic selection.', {
          reason: 'selection_capacity_exhausted',
        });
      job.offset += page.rows.length;
      if (page.rows.length < PAGE_SIZE) {
        job.phase = job.filters.county ? 'geography' : 'facts';
        job.offset = 1;
      }
      continue;
    }
    if (job.phase === 'geography') {
      const predicates = predicate('county_served', job.filters.county);
      const page = await read('geographic_area', predicates, job.offset);
      if (!page) break;
      readMembership = true;
      for (const row of page.rows)
        if (matchesPredicates(row, predicates)) job.geographicIds.add(String(row.pwsid));
      if (job.geographicIds.size > 100000)
        throw rateLimited('County membership exceeds the selection budget; narrow the selection.', {
          reason: 'selection_capacity_exhausted',
        });
      job.offset += page.rows.length;
      if (page.rows.length < PAGE_SIZE) {
        if (job.table !== 'water_system')
          job.ids = job.ids.filter((id) => job.geographicIds.has(id));
        job.phase = 'facts';
        job.offset = 1;
      }
      continue;
    }
    if (
      job.table !== 'water_system' &&
      job.table !== 'ref_code_value' &&
      job.batch * BATCH_SIZE >= job.ids.length
    ) {
      job.phase = 'done';
      break;
    }
    if (!job.periodsComplete) {
      const page = await read('lcr_sample', [batchPredicate(job)], job.periodOffset);
      if (!page) break;
      for (const row of page.rows) job.periods.set(`${row.pwsid}:${row.sample_id}`, row);
      job.periodOffset += page.rows.length;
      if (page.rows.length < PAGE_SIZE) job.periodsComplete = true;
      capacity();
      continue;
    }
    if (!job.associationsComplete) {
      const predicates = [
        ...predicate('pwsid', job.filters.pwsid),
        ...predicate('violation_id', job.filters.violation_id),
      ];
      const page = await read('violation_enf_assoc', predicates, job.associationOffset);
      if (!page) break;
      for (const row of page.rows)
        if (matchesPredicates(row, predicates))
          job.associations.add(`${row.pwsid}:${row.enforcement_id}`);
      job.associationOffset += page.rows.length;
      if (page.rows.length < PAGE_SIZE) job.associationsComplete = true;
      capacity();
      continue;
    }
    const predicates = factPredicates(job);
    const page = await readPage(
      job.table,
      pushdownPredicates(predicates),
      job.offset,
      PAGE_SIZE,
      signal,
    );
    pages++;
    // retain() fingerprints the rows after labels are attached; keep this order.
    pages += await enrichLabels(job.table, page.rows, signal);
    retain(job, job.table, page);
    if (
      uniqueKeyTables.has(job.table) &&
      page.rows.length &&
      job.previousBoundary ===
        JSON.stringify(sortColumns(job.table).map((column) => page.rows[0]?.[column]))
    )
      throw serviceUnavailable('EPA repeated a page boundary without progress.', {
        reason: 'upstream_paging_changed',
      });
    if (page.rows.length)
      job.previousBoundary = JSON.stringify(
        sortColumns(job.table).map((column) => page.rows.at(-1)?.[column]),
      );
    for (let row of page.rows) {
      if (!matchesPredicates(row, predicates)) continue;
      if (
        job.table === 'water_system' &&
        job.filters.county &&
        !job.geographicIds.has(String(row.pwsid))
      )
        continue;
      if (
        job.filters.population_max !== undefined &&
        (typeof row.population_served_count !== 'number' ||
          row.population_served_count > Number(job.filters.population_max))
      )
        continue;
      if (job.table === 'lcr_sample_result') {
        const period = job.periods.get(`${row.pwsid}:${row.sample_id}`);
        row = {
          ...row,
          sampling_start_date: period?.sampling_start_date ?? null,
          sampling_end_date: period?.sampling_end_date ?? null,
          period_joined: period !== undefined,
        };
      }
      if (
        job.table === 'enforcement_action' &&
        job.filters.violation_id &&
        !job.associations.has(`${row.pwsid}:${row.enforcement_id}`)
      )
        continue;
      if (!matchesQuery(row, job.filters.query)) continue;
      examined++;
      const overlaps = overlap(row, job.filters, job.table);
      if (overlaps === undefined) unknown++;
      if (!overlaps) continue;
      job.pending.push(row);
    }
    job.offset += page.rows.length;
    if (page.rows.length < PAGE_SIZE) {
      if (
        job.table === 'water_system' ||
        job.table === 'ref_code_value' ||
        (job.batch + 1) * BATCH_SIZE >= job.ids.length
      )
        job.phase = 'done';
      else {
        job.batch++;
        job.offset = 1;
        job.periods.clear();
        job.periodsComplete = job.table !== 'lcr_sample_result';
        job.periodOffset = 1;
        delete job.previousBoundary;
      }
    }
    capacity();
  }
  return { examined, unknown };
}
function outputPhase(job: Job): SourceOutput['phase'] {
  return job.phase === 'inventory' || job.phase === 'geography' ? 'membership' : 'source';
}
function provenance(job: Job): SourceOutput['provenance'] {
  return {
    source: 'EPA SDWIS DMAP',
    url: job.provenance?.url ?? 'https://www.epa.gov/enviro/envirofacts-data-service-api',
    retrieved_at: job.provenance?.retrieved_at ?? new Date().toISOString(),
    ...(job.provenance?.etag ? { etag: job.provenance.etag } : {}),
    ...(job.provenance?.last_modified ? { last_modified: job.provenance.last_modified } : {}),
    consistency: 'quarterly_non_atomic',
    caveats: [
      caveat,
      ...(job.filters.state
        ? [
            'State matches the reported legal entity; county membership intersected with legal-entity state is not a complete physical service-boundary map.',
          ]
        : []),
      ...(job.table === 'lcr_sample_result'
        ? [
            'PB90/CU90 are Lead and Copper Rule summaries, not individual household samples. Missing sample periods remain unknown.',
          ]
        : []),
    ],
  };
}
function envelope(job: Job, limit: number, notices: string[]): SourceOutput {
  return {
    effective_filters: job.filters,
    items: [],
    returned: 0,
    limit,
    has_more: job.phase !== 'done' || job.pending.length > 0,
    phase: outputPhase(job),
    source_complete: false,
    provenance: provenance(job),
    notices,
  };
}
/** Bounded normalized geographic selection for archive producers; facts are never queried here. */
export async function resolveMembership(
  input: {
    pwsid?: string | undefined;
    state?: string | undefined;
    county?: string | undefined;
    cursor?: string | undefined;
  },
  ctx: Context,
): Promise<{ pwsids: ReadonlySet<string>; source_complete: boolean; next_cursor?: string }> {
  const normalized = normalizeSelectors({ ...input });
  const job = getJob('sdwis_membership', 'violation', selectionFilters(normalized), input.cursor);
  if (job.inFlight)
    throw rateLimited('Membership selection already has an active call.', {
      reason: 'selection_capacity_exhausted',
    });
  job.inFlight = true;
  try {
    await advance(job, 1, AbortSignal.any([ctx.signal, AbortSignal.timeout(WORK_BUDGET_MS)]), true);
    job.step++;
    const complete = job.phase === 'facts' || job.phase === 'done';
    return {
      pwsids: new Set(complete ? job.ids : []),
      source_complete: complete,
      ...(complete ? {} : { next_cursor: sign(job) }),
    };
  } finally {
    job.inFlight = false;
  }
}
/** Produce a bounded inline selection, or a real staged source partition when requested. */
export async function produceSource(
  tool: string,
  table: Table,
  input: Record<string, unknown>,
  ctx: Context,
  bundledRows?: PublicRow[],
): Promise<SourceOutput> {
  const normalized = normalizeSelectors(input);
  const { limit, notices: limitNotices } = resolveInlineLimit(Number(input.limit ?? 10), ctx);
  if (normalized.canvas_id && !normalized.stage)
    throw validationError('canvas_id requires stage true.', { reason: 'invalid_selector' });
  if (normalized.stage && !stageProducer)
    throw configurationError(
      'DataCanvas staging is disabled; use inline records or an enabled npm/Docker runtime.',
      { reason: 'canvas_disabled' },
    );
  const cursor = typeof input.cursor === 'string' ? input.cursor : undefined;
  const requestFingerprint = JSON.stringify(
    Object.entries(normalized)
      .filter(([name]) => name !== 'cursor')
      .sort(),
  );
  if (cursor) {
    const parsed = token(cursor);
    const previous = jobs.get(parsed.job);
    if (
      previous &&
      Date.now() - previous.touched <= JOB_TTL_MS &&
      previous.tool === tool &&
      previous.table === table &&
      !previous.inFlight &&
      previous.replay?.step === parsed.step &&
      previous.replay.fingerprint === requestFingerprint
    ) {
      previous.touched = Date.now();
      return structuredClone(previous.replay.result);
    }
  }
  const job = getJob(tool, table, selectionFilters(normalized), cursor);
  if (job.inFlight)
    throw rateLimited(
      'This source selection already has an active call; wait for it before continuing.',
      { reason: 'selection_capacity_exhausted' },
    );
  job.inFlight = true;
  try {
    if (bundledRows && !cursor) {
      job.pending = bundledRows.filter((row) => matchesQuery(row, input.query));
      job.phase = 'done';
    }
    const stageMax = Math.min(25000, Number(input.stage_max_rows ?? 5000));
    const notices = [caveat, ...limitNotices];
    if (Number(input.stage_max_rows ?? 5000) > 25000)
      notices.push('Requested stage_max_rows was clamped to 25000.');
    if (input.activity === 'active')
      notices.push(
        'Discovery includes active systems by default; use activity all to include inactive records.',
      );
    const result = envelope(job, limit, notices);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(WORK_BUDGET_MS)]);
    const overlapCounts = await advance(job, normalized.stage ? stageMax : limit + 1, signal);
    if (overlapCounts.unknown)
      notices.push(
        `Date overlap is unknown for ${overlapCounts.unknown} of ${overlapCounts.examined} source rows examined during this call; those rows were excluded. Counts do not describe unexamined source rows.`,
      );
    if (
      table === 'ref_code_value' &&
      input.topic === 'contaminants' &&
      job.phase === 'done' &&
      !job.referenceExtrasAdded
    ) {
      const rows = ucmrReferenceProvider?.() ?? [];
      job.pending.push(...rows.filter((row) => matchesQuery(row, input.query)));
      job.referenceExtrasAdded = true;
    }
    const staged =
      normalized.stage && outputPhase(job) !== 'membership'
        ? job.pending.slice(0, stageMax)
        : undefined;
    const candidates = (staged ?? job.pending).slice(0, limit);
    if (candidates.length || outputPhase(job) !== 'membership')
      result.selection_partition = {
        selection_id: job.id,
        partition: job.partition,
        final_partition: null,
      };
    job.step++;
    result.items = candidates;
    result.returned = result.items.length;
    if (!staged) job.pending.splice(0, result.items.length);
    result.phase = outputPhase(job);
    result.has_more = job.phase !== 'done' || job.pending.length > (staged?.length ?? 0);
    if (result.selection_partition && !result.has_more)
      result.selection_partition.final_partition = job.partition;
    result.source_complete = !result.has_more && job.deliveredRows === 0;
    result.truncated =
      result.has_more || (staged !== undefined && staged.length > result.items.length);
    if (result.has_more) result.next_cursor = sign(job);
    else delete result.next_cursor;
    result.provenance = provenance(job);
    if (staged && stageProducer) {
      const partitionOutput = { ...result, items: staged, returned: staged.length };
      try {
        result.dataset = await stageProducer(
          { table, rows: staged, output: partitionOutput, input: normalized },
          { ...ctx, signal },
        );
      } catch (error) {
        job.step--;
        throw error;
      }
      job.pending.splice(0, staged.length);
      result.source_complete = result.source_complete && result.dataset.source_complete;
      result.phase = result.has_more ? 'source' : 'preview';
    }
    if (!result.returned && result.phase !== 'membership')
      notices.push(
        tool === 'sdwis_search_water_systems'
          ? 'No discovery matches. Broaden sdwis_search_water_systems selectors.'
          : 'No matching records. Inspect sdwis_get_system_profile and sdwis_list_reference with topic coverage; absence is not a current-compliance conclusion.',
      );
    if (result.has_more)
      notices.push(
        `Follow next_cursor with the same selectors; ${result.phase} work is incomplete.`,
      );
    if (!result.has_more && !result.source_complete)
      notices.push(
        'Retrieval is exhausted; earlier rows were delivered in previous outputs or staged partitions, so this output is not the entire selected source.',
      );
    job.replay = {
      step: job.step - 1,
      fingerprint: requestFingerprint,
      result: structuredClone(result),
    };
    job.deliveredRows += staged?.length ?? result.items.length;
    if (
      result.selection_partition &&
      (staged !== undefined || result.items.length || !result.has_more)
    )
      job.partition++;
    capacity();
    return result;
  } finally {
    job.inFlight = false;
  }
}
