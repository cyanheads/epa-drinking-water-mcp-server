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
import type { PublicRow, Table } from '@/domain/sdwis-contracts.js';
import { normalizeSelectors } from '@/domain/source-inputs.js';
import { type SourceOutput, wireBytes } from '@/domain/source-output.js';
import { type Predicate, readPage, type SourcePage } from './sdwis-client.js';

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
  record_cursor?: string | undefined;
  stage?: boolean | undefined;
  stage_max_rows?: number | undefined;
  state?: string | undefined;
  state_basis?: string | undefined;
  view?: 'records' | 'text' | undefined;
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
    },
    ctx,
  );
}

const caveat =
  'SDWIS is a quarterly publication of reported records; missing or resolved historical records do not establish current compliance or water safety.';
const key = randomBytes(32);
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
  text?: { row: PublicRow; offset: number };
  tool: string;
  touched: number;
}
const jobs = new Map<string, Job>();
const tokenSchema = z.object({
  job: z.string(),
  step: z.number().int(),
  kind: z.enum(['page', 'text']),
  offset: z.number().int().optional(),
});
function sign(job: Job, kind: 'page' | 'text' = 'page', offset?: number): string {
  const data = Buffer.from(
    JSON.stringify({
      job: job.id,
      step: job.step,
      kind,
      ...(offset === undefined ? {} : { offset }),
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
function cleanFilters(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  for (const name of ['cursor', 'record_cursor', 'view', 'limit', 'stage_max_rows', 'canvas_id'])
    delete result[name];
  return result;
}
function sameFilters(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}
function sweep(): void {
  for (const [id, job] of jobs) if (Date.now() - job.touched > 900000) jobs.delete(id);
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
    ...(filters.activity === 'active'
      ? predicate('pws_activity_code', 'A')
      : filters.activity === 'inactive'
        ? predicate('pws_activity_code', 'I')
        : []),
  ];
}
function factPredicates(job: Job): Predicate[] {
  const f = job.filters;
  const batch = job.ids.slice(job.batch * 50, (job.batch + 1) * 50);
  const selected =
    job.table === 'water_system'
      ? inventoryPredicates(f)
      : job.table === 'ref_code_value'
        ? predicate('value_type', f.value_type)
        : [{ column: 'pwsid', operator: 'in' as const, value: batch.join(',') }];
  if (job.table === 'violation')
    selected.push(
      ...predicate('contaminant_code', f.contaminant),
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
  return selected;
}
function identity(row: PublicRow): string {
  return JSON.stringify([
    row.pwsid,
    row.violation_id,
    row.enforcement_id,
    row.sample_id,
    row.sar_id,
    row.value_type,
    row.value_code,
    row.facility_id,
    row.treatment_id,
  ]);
}
function overlap(row: PublicRow, filters: Record<string, unknown>, table: Table): boolean {
  if (!filters.date_from && !filters.date_to) return true;
  const [beginKey, endKey] =
    table === 'violation'
      ? ['compl_per_begin_date', 'compl_per_end_date']
      : table === 'lcr_sample_result'
        ? ['sampling_start_date', 'sampling_end_date']
        : ['enforcement_date', 'enforcement_date'];
  const begin = row[beginKey ?? ''];
  const end = row[endKey ?? ''];
  return (
    typeof begin === 'string' &&
    typeof end === 'string' &&
    (!filters.date_from || end >= String(filters.date_from)) &&
    (!filters.date_to || begin <= String(filters.date_to))
  );
}
function hasUniqueSourceKey(table: string): boolean {
  return [
    'water_system',
    'violation',
    'enforcement_action',
    'lcr_sample',
    'ref_code_value',
  ].includes(table);
}
function retain(job: Job, page: SourcePage): void {
  const tablePath = new URL(page.url).pathname.split('/')[2] ?? '';
  const sourceKey = `${tablePath}:${job.batch}:${job.phase}`;
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
  if (
    hasUniqueSourceKey(tablePath.replace(/^sdwis\./, '')) &&
    page.rows.length &&
    previous?.fingerprint === fingerprint
  )
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
const codeLabels = new Map<string, { label: string | null; expires: number }>();
/** Decode source codes through composite dictionary keys; absent descriptions remain null. */
async function enrichLabels(table: Table, rows: PublicRow[], signal: AbortSignal): Promise<number> {
  const mappings: [string, string][] =
    table === 'violation'
      ? [
          ['contaminant_code', 'CONTAMINANT_CODE'],
          ['violation_code', 'VIOLATION_CODE'],
          ['violation_category_code', 'VIOLATION_CATEGORY_CODE'],
        ]
      : table === 'enforcement_action'
        ? [['enforcement_action_type_code', 'ENFORCEMENT_ACTION_TYPE_CODE']]
        : table === 'treatment'
          ? [
              ['treatment_objective_code', 'TREATMENT_OBJECTIVE_CODE'],
              ['treatment_process_code', 'TREATMENT_PROCESS_CODE'],
            ]
          : table === 'lcr_sample_result'
            ? [['contaminant_code', 'CONTAMINANT_CODE']]
            : [];
  let pages = 0;
  for (const [column, valueType] of mappings) {
    const codes = [
      ...new Set(rows.flatMap((row) => (typeof row[column] === 'string' ? [row[column]] : []))),
    ];
    const missing = codes.filter((code) => {
      const cached = codeLabels.get(`${valueType}:${code}`);
      return !cached || cached.expires < Date.now();
    });
    if (missing.length) {
      const predicates: Predicate[] = [
        { column: 'value_type', operator: 'equals', value: valueType },
        { column: 'value_code', operator: 'in', value: missing.join(',') },
      ];
      const page = await readPage('ref_code_value', predicates, 1, 1000, signal);
      pages++;
      const labels = new Map(
        page.rows.map((row) => [
          `${row.value_type}:${row.value_code}`,
          typeof row.value_description === 'string' ? row.value_description : null,
        ]),
      );
      for (const code of missing)
        codeLabels.set(`${valueType}:${code}`, {
          label: labels.get(`${valueType}:${code}`) ?? null,
          expires: Date.now() + 3600000,
        });
      while (codeLabels.size > 10000) {
        const oldest = codeLabels.keys().next().value;
        if (oldest) codeLabels.delete(oldest);
      }
    }
    for (const row of rows)
      row[column.replace(/_code$/, '_label')] =
        typeof row[column] === 'string'
          ? (codeLabels.get(`${valueType}:${row[column]}`)?.label ?? null)
          : null;
  }
  return pages;
}
/** Acquire up to the requested source rows under twenty DMAP pages, preserving pending rows exactly. */
async function advance(
  job: Job,
  target: number,
  signal: AbortSignal,
  membershipOnly = false,
): Promise<void> {
  let pages = 0;
  while (pages < 17 && job.pending.length < target && job.phase !== 'done') {
    signal.throwIfAborted();
    if (membershipOnly && job.phase === 'facts') break;
    if (job.phase === 'inventory') {
      const page = await readPage(
        'water_system',
        inventoryPredicates(job.filters),
        job.offset,
        1000,
        signal,
      );
      pages++;
      retain(job, page);
      for (const row of page.rows) job.ids.push(String(row.pwsid));
      job.ids = [...new Set(job.ids)];
      if (job.ids.length > 100000)
        throw rateLimited('Membership exceeds 100000 systems; narrow the geographic selection.', {
          reason: 'selection_capacity_exhausted',
        });
      job.offset += page.rows.length;
      if (page.rows.length < 1000) {
        job.phase = job.filters.county ? 'geography' : 'facts';
        job.offset = 1;
      }
      continue;
    }
    if (job.phase === 'geography') {
      const page = await readPage(
        'geographic_area',
        predicate('county_served', job.filters.county),
        job.offset,
        1000,
        signal,
      );
      pages++;
      retain(job, page);
      for (const row of page.rows) job.geographicIds.add(String(row.pwsid));
      if (job.geographicIds.size > 100000)
        throw rateLimited('County membership exceeds the selection budget; narrow the selection.', {
          reason: 'selection_capacity_exhausted',
        });
      job.offset += page.rows.length;
      if (page.rows.length < 1000) {
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
      job.batch * 50 >= job.ids.length
    ) {
      job.phase = 'done';
      break;
    }
    const batch = job.ids.slice(job.batch * 50, (job.batch + 1) * 50);
    if (!job.periodsComplete) {
      const page = await readPage(
        'lcr_sample',
        [{ column: 'pwsid', operator: 'in', value: batch.join(',') }],
        job.periodOffset,
        1000,
        signal,
      );
      pages++;
      retain(job, page);
      for (const row of page.rows) job.periods.set(`${row.pwsid}:${row.sample_id}`, row);
      job.periodOffset += page.rows.length;
      if (page.rows.length < 1000) job.periodsComplete = true;
      capacity();
      continue;
    }
    if (!job.associationsComplete) {
      const page = await readPage(
        'violation_enf_assoc',
        [
          ...predicate('pwsid', job.filters.pwsid),
          ...predicate('violation_id', job.filters.violation_id),
        ],
        job.associationOffset,
        1000,
        signal,
      );
      pages++;
      retain(job, page);
      for (const row of page.rows) job.associations.add(`${row.pwsid}:${row.enforcement_id}`);
      job.associationOffset += page.rows.length;
      if (page.rows.length < 1000) job.associationsComplete = true;
      capacity();
      continue;
    }
    const page = await readPage(job.table, factPredicates(job), job.offset, 1000, signal);
    pages++;
    pages += await enrichLabels(job.table, page.rows, signal);
    retain(job, page);
    if (
      hasUniqueSourceKey(job.table) &&
      page.rows.length &&
      job.previousBoundary === JSON.stringify(page.rows[0])
    )
      throw serviceUnavailable('EPA repeated a page boundary without progress.', {
        reason: 'upstream_paging_changed',
      });
    if (page.rows.length) job.previousBoundary = JSON.stringify(page.rows.at(-1));
    for (let row of page.rows) {
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
      if (
        job.filters.query &&
        !Object.values(row).some(
          (value) =>
            typeof value === 'string' &&
            value.toUpperCase().includes(String(job.filters.query).toUpperCase()),
        )
      )
        continue;
      if (!overlap(row, job.filters, job.table)) continue;
      job.pending.push(row);
    }
    job.offset += page.rows.length;
    if (page.rows.length < 1000) {
      if (
        job.table === 'water_system' ||
        job.table === 'ref_code_value' ||
        (job.batch + 1) * 50 >= job.ids.length
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
}
function envelope(job: Job, limit: number, notices: string[]): SourceOutput {
  return {
    effective_filters: job.filters,
    items: [],
    returned: 0,
    limit,
    has_more: job.phase !== 'done' || job.pending.length > 0,
    phase: job.phase === 'inventory' || job.phase === 'geography' ? 'membership' : 'source',
    source_complete: false,
    provenance: {
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
    },
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
  const job = getJob('sdwis_membership', 'violation', cleanFilters(normalized), input.cursor);
  if (job.inFlight)
    throw rateLimited('Membership selection already has an active call.', {
      reason: 'selection_capacity_exhausted',
    });
  job.inFlight = true;
  try {
    await advance(job, 1, AbortSignal.any([ctx.signal, AbortSignal.timeout(45000)]), true);
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
  if (normalized.canvas_id && !normalized.stage)
    throw validationError('canvas_id requires stage true.', { reason: 'invalid_selector' });
  if (normalized.stage && !stageProducer)
    throw configurationError(
      'DataCanvas staging is disabled; use inline records or an enabled npm/Docker runtime.',
      { reason: 'canvas_disabled' },
    );
  const cursor =
    typeof input.record_cursor === 'string'
      ? input.record_cursor
      : typeof input.cursor === 'string'
        ? input.cursor
        : undefined;
  const requestFingerprint = JSON.stringify(
    Object.entries(normalized)
      .filter(([name]) => name !== 'cursor')
      .sort(),
  );
  if (cursor && input.view !== 'text') {
    const parsed = token(cursor);
    const previous = jobs.get(parsed.job);
    if (
      previous &&
      Date.now() - previous.touched <= 900000 &&
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
  const job = getJob(tool, table, cleanFilters(normalized), cursor);
  if (job.inFlight)
    throw rateLimited(
      'This source selection already has an active call; wait for it before continuing.',
      { reason: 'selection_capacity_exhausted' },
    );
  job.inFlight = true;
  try {
    if (bundledRows && !cursor) {
      job.pending = bundledRows.filter(
        (row) =>
          !input.query ||
          Object.values(row).some(
            (value) =>
              typeof value === 'string' &&
              value.toUpperCase().includes(String(input.query).toUpperCase()),
          ),
      );
      job.phase = 'done';
    }
    const limit = Math.min(100, Number(input.limit ?? 10));
    const stageMax = Math.min(25000, Number(input.stage_max_rows ?? 5000));
    const notices = [caveat];
    if (Number(input.limit ?? 10) > 100)
      notices.push('Requested limit was clamped to the effective maximum 100.');
    if (Number(input.stage_max_rows ?? 5000) > 25000)
      notices.push('Requested stage_max_rows was clamped to 25000.');
    if (input.activity === 'active')
      notices.push(
        'Discovery includes active systems by default; use activity all to include inactive records.',
      );
    const result = envelope(job, limit, notices);
    if (input.view === 'text') {
      if (!cursor || !job.text)
        throw validationError(
          'Text view requires the record_cursor returned for this oversized record.',
          { reason: 'cursor_invalid' },
        );
      const pointer = token(cursor);
      const points = Array.from(JSON.stringify(job.text.row));
      const offset = pointer.offset ?? 0;
      const chunk: string[] = [];
      result.record_identity = identity(job.text.row);
      result.encoding = 'json';
      result.offset = offset;
      for (let i = offset; i < points.length; i++) {
        chunk.push(points[i] ?? '');
        result.text = chunk.join('');
        result.has_more = i + 1 < points.length;
        result.next_cursor = sign(job, 'text', i + 1);
        if (wireBytes(result) >= 23000) {
          chunk.pop();
          break;
        }
      }
      result.text = chunk.join('');
      result.has_more = offset + chunk.length < points.length;
      if (result.has_more) result.next_cursor = sign(job, 'text', offset + chunk.length);
      else {
        if (job.pending[0] === job.text.row) job.pending.shift();
        job.deliveredRows++;
        job.step++;
        result.has_more = job.phase !== 'done' || job.pending.length > 0;
        result.phase = 'source';
        if (result.has_more) result.next_cursor = sign(job);
        else delete result.next_cursor;
        notices.push(
          'Record text complete. Any next_cursor now continues this source tool with view records and the original selectors, omitting record_cursor.',
        );
      }
      result.source_complete = false;
      return result;
    }
    if (input.record_cursor)
      throw validationError('record_cursor is only valid with view text.', {
        reason: 'invalid_selector',
      });
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(45000)]);
    await advance(job, normalized.stage ? stageMax : limit + 1, signal);
    if (
      table === 'ref_code_value' &&
      input.topic === 'contaminants' &&
      job.phase === 'done' &&
      !job.referenceExtrasAdded
    ) {
      const rows = ucmrReferenceProvider?.() ?? [];
      job.pending.push(
        ...rows.filter(
          (row) =>
            !input.query ||
            Object.values(row).some(
              (value) =>
                typeof value === 'string' &&
                value.toUpperCase().includes(String(input.query).toUpperCase()),
            ),
        ),
      );
      job.referenceExtrasAdded = true;
    }
    let staged: PublicRow[] | undefined;
    if (normalized.stage) staged = job.pending.slice(0, stageMax);
    const candidates = staged ?? job.pending;
    job.step++;
    for (const row of candidates.slice(0, limit)) {
      result.items.push(row);
      result.returned = result.items.length;
      result.has_more = true;
      result.next_cursor = sign(job);
      if (wireBytes(result) >= (normalized.stage ? 20000 : 23000)) {
        result.items.pop();
        result.returned = result.items.length;
        if (!result.items.length) {
          job.text = { row, offset: 0 };
          throw validationError('A complete source record exceeds the inline wire budget.', {
            reason: 'item_too_large',
            record_cursor: sign(job, 'text', 0),
            source_cursor: sign(job),
            follow_up: { tool, view: 'text', record_cursor: sign(job, 'text', 0) },
          });
        }
        break;
      }
    }
    if (!staged) job.pending.splice(0, result.items.length);
    result.phase = job.phase === 'inventory' || job.phase === 'geography' ? 'membership' : 'source';
    result.has_more = job.phase !== 'done' || job.pending.length > (staged?.length ?? 0);
    result.source_complete = !result.has_more && job.deliveredRows === 0;
    result.truncated =
      result.has_more || (staged !== undefined && staged.length > result.items.length);
    if (result.has_more) result.next_cursor = sign(job);
    else delete result.next_cursor;
    result.provenance = envelope(job, limit, notices).provenance;
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
    if (wireBytes(result) >= 24000)
      throw serviceUnavailable(
        'Source envelope exceeds the response budget; narrow the selection.',
      );
    job.replay = {
      step: job.step - 1,
      fingerprint: requestFingerprint,
      result: structuredClone(result),
    };
    job.deliveredRows += staged?.length ?? result.items.length;
    capacity();
    return result;
  } finally {
    job.inFlight = false;
  }
}
