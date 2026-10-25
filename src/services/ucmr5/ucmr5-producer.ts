/** @fileoverview Revision-bound UCMR occurrence pagination and atomic companion staging. */
import { randomBytes } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { conflict, rateLimited, validationError } from '@cyanheads/mcp-ts-core/errors';
import { type SourceOutput, wireBytes } from '@/domain/source-output.js';
import {
  additionalColumns,
  occurrenceColumns,
  type Ucmr5Occurrence,
  zipColumns,
} from '@/domain/ucmr5-schemas.js';
import { getCanvasService } from '@/services/dataframe/canvas-service.js';
import { resolveMembership, type UcmrInput } from '@/services/sdwis/drinking-water-service.js';
import type { Ucmr5Selection } from './ucmr5-index.js';
import type { Ucmr5Service } from './ucmr5-service.js';

interface Job {
  busy: boolean;
  deliveredRows: number;
  exhausted: boolean;
  filters: string;
  ids: ReadonlySet<string>;
  membershipCursor?: string;
  membershipDone: boolean;
  offset: number;
  pending: Ucmr5Occurrence[];
  revision: string;
  step: number;
  touched: number;
}
interface Pointer {
  job: Job;
  rowOffset?: number;
  step: number;
}
const caveat =
  'UCMR 5 is limited monitoring participation, not a census of water systems or a compliance verdict. Censored values remain unknown below their reporting limits; service ZIP is membership, not sample location.';
const schema = (names: readonly string[]): ColumnSchema[] =>
  [...names, ...(names === occurrenceColumns ? ['censored'] : [])].map((name) => ({
    name,
    nullable: true,
    type:
      name === 'mrl' || name === 'analytical_result_value'
        ? 'DOUBLE'
        : name === 'censored'
          ? 'BOOLEAN'
          : name === 'collection_date'
            ? 'DATE'
            : 'VARCHAR',
  }));

