/**
 * @fileoverview Archive-to-tool UCMR selection, continuation and companion staging contracts.
 * @module tests/tools/ucmr5-producer.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SourceOutput, wireBytes } from '../../src/domain/source-output.js';
import { searchContaminantsTool as tool } from '../../src/mcp-server/tools/definitions/search-contaminants.tool.js';
import {
  getCanvasService,
  initCanvasService,
} from '../../src/services/dataframe/canvas-service.js';
import { setUcmrProducer } from '../../src/services/sdwis/drinking-water-service.js';
import { createUcmrProducer } from '../../src/services/ucmr5/ucmr5-producer.js';
import { Ucmr5Service } from '../../src/services/ucmr5/ucmr5-service.js';
import { fixture } from '../services/dataframe/canvas-fixtures.js';
import { expectParity, network, paced } from '../services/sdwis/sdwis-fixtures.js';
import { archive, occurrence, relations } from '../services/ucmr5/ucmr5-fixtures.js';

const services: Ucmr5Service[] = [];
let canvas: ReturnType<typeof fixture> | undefined;
const scope = { dataset: 'ucmr5', pwsid: 'WA1234567' } as const;
function install(rows: string[][], fetcher?: typeof fetch) {
  const bytes = archive(relations(rows));
  const service = new Ucmr5Service({ fetch: fetcher ?? (async () => new Response(bytes)) });
  services.push(service);
  setUcmrProducer(createUcmrProducer(service));
  return service;
}
function data(result: Awaited<ReturnType<typeof runToolContract>>): SourceOutput {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expectParity(result);
  const parsed = tool.output.parse(result.structuredContent);
  expect(wireBytes(parsed)).toBeLessThan(24000);
  return parsed;
}
function error(result: Awaited<ReturnType<typeof runToolContract>>, reason: string) {
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { data: { reason } } },
  });
  expect(JSON.stringify(result.content)).toContain(reason);
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  if (canvas) await canvas.canvas.shutdown(canvas.ctx);
  canvas = undefined;
  initCanvasService(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('real UCMR producer through tool contract', () => {
  it('marks an entire first staged selection complete despite a smaller preview', async () => {
    canvas = fixture();
    initCanvasService(canvas.canvas);
    install([occurrence(), occurrence({ SampleID: 'second' })]);
    expect(
      data(await runToolContract(tool, { ...scope, stage: true, limit: 1, stage_max_rows: 2 })),
    ).toMatchObject({
      returned: 1,
      has_more: false,
      source_complete: true,
      truncated: true,
      dataset: { row_count: 2, source_complete: true },
    });
  });
  it('distinguishes the publisher release label from HTTP modification metadata', async () => {
    install(
      [occurrence()],
      async () =>
        new Response(archive(relations([occurrence()])), {
          headers: { 'last-modified': 'Thu, 01 Oct 2026 00:00:00 GMT' },
        }),
    );
    expect(data(await runToolContract(tool, scope)).provenance).toMatchObject({
      published_release: 'UCMR 5 final release, August 2026',
      last_modified: 'Thu, 01 Oct 2026 00:00:00 GMT',
    });
  });
  it('preserves censored null, units and detected numeric zero while filtering dates and PFAS', async () => {
    install([
      occurrence(),
      occurrence({ SampleID: 'zero', AnalyticalResultsSign: '=', AnalyticalResultValue: '0' }),
      occurrence({
        SampleID: 'lithium',
        Contaminant: 'Lithium',
        AnalyticalResultsSign: '=',
        AnalyticalResultValue: '2',
      }),
      occurrence({
        SampleID: 'later',
        CollectionDate: '1/1/2025',
        AnalyticalResultsSign: '=',
        AnalyticalResultValue: '1',
      }),
    ]);
    const all = data(await runToolContract(tool, scope));
    expect(all.items).toHaveLength(4);
    expect(all.items[0]).toMatchObject({
      analytical_result_value: null,
      censored: true,
      units: 'µg/L',
      collection_date: '2024-02-29',
    });
    const filtered = data(
      await runToolContract(tool, {
        ...scope,
        contaminant: 'PFAS',
        detected_only: true,
        date_to: '2024-02-29',
      }),
    );
    expect(filtered).toMatchObject({
      items: [{ sample_id: 'zero', analytical_result_value: 0, censored: false }],
      source_complete: true,
      has_more: false,
    });
  });

  it('returns specific no-match guidance and a recoverable unknown-analyte error', async () => {
    install([occurrence()]);
    const empty = data(await runToolContract(tool, { ...scope, date_from: '2025-01-01' }));
    expect(empty).toMatchObject({ items: [], returned: 0, source_complete: true, has_more: false });
    expect(empty.notices.join(' ')).toContain('topic coverage');
    const unknown = await runToolContract(tool, { ...scope, contaminant: 'unobtainium' });
    error(unknown, 'unknown_contaminant');
    expect(JSON.stringify(unknown.content)).toContain('sdwis_list_reference');
  });

  it('accepts an empty publication without inventing occurrences', async () => {
    install([]);
    expect(data(await runToolContract(tool, scope))).toMatchObject({
      items: [],
      source_complete: true,
    });
  });

  it('walks exact source rows across pages and rejects consumed, changed and expired tokens', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    install(Array.from({ length: 5 }, (_, i) => occurrence({ SampleID: `S${i}` })));
    const first = data(await runToolContract(tool, { ...scope, limit: 2 }));
    const cursor = first.next_cursor;
    error(await runToolContract(tool, { ...scope, contaminant: 'PFOA', cursor }), 'cursor_invalid');
    error(await runToolContract(tool, { ...scope, cursor: `${cursor}x` }), 'cursor_invalid');
    const second = data(await runToolContract(tool, { ...scope, limit: 1, cursor }));
    error(await runToolContract(tool, { ...scope, cursor }), 'cursor_invalid');
    const last = data(
      await runToolContract(tool, { ...scope, limit: 100, cursor: second.next_cursor }),
    );
    expect([...first.items, ...second.items, ...last.items].map((row) => row.sample_id)).toEqual([
      'S0',
      'S1',
      'S2',
      'S3',
      'S4',
    ]);
    expect(last).toMatchObject({ has_more: false, source_complete: false });
    const fresh = data(await runToolContract(tool, { ...scope, limit: 1 }));
    vi.setSystemTime(Date.now() + 900001);
    error(await runToolContract(tool, { ...scope, cursor: fresh.next_cursor }), 'cursor_invalid');
  });

  it('retains the whole byte-crossing row for the next continuation', async () => {
    install(
      Array.from({ length: 4 }, (_, i) =>
        occurrence({ SampleID: `S${i}`, PWSName: `${i}:${'µ'.repeat(1600)}` }),
      ),
    );
    let page = data(await runToolContract(tool, { ...scope, limit: 100 }));
    expect(page.returned).toBeLessThan(4);
    const ids: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(...page.items.map((row) => row.sample_id));
      if (!page.has_more) break;
      page = data(await runToolContract(tool, { ...scope, limit: 100, cursor: page.next_cursor }));
    }
    expect(ids).toEqual(['S0', 'S1', 'S2', 'S3']);
    expect(page.source_complete).toBe(false);
  });

  it('reassembles an oversized record losslessly then resumes ordinary rows', async () => {
    const name = 'µ"\\'.repeat(2500);
    install([occurrence({ PWSName: name }), occurrence({ SampleID: 'next' })]);
    const oversized = await runToolContract(tool, { ...scope, limit: 2 });
    error(oversized, 'item_too_large');
    const details = oversized.structuredContent as { error: { data: { record_cursor: string } } };
    let cursor = details.error.data.record_cursor;
    let text = '';
    let recordNext: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = data(
        await runToolContract(tool, { ...scope, view: 'text', record_cursor: cursor }),
      );
      expect(page.offset).toBe(Array.from(text).length);
      text += page.text;
      if (page.notices.some((notice) => notice.includes('Record text is complete'))) {
        recordNext = page.next_cursor;
        break;
      }
      cursor = String(page.next_cursor);
    }
    expect(JSON.parse(text)).toMatchObject({
      pws_name: name,
      sample_id: 'S1',
      analytical_result_value: null,
    });
    expect(recordNext).toBeDefined();
    expect(data(await runToolContract(tool, { ...scope, cursor: recordNext }))).toMatchObject({
      items: [{ sample_id: 'next' }],
      source_complete: false,
    });
  });

  it('intersects reported state/county inventory with ZIP memberships rather than source-state labels', async () => {
    const service = install([
      occurrence({ State: 'OR' }),
      occurrence({ PWSID: 'OR1234567', SampleID: 'other', State: 'WA' }),
    ]);
    (await service.acquire(new AbortController().signal)).release();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const http = network([
      {
        path: /water_system\/state_code\/equals\/WA\//,
        rows: [
          { pwsid: 'WA1234567', state_code: 'WA' },
          { pwsid: 'OR1234567', state_code: 'WA' },
        ],
      },
      {
        path: /geographic_area\/county_served\/equals\/KING\//,
        rows: [{ pwsid: 'WA1234567', county_served: 'KING' }],
      },
    ]);
    const result = data(
      await paced(
        runToolContract(tool, {
          dataset: 'ucmr5',
          state: 'Washington',
          county: 'King County',
          zip: '98101',
        }),
      ),
    );
    expect(result).toMatchObject({
      items: [{ pwsid: 'WA1234567', state: 'OR' }],
      effective_filters: { state: 'WA', county: 'KING', state_basis: 'reported_legal_entity' },
      source_complete: true,
    });
    http.verify();
    expect(data(await runToolContract(tool, { ...scope, zip: '99999' }))).toMatchObject({
      items: [],
      source_complete: true,
    });
  });

  it('detects a changed publication after a continuously active selection crosses refresh time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let downloads = 0;
    install([], async () => {
      downloads++;
      return new Response(
        archive(
          relations(
            Array.from({ length: 45 }, (_, i) =>
              occurrence({ SampleID: `${i}-${downloads === 1 ? 'old' : 'new'}` }),
            ),
          ),
        ),
      );
    });
    let page = data(await runToolContract(tool, { ...scope, limit: 1 }));
    for (let i = 0; i < 35; i++) {
      vi.setSystemTime(Date.now() + 600000);
      page = data(await runToolContract(tool, { ...scope, limit: 1, cursor: page.next_cursor }));
    }
    vi.setSystemTime(Date.now() + 600000);
    error(
      await runToolContract(tool, { ...scope, limit: 1, cursor: page.next_cursor }),
      'source_changed',
    );
  });

  it('finishes paged membership before occurrence retrieval and retains the membership continuation', async () => {
    const service = install([
      occurrence({ PWSID: 'WA0000000' }),
      occurrence({ SampleID: 'excluded' }),
    ]);
    (await service.acquire(new AbortController().signal)).release();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const http = network([
      ...Array.from({ length: 17 }, (_, page) => ({
        path: new RegExp(
          `/sdwis\\.water_system/state_code/equals/WA/sort/pwsid/${page * 1000 + 1}:${page * 1000 + 1000}/json$`,
        ),
        rows: Array.from({ length: 1000 }, (_, i) => ({
          pwsid: `WA${String(page * 1000 + i).padStart(7, '0')}`,
          state_code: 'WA',
        })),
      })),
      { path: /\/17001:18000\/json$/, rows: [] },
    ]);
    const input = { dataset: 'ucmr5' as const, state: 'WA' };
    const first = data(await paced(runToolContract(tool, input)));
    expect(first).toMatchObject({
      phase: 'membership',
      returned: 0,
      items: [],
      has_more: true,
      source_complete: false,
    });
    expect(http.calls).toHaveLength(17);
    const last = data(await paced(runToolContract(tool, { ...input, cursor: first.next_cursor })));
    expect(last).toMatchObject({
      items: [{ pwsid: 'WA0000000' }],
      returned: 1,
      source_complete: true,
      has_more: false,
    });
    http.verify();
  });

  it('rejects wrong-mode selectors, reports disabled staging, and discloses effective limit clamps', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(archive()));
    install([], fetcher);
    error(await runToolContract(tool, { ...scope, zip: '9810' }), 'invalid_selector');
    error(await runToolContract(tool, { ...scope, stage: true }), 'canvas_disabled');
    error(await runToolContract(tool, { ...scope, view: 'text' }), 'cursor_invalid');
    expect(fetcher).not.toHaveBeenCalled();
    const result = data(
      await runToolContract(tool, { ...scope, limit: 101, stage_max_rows: 25001 }),
    );
    expect(result.limit).toBe(100);
    expect(result.notices.join(' ')).toContain('clamped to 100');
    expect(result.notices.join(' ')).toContain('clamped to 25000');
  });

  it('propagates cancellation into archive I/O and permits a later selection', async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    let calls = 0;
    install([], async (_url, init) => {
      calls++;
      if (calls > 1) return new Response(archive());
      const signal = init?.signal;
      if (!signal) throw new Error('Missing network signal');
      entered.resolve(signal);
      return new Promise<Response>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
    const caller = new AbortController();
    const pending = runToolContract(tool, scope, { context: { signal: caller.signal } });
    const networkSignal = await entered.promise;
    caller.abort(new DOMException('caller stopped', 'AbortError'));
    const result = await pending;
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: -32011 } } });
    expect(JSON.stringify(result.content)).toContain('caller stopped');
    expect(networkSignal.aborted).toBe(true);
    expect(data(await runToolContract(tool, scope)).returned).toBe(1);
    expect(calls).toBe(2);
  });

  it('stages beyond preview with separate complete companion relations and exact partitions', async () => {
    canvas = fixture();
    initCanvasService(canvas.canvas);
    install([
      occurrence(),
      occurrence({ SampleID: 'zero', AnalyticalResultsSign: '=', AnalyticalResultValue: '0' }),
      occurrence({ SampleID: 'third' }),
    ]);
    const first = data(
      await runToolContract(tool, { ...scope, stage: true, limit: 1, stage_max_rows: 2 }),
    );
    expect(first).toMatchObject({
      returned: 1,
      truncated: true,
      source_complete: false,
      dataset: { row_count: 2, source_complete: false },
    });
    const handle = first.dataset;
    if (!handle) throw new Error('Missing real canvas manifest');
    const service = getCanvasService();
    const instance = await canvas.canvas.acquire(handle.canvas_id, canvas.ctx);
    const tables = await instance.describe();
    expect(tables.map((table) => table.rowCount).sort()).toEqual([2, 2, 2]);
    const additional = tables.find((table) => table.name.startsWith('ucmr5_additional_'));
    const zip = tables.find((table) => table.name.startsWith('ucmr5_zip_membership_'));
    expect(additional).toBeDefined();
    expect(zip).toBeDefined();
    const query = (sql: string) =>
      service.query({ canvas_id: handle.canvas_id, sql, view: 'records', limit: 100 }, canvas!.ctx);
    expect(
      (
        await query(
          `SELECT sample_id, analytical_result_value, censored FROM ${handle.table_name} ORDER BY sample_id`,
        )
      ).items,
    ).toEqual([
      { sample_id: 'S1', analytical_result_value: null, censored: true },
      { sample_id: 'zero', analytical_result_value: 0, censored: false },
    ]);
    expect(
      (await query(`SELECT response FROM ${additional?.name} ORDER BY response`)).items,
    ).toEqual([{ response: 'A' }, { response: 'B' }]);
    expect((await query(`SELECT zip_code FROM ${zip?.name} ORDER BY zip_code`)).items).toEqual([
      { zip_code: '98101' },
      { zip_code: '98102' },
    ]);
    const last = data(
      await runToolContract(tool, {
        ...scope,
        stage: true,
        limit: 1,
        stage_max_rows: 2,
        canvas_id: handle.canvas_id,
        cursor: first.next_cursor,
      }),
    );
    expect(last).toMatchObject({
      items: [{ sample_id: 'third' }],
      dataset: { row_count: 1, source_complete: false },
      source_complete: false,
    });
    expect(await instance.describe()).toHaveLength(6);
  });

  it('keeps the failed staged partition cursor retryable when companion admission exceeds capacity', async () => {
    canvas = fixture();
    initCanvasService(canvas.canvas);
    install([occurrence(), occurrence({ SampleID: 'second' })]);
    const input = { ...scope, stage: true, limit: 1, stage_max_rows: 1 };
    const first = data(await runToolContract(tool, input));
    const handle = first.dataset;
    if (!handle) throw new Error('Missing real canvas manifest');
    const service = getCanvasService();
    const filler = await service.stageRelations(
      { canvas_id: handle.canvas_id },
      first,
      Array.from({ length: 11 }, (_, i) => ({
        relation: `filler${i}`,
        rows: [{ value: i }],
        schema: [{ name: 'value', type: 'INTEGER' as const, nullable: false }],
      })),
      canvas.ctx,
    );
    const next = { ...input, canvas_id: handle.canvas_id, cursor: first.next_cursor };
    error(await runToolContract(tool, next), 'canvas_capacity_exhausted');
    const instance = await canvas.canvas.acquire(handle.canvas_id, canvas.ctx);
    expect(await instance.describe()).toHaveLength(14);
    await service.drop(filler, canvas.ctx);
    const retried = data(await runToolContract(tool, next));
    expect(retried).toMatchObject({
      items: [{ sample_id: 'second' }],
      source_complete: false,
      dataset: { row_count: 1 },
    });
    expect(await instance.describe()).toHaveLength(16);
    expect((await instance.query(`SELECT sample_id FROM ${handle.table_name}`)).rows).toEqual([
      { sample_id: 'S1' },
    ]);
  });
});