/** Bind the archive service without eagerly downloading the national archive. */
export function createUcmrProducer(
  service: Ucmr5Service,
  loadedCatalog?: (names: string[], url: string) => void,
) {
  const jobs = new Set<Job>();
  const pointers = new Map<string, Pointer>();
  const mint = (job: Job, rowOffset?: number, advance = false) => {
    if (pointers.size >= 4096)
      throw rateLimited('UCMR continuation capacity is full; wait fifteen minutes.', {
        reason: 'selection_capacity_exhausted',
      });
    const key = randomBytes(24).toString('base64url');
    pointers.set(key, {
      job,
      step: job.step + (advance ? 1 : 0),
      ...(rowOffset === undefined ? {} : { rowOffset }),
    });
    return key;
  };
  return async (input: UcmrInput, ctx: Context): Promise<SourceOutput> => {
    if (input.stage) getCanvasService();
    if (input.canvas_id && !input.stage)
      throw validationError('canvas_id requires stage true.', { reason: 'invalid_selector' });
    const effective = { ...input };
    delete effective.cursor;
    delete effective.record_cursor;
    delete effective.limit;
    delete effective.view;
    delete effective.canvas_id;
    delete effective.stage_max_rows;
    const filters = JSON.stringify(Object.entries(effective).sort());
    for (const job of jobs) if (!job.busy && Date.now() - job.touched >= 900000) jobs.delete(job);
    for (const [key, pointer] of pointers) if (!jobs.has(pointer.job)) pointers.delete(key);
    const supplied = input.record_cursor ?? input.cursor;
    const pointer = supplied ? pointers.get(supplied) : undefined;
    if (
      supplied &&
      (!pointer || pointer.job.filters !== filters || pointer.step !== pointer.job.step)
    )
      throw validationError('UCMR continuation expired or selectors changed.', {
        reason: 'cursor_invalid',
      });
    if (
      (input.view === 'text' && (!pointer || pointer.rowOffset === undefined)) ||
      (input.view !== 'text' && input.record_cursor)
    )
      throw validationError('Text view requires the returned record_cursor.', {
        reason: 'cursor_invalid',
      });
    let job = pointer?.job;
    if (job?.busy)
      throw rateLimited('This UCMR selection already has an active call.', {
        reason: 'selection_capacity_exhausted',
      });
    if (!job) {
      if (jobs.size >= 100)
        throw rateLimited('Too many UCMR selections; narrow scope or wait fifteen minutes.', {
          reason: 'selection_capacity_exhausted',
        });
      job = {
        deliveredRows: 0,
        filters,
        revision: '',
        step: 0,
        offset: 0,
        pending: [],
        exhausted: false,
        busy: false,
        touched: Date.now(),
        membershipDone: !input.state && !input.county,
        ids: new Set(input.pwsid ? [input.pwsid] : []),
      };
      jobs.add(job);
    }
    const current = job;
    current.busy = true;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(180000)]);
    try {
      const lease = await service.acquire(signal);
      try {
        loadedCatalog?.(lease.contaminants(), lease.revision.archive_url);
        if (current.revision && current.revision !== lease.revision.archive_sha256)
          throw conflict('UCMR publication changed during continuation.', {
            reason: 'source_changed',
          });
        current.revision = lease.revision.archive_sha256;
        const limit = Math.min(input.limit ?? 10, 100);
        const stageMax = Math.min(input.stage_max_rows ?? 5000, 25000);
        const result: SourceOutput = {
          effective_filters: effective,
          items: [],
          returned: 0,
          limit,
          has_more: true,
          phase: 'source',
          source_complete: false,
          provenance: {
            source: 'EPA UCMR 5',
            url: lease.revision.archive_url,
            retrieved_at: lease.revision.retrieved_at,
            published_release: lease.revision.published_release,
            ...(lease.revision.etag ? { etag: lease.revision.etag } : {}),
            ...(lease.revision.last_modified
              ? { last_modified: lease.revision.last_modified }
              : {}),
            consistency: `archive_sha256:${lease.revision.archive_sha256}`,
            caveats: [caveat],
          },
          notices: [
            caveat,
            ...(input.limit && input.limit > 100 ? ['Requested limit was clamped to 100.'] : []),
            ...(input.stage_max_rows && input.stage_max_rows > 25000
              ? ['Requested stage_max_rows was clamped to 25000.']
              : []),
          ],
        };
        if (input.view === 'text') {
          const row = current.pending[0];
          if (!row || pointer?.rowOffset === undefined)
            throw validationError('Oversized UCMR record expired.', { reason: 'cursor_invalid' });
          const points = Array.from(JSON.stringify(row));
          const start = pointer.rowOffset;
          let end = start;
          result.encoding = 'json';
          result.offset = start;
          result.record_identity = `${row.pwsid}:${row.sample_id}:${row.contaminant}`;
          result.next_cursor = 'x'.repeat(32);
          while (end < points.length) {
            result.text = points.slice(start, end + 1).join('');
            if (wireBytes(result) >= 23000) break;
            end++;
          }
          result.text = points.slice(start, end).join('');
          if (end === start && end < points.length)
            throw validationError('UCMR metadata exceeds inline capacity; narrow selection.', {
              reason: 'item_too_large',
            });
          if (end < points.length) {
            result.next_cursor = mint(current, end, true);
            result.notices.push('Continue text with next_cursor as record_cursor and view text.');
          } else {
            current.pending.shift();
            current.deliveredRows++;
            result.has_more = current.pending.length > 0 || !current.exhausted;
            if (result.has_more) result.next_cursor = mint(current, undefined, true);
            else delete result.next_cursor;
            result.notices.push(
              'Record text is complete; any next_cursor continues records with the original selectors and without record_cursor.',
            );
          }
          current.step++;
          return result;
        }
        const workSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
        if (!current.membershipDone) {
          const membership = await resolveMembership(
            {
              pwsid: input.pwsid,
              state: input.state,
              county: input.county,
              cursor: current.membershipCursor,
            },
            { ...ctx, signal: workSignal },
          );
          current.membershipDone = membership.source_complete;
          current.ids = membership.pwsids;
          if (membership.next_cursor) current.membershipCursor = membership.next_cursor;
        }
        if (!current.membershipDone) {
          result.phase = 'membership';
          result.next_cursor = mint(current, undefined, true);
          result.notices.push(
            'Follow next_cursor with the same selectors to finish reported legal-entity membership before occurrence retrieval.',
          );
          current.step++;
          return result;
        }
        let pwsids: ReadonlySet<string> | undefined =
          input.state || input.county || input.pwsid ? current.ids : undefined;
        if (input.zip) {
          const zip = lease.zipPwsids(input.zip);
          pwsids = pwsids ? new Set([...pwsids].filter((id) => zip.has(id))) : zip;
        }
        const selection: Ucmr5Selection = {
          ...(pwsids ? { pwsids } : {}),
          ...(input.contaminant ? { contaminant: input.contaminant } : {}),
          ...(input.date_from ? { dateFrom: input.date_from } : {}),
          ...(input.date_to ? { dateTo: input.date_to } : {}),
          ...(input.detected_only === undefined ? {} : { detectedOnly: input.detected_only }),
        };
        const target = input.stage ? stageMax : limit + 1;
        if (!current.exhausted && current.pending.length < target) {
          const page = await lease.search(
            selection,
            current.offset,
            target - current.pending.length,
            workSignal,
          );
          const candidate = [...current.pending, ...page.items];
          let bytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
          for (const other of jobs)
            if (other !== current)
              bytes += new TextEncoder().encode(JSON.stringify(other.pending)).byteLength;
          if (bytes > 64 * 1024 * 1024)
            throw rateLimited('UCMR selection cache is full; narrow scope or wait for expiry.', {
              reason: 'selection_capacity_exhausted',
            });
          current.pending = candidate;
          current.offset = page.nextOffset;
          current.exhausted = page.exhausted;
        }
        const staged = input.stage ? current.pending.slice(0, stageMax) : undefined;
        const candidates = staged ?? current.pending;
        result.next_cursor = 'x'.repeat(32);
        for (const row of candidates.slice(0, limit)) {
          result.items.push(row);
          result.returned = result.items.length;
          if (wireBytes(result) >= (staged ? 19000 : 23000)) {
            result.items.pop();
            break;
          }
        }
        result.returned = result.items.length;
        if (!result.returned && candidates.length)
          throw validationError('A complete UCMR record exceeds inline capacity.', {
            reason: 'item_too_large',
            record_cursor: mint(current, 0),
            follow_up: { tool: 'sdwis_search_contaminants', view: 'text', dataset: 'ucmr5' },
          });
        const consumed = staged?.length ?? result.items.length;
        result.has_more = !current.exhausted || current.pending.length > consumed;
        result.source_complete = !result.has_more && current.deliveredRows === 0;
        result.truncated = result.has_more || Boolean(staged && staged.length > result.returned);
        if (result.has_more) result.next_cursor = mint(current, undefined, true);
        else delete result.next_cursor;
        if (staged) {
          const companions = await lease.companions(staged, workSignal);
          result.dataset = await getCanvasService().stageRelations(
            { ...input },
            result,
            [
              { relation: 'ucmr5_results', rows: staged, schema: schema(occurrenceColumns) },
              {
                relation: 'ucmr5_additional',
                rows: companions.additional,
                schema: schema(additionalColumns),
              },
              {
                relation: 'ucmr5_zip_membership',
                rows: companions.zipMemberships,
                schema: schema(zipColumns),
              },
            ],
            { ...ctx, signal: workSignal },
          );
          result.phase = result.has_more ? 'source' : 'preview';
        }
        if (!result.returned)
          result.notices.push(
            'No UCMR occurrence matches; use sdwis_list_reference with topic coverage because monitoring participation is limited.',
          );
        if (!result.has_more && !result.source_complete)
          result.notices.push(
            'Retrieval is exhausted; earlier rows were delivered in previous outputs or staged partitions, so this output is not the entire selected source.',
          );
        if (wireBytes(result) >= 24000)
          throw validationError('UCMR metadata exceeds inline capacity; narrow selection.', {
            reason: 'item_too_large',
          });
        current.pending.splice(0, consumed);
        current.deliveredRows += consumed;
        current.step++;
        current.touched = Date.now();
        return result;
      } finally {
        lease.release();
      }
    } finally {
      current.busy = false;
    }
  };
}
