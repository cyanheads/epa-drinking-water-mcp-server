/**
 * @fileoverview Archive-to-tool UCMR selection, continuation and companion staging contracts.
 * @module tests/tools/ucmr5-producer.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceOutput } from '../../src/domain/source-output.js';
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
  initCanvasService(undefined, 25000);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('real UCMR producer through tool contract', () => {
  it('preserves PWSID and ZIP intersections without SDWIS requests', async () => {
    const dmap = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', dmap);
    install([occurrence(), occurrence({ PWSID: 'OR1234567', SampleID: 'other' })]);
    expect(data(await runToolContract(tool, { ...scope, zip: '98101' }))).toMatchObject({
      items: [{ pwsid: 'WA1234567' }],
      has_more: false,
      source_complete: true,
    });
    expect(
      data(await runToolContract(tool, { ...scope, pwsid: 'WA9999999', zip: '98101' })),
    ).toMatchObject({
      items: [],
      has_more: false,
      source_complete: true,
    });
    expect(dmap).not.toHaveBeenCalled();
  });

  it('pages ZIP-only occurrences without SDWIS requests and preserves empty ZIP selections', async () => {
    const dmap = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', dmap);
    install([occurrence(), occurrence({ PWSID: 'OR1234567', SampleID: 'other' })]);
    const input = { dataset: 'ucmr5', zip: '98101', limit: 1 } as const;
    const first = data(await runToolContract(tool, input));
    expect(first).toMatchObject({
      items: [{ pwsid: 'WA1234567' }],
      effective_filters: { zip: '98101' },
      has_more: true,
      source_complete: false,
    });
    error(
      await runToolContract(tool, { ...input, zip: '98102', cursor: first.next_cursor }),
      'cursor_invalid',
    );
    const last = data(await runToolContract(tool, { ...input, cursor: first.next_cursor }));
    expect(last).toMatchObject({
      items: [{ pwsid: 'OR1234567' }],
      has_more: false,
      source_complete: false,
    });
    expect(data(await runToolContract(tool, { dataset: 'ucmr5', zip: '00000' }))).toMatchObject({
      items: [],
      returned: 0,
      has_more: false,
      source_complete: true,
    });
    expect(dmap).not.toHaveBeenCalled();
  });

  it('returns 500 whole occurrence rows and clamps 501 without shortening pages for bytes', async () => {
    const name = 'µ <water> [district](https://example.org) "\\'.repeat(12);
    install(
      Array.from({ length: 1001 }, (_, i) => occurrence({ SampleID: `S${i}`, PWSName: name })),
    );
    const first = data(await runToolContract(tool, { ...scope, limit: 500 }));
    expect(first).toMatchObject({
      returned: 500,
      limit: 500,
      has_more: true,
      source_complete: false,
    });
    expect(first.items.map((row) => row.sample_id)).toEqual(
      Array.from({ length: 500 }, (_, i) => `S${i}`),
    );
    expect(first.items.every((row) => row.pws_name === name)).toBe(true);
    const second = data(
      await runToolContract(tool, { ...scope, limit: 501, cursor: first.next_cursor }),
    );
    expect(second).toMatchObject({
      returned: 500,
      limit: 500,
      has_more: true,
      source_complete: false,
    });
    expect(second.items.map((row) => row.sample_id)).toEqual(
      Array.from({ length: 500 }, (_, i) => `S${i + 500}`),
    );
    expect(second.notices.join(' ')).toContain('clamped to 500');
    const last = data(await runToolContract(tool, { ...scope, cursor: second.next_cursor }));
    expect(last).toMatchObject({
      items: [{ sample_id: 'S1000' }],
      returned: 1,
      has_more: false,
      source_complete: false,
    });
  });

  it('previews 500 whole staged rows and advances past the entire atomic partition', async () => {
    canvas = fixture();
    initCanvasService(canvas.canvas, 25000);
    install(Array.from({ length: 502 }, (_, i) => occurrence({ SampleID: `S${i}` })));
    const input = { ...scope, stage: true, limit: 501, stage_max_rows: 501 };
    const first = data(await runToolContract(tool, input));
    expect(first).toMatchObject({
      returned: 500,
      limit: 500,
      truncated: true,
      has_more: true,
      source_complete: false,
      dataset: { row_count: 501 },
    });
    expect(first.items[499]?.sample_id).toBe('S499');
    const last = data(
      await runToolContract(tool, {
        ...input,
        canvas_id: first.dataset!.canvas_id,
        cursor: first.next_cursor,
      }),
    );
    expect(last).toMatchObject({
      items: [{ sample_id: 'S501' }],
      returned: 1,
      has_more: false,
      source_complete: false,
      dataset: { row_count: 1 },
    });
    const instance = await canvas.canvas.acquire(first.dataset!.canvas_id, canvas.ctx);
    expect(
      (
        await instance.query(
          `SELECT sample_id FROM ${first.dataset!.table_name} WHERE sample_id = 'S500'`,
        )
      ).rows,
    ).toEqual([{ sample_id: 'S500' }]);
  });

  it('rejects missing, malformed and wrong-dataset ZIP scopes before upstream I/O', async () => {
    const dmap = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', dmap);
    const archiveFetch = vi.fn<typeof fetch>(async () => new Response(archive()));
    install([], archiveFetch);
    for (const input of [
      { dataset: 'ucmr5' },
      { dataset: 'ucmr5', zip: '9810' },
      { dataset: 'ucmr5', zip: '98101', county: 'King' },
      { dataset: 'violations', pwsid: 'WA1234567', zip: '98101' },
      { dataset: 'lcr', pwsid: 'WA1234567', zip: '98101' },
    ] as const)
      error(await runToolContract(tool, input), 'invalid_selector');
    expect(dmap).not.toHaveBeenCalled();
    expect(archiveFetch).not.toHaveBeenCalled();
  });
  it('keeps identical-filter interleaved retrieval identities distinct and represents an exhausted empty selection atomically', async () => {
    canvas = fixture();
    initCanvasService(canvas.canvas, 25000);
    install([occurrence(), occurrence({ SampleID: 'second' })]);
    const input = { ...scope, stage: true, stage_max_rows: 1 };
    const a = data(await runToolContract(tool, input));
    const canvas_id = a.dataset!.canvas_id;
    const b = data(await runToolContract(tool, { ...input, canvas_id }));
    expect(a.selection_partition?.selection_id).not.toBe(b.selection_partition?.selection_id);
    const a2 = data(await runToolContract(tool, { ...input, canvas_id, cursor: a.next_cursor }));
    const b2 = data(await runToolContract(tool, { ...input, canvas_id, cursor: b.next_cursor }));
    expect(a2.selection_partition?.selection_id).toBe(a.selection_partition?.selection_id);
    expect(b2.selection_partition?.selection_id).toBe(b.selection_partition?.selection_id);
    const metadata = await getCanvasService().describe({ canvas_id, limit: 100 }, canvas.ctx);
    expect(metadata.selection_coverage).toEqual([
      {
        selection_id: a.selection_partition?.selection_id,
        partitions_present: [0, 1],
        final_partition: 1,
        chain_complete: true,
      },
      {
        selection_id: b.selection_partition?.selection_id,
        partitions_present: [0, 1],
        final_partition: 1,
        chain_complete: true,
      },
    ]);
    const empty = data(await runToolContract(tool, { ...input, date_from: '2025-01-01' }));
    expect(empty).toMatchObject({
      items: [],
      source_complete: true,
      selection_partition: { partition: 0, final_partition: 0 },
    });
    const emptyMetadata = await getCanvasService().describe(
      { canvas_id: empty.dataset!.canvas_id, limit: 100 },
      canvas.ctx,
    );
    expect(emptyMetadata.items.map((item) => item.row_count)).toEqual([0, 0, 0]);
    expect(emptyMetadata.selection_coverage).toEqual([
      {
        selection_id: empty.selection_partition?.selection_id,
        partitions_present: [0],
        final_partition: 0,
        chain_complete: true,
      },
    ]);
  });
  it('stages large whole rows without leaving a source partition gap', async () => {
    canvas = fixture();
    initCanvasService(canvas.canvas, 25000);
    install([occurrence({ PWSName: 'x'.repeat(80000) }), occurrence({ SampleID: 'next' })]);
    const input = { ...scope, stage: true, stage_max_rows: 1 };
    const first = data(await runToolContract(tool, input));
    expect(first.items[0]?.pws_name).toBe('x'.repeat(80000));
    expect(first.selection_partition).toMatchObject({ partition: 0, final_partition: null });
    const staged = data(
      await runToolContract(tool, {
        ...input,
        canvas_id: first.dataset!.canvas_id,
        cursor: first.next_cursor,
      }),
    );
    expect(staged.selection_partition).toEqual({
      selection_id: first.selection_partition?.selection_id,
      partition: 1,
      final_partition: 1,
    });
    expect(
      await getCanvasService().describe(
        { canvas_id: staged.dataset!.canvas_id, limit: 100 },
        canvas.ctx,
      ),
    ).toMatchObject({
      selection_coverage: [
        { partitions_present: [0, 1], final_partition: 1, chain_complete: true },
      ],
    });
  });
  it('refreshes ordinary record activity and preserves the final source completeness distinction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    install([occurrence(), occurrence({ SampleID: 'second' }), occurrence({ SampleID: 'third' })]);
    const first = data(await runToolContract(tool, { ...scope, limit: 1 }));
    vi.setSystemTime(Date.now() + 600000);
    const second = data(
      await runToolContract(tool, { ...scope, limit: 1, cursor: first.next_cursor }),
    );
    vi.setSystemTime(Date.now() + 600000);
    expect(
      data(await runToolContract(tool, { ...scope, cursor: second.next_cursor })),
    ).toMatchObject({
      items: [{ sample_id: 'third' }],
      source_complete: false,
      has_more: false,
    });
  });
  it('keeps cancelled positions retryable with refreshed idle activity and sweeps expired jobs at capacity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const service = install([
      occurrence(),
      occurrence({ SampleID: 'second' }),
      occurrence({ SampleID: 'third' }),
    ]);
    const produce = createUcmrProducer(service);
    const ctx = createMockContext();
    const first = await produce({ ...scope, limit: 1 }, ctx);
    vi.setSystemTime(Date.now() + 600000);
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled position', 'AbortError'));
    await expect(
      produce(
        { ...scope, cursor: first.next_cursor },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    vi.setSystemTime(Date.now() + 600000);
    const second = await produce({ ...scope, limit: 1, cursor: first.next_cursor }, ctx);
    expect(second.items.map((row) => row.sample_id)).toEqual(['second']);
    for (let i = 0; i < 99; i++) await produce({ ...scope, date_from: '2025-01-01' }, ctx);
    await expect(produce(scope, ctx)).rejects.toMatchObject({
      data: { reason: 'selection_capacity_exhausted' },
    });
    vi.setSystemTime(Date.now() + 900001);
    await expect(produce({ ...scope, cursor: second.next_cursor }, ctx)).rejects.toMatchObject({
      data: { reason: 'cursor_invalid' },
    });
    expect(await produce(scope, ctx)).toMatchObject({ returned: 3, source_complete: true });
  });
  it('walks more than 4096 single-row positions without retaining obsolete pointers', async () => {
    const service = install(
      Array.from({ length: 4098 }, (_, i) => occurrence({ SampleID: String(i) })),
    );
    const produce = createUcmrProducer(service);
    const ctx = createMockContext();
    let cursor: string | undefined;
    const started = performance.now();
    for (let i = 0; i < 4098; i++) {
      const page = await produce({ ...scope, limit: 1, cursor }, ctx);
      expect(page.items.map((row) => row.sample_id)).toEqual([String(i)]);
      cursor = page.next_cursor;
    }
    expect(cursor).toBeUndefined();
    console.info('4098 real UCMR positions:', { elapsedMs: performance.now() - started });
  });
  it('refreshes large whole-row continuation activity and expires idle positions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    install(
      Array.from({ length: 4 }, (_, i) =>
        occurrence({ SampleID: String(i), PWSName: 'x'.repeat(80000) }),
      ),
    );
    const first = data(await runToolContract(tool, { ...scope, limit: 1 }));
    expect(first.items[0]?.pws_name).toBe('x'.repeat(80000));
    vi.setSystemTime(Date.now() + 600000);
    const second = data(
      await runToolContract(tool, { ...scope, limit: 1, cursor: first.next_cursor }),
    );
    expect(second.items[0]?.sample_id).toBe('1');
    vi.setSystemTime(Date.now() + 600000);
    const third = data(
      await runToolContract(tool, { ...scope, limit: 1, cursor: second.next_cursor }),
    );
    expect(third.items[0]?.sample_id).toBe('2');
    error(await runToolContract(tool, { ...scope, cursor: first.next_cursor }), 'cursor_invalid');
    vi.setSystemTime(Date.now() + 900001);
    error(await runToolContract(tool, { ...scope, cursor: third.next_cursor }), 'cursor_invalid');
  });
  it('resumes UCMR membership after an awaited deadline checkpoint', async () => {
    // Keep this artificial deadline from carrying DMAP pacing state into other archive tests.
    vi.resetModules();
    const [
      { searchContaminantsTool: deadlineTool },
      { setUcmrProducer: bind },
      { createUcmrProducer: producer },
    ] = await Promise.all([
      import('../../src/mcp-server/tools/definitions/search-contaminants.tool.js'),
      import('../../src/services/sdwis/drinking-water-service.js'),
      import('../../src/services/ucmr5/ucmr5-producer.js'),
    ]);
    const service = install([occurrence({ PWSID: 'WA0000000' })]);
    bind(producer(service));
    (await service.acquire(new AbortController().signal)).release();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let stopped = false;
    const http = network([
      {
        path: /\/sdwis\.water_system\/.*\/1:1000\/json$/,
        response: (signal) =>
          new Promise<Response>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                stopped = true;
                reject(signal.reason);
              },
              { once: true },
            ),
          ),
      },
      {
        path: /\/sdwis\.water_system\/.*\/1:1000\/json$/,
        response: (signal) =>
          new Promise<Response>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          ),
      },
      {
        path: /\/sdwis\.water_system\/.*\/1:1000\/json$/,
        rows: [{ pwsid: 'WA0000000', state_code: 'WA' }],
      },
    ]);
    const input = { dataset: 'ucmr5' as const, state: 'WA' };
    const first = data(await paced(runToolContract(deadlineTool, input)));
    expect(first).toMatchObject({
      phase: 'membership',
      items: [],
      has_more: true,
      source_complete: false,
    });
    expect(stopped).toBe(true);
    expect(first.selection_partition).toBeUndefined();
    vi.setSystemTime(Date.now() + 600000);
    const second = data(
      await paced(runToolContract(deadlineTool, { ...input, cursor: first.next_cursor })),
    );
    expect(second.phase).toBe('membership');
    vi.setSystemTime(Date.now() + 600000);
    const last = data(
      await paced(runToolContract(deadlineTool, { ...input, cursor: second.next_cursor })),
    );
    expect(last).toMatchObject({
      items: [{ pwsid: 'WA0000000' }],
      has_more: false,
      source_complete: true,
      selection_partition: { partition: 0, final_partition: 0 },
    });
    http.verify();
  });
  it('retains inclusive date-only selectors in filters and paged continuation identity', async () => {
    install([occurrence(), occurrence({ SampleID: 'second' })]);
    const input = { ...scope, date_from: '2024-02-29', date_to: '2024-02-29', limit: 1 };
    const first = data(await runToolContract(tool, input));
    expect(first).toMatchObject({
      returned: 1,
      effective_filters: { date_from: '2024-02-29', date_to: '2024-02-29' },
      has_more: true,
    });
    expect(
      data(await runToolContract(tool, { ...input, cursor: first.next_cursor })),
    ).toMatchObject({ items: [{ sample_id: 'second' }], has_more: false });
  });
  it('normalizes accepted timestamp bounds before UCMR filtering and continuation identity', async () => {
    install([occurrence(), occurrence({ SampleID: 'second' })]);
    const first = data(
      await runToolContract(tool, {
        ...scope,
        date_from: '2024-02-29 12:30:00',
        date_to: '2024-02-29 23:59:59',
        limit: 1,
      }),
    );
    expect(first).toMatchObject({
      items: [{ sample_id: 'S1' }],
      effective_filters: { date_from: '2024-02-29', date_to: '2024-02-29' },
      has_more: true,
    });
    expect(
      data(
        await runToolContract(tool, {
          ...scope,
          date_from: '2024-02-29',
          date_to: '2024-02-29',
          limit: 1,
          cursor: first.next_cursor,
        }),
      ),
    ).toMatchObject({ items: [{ sample_id: 'second' }], has_more: false });
    expect(
      data(await runToolContract(tool, { ...scope, date_to: '2024-02-28 23:59:59' })),
    ).toMatchObject({ items: [], source_complete: true });
    error(
      await runToolContract(tool, { ...scope, date_from: '2024-02-30 00:00:00' }),
      'invalid_selector',
    );
    error(
      await runToolContract(tool, {
        ...scope,
        date_from: '2024-03-01',
        date_to: '2024-02-29 23:59:59',
      }),
      'invalid_selector',
    );
  });
  it('marks an entire first staged selection complete despite a smaller preview', async () => {
    canvas = fixture();
    initCanvasService(canvas.canvas, 25000);
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

  it('retains whole large rows at exact row-count continuation boundaries', async () => {
    install(
      Array.from({ length: 4 }, (_, i) =>
        occurrence({ SampleID: `S${i}`, PWSName: `${i}:${'µ'.repeat(1600)}` }),
      ),
    );
    let page = data(await runToolContract(tool, { ...scope, limit: 2 }));
    expect(page.returned).toBe(2);
    const ids: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(...page.items.map((row) => row.sample_id));
      if (!page.has_more) break;
      page = data(await runToolContract(tool, { ...scope, limit: 2, cursor: page.next_cursor }));
    }
    expect(ids).toEqual(['S0', 'S1', 'S2', 'S3']);
    expect(page.source_complete).toBe(false);
  });

  it('returns an oversized Unicode and markup row whole then resumes ordinary rows', async () => {
    const name = 'µ"\\'.repeat(2500);
    install([occurrence({ PWSName: name }), occurrence({ SampleID: 'next' })]);
    const first = data(await runToolContract(tool, { ...scope, limit: 1 }));
    expect(first.items[0]).toMatchObject({
      pws_name: name,
      sample_id: 'S1',
      analytical_result_value: null,
    });
    expect(first.next_cursor).toBeDefined();
    expect(
      data(await runToolContract(tool, { ...scope, cursor: first.next_cursor })),
    ).toMatchObject({
      items: [{ sample_id: 'next' }],
      source_complete: false,
    });
  });

  it.each(['King', 'St. Clair'])(
    'intersects reported state/county %s inventory with ZIP memberships rather than source-state labels',
    async (county) => {
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
          path:
            county === 'King'
              ? /geographic_area\/county_served\/equals\/KING\//
              : /geographic_area\/county_served\/beginsWith\/ST\//,
          rows: [
            ...(county === 'King' ? [] : [{ pwsid: 'OR1234567', county_served: 'STEVENS' }]),
            { pwsid: 'WA1234567', county_served: county.toUpperCase() },
          ],
        },
      ]);
      const result = data(
        await paced(
          runToolContract(tool, {
            dataset: 'ucmr5',
            state: 'Washington',
            county: `${county} County`,
            zip: '98101',
          }),
        ),
      );
      expect(result).toMatchObject({
        items: [{ pwsid: 'WA1234567', state: 'OR' }],
        effective_filters: {
          state: 'WA',
          county: county.toUpperCase(),
          state_basis: 'reported_legal_entity',
        },
        source_complete: true,
      });
      http.verify();
      expect(data(await runToolContract(tool, { ...scope, zip: '99999' }))).toMatchObject({
        items: [],
        source_complete: true,
      });
    },
  );

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
    for (const legacy of [{ view: 'text' }, { view: 'records' }, { record_cursor: 'obsolete' }]) {
      const rejected = await runToolContract(tool, { ...scope, ...legacy });
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: { error: { code: -32602 } },
      });
      expect(JSON.stringify(rejected.content)).toContain('Unrecognized key');
    }
    expect(fetcher).not.toHaveBeenCalled();
    const result = data(
      await runToolContract(tool, { ...scope, limit: 501, stage_max_rows: 25001 }),
    );
    expect(result.limit).toBe(500);
    expect(result.notices.join(' ')).toContain('clamped to 500');
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
    initCanvasService(canvas.canvas, 25000);
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
      service.query({ canvas_id: handle.canvas_id, sql, limit: 100 }, canvas!.ctx);
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
    expect(first.selection_partition).toMatchObject({ partition: 0, final_partition: null });
    expect(last.selection_partition).toEqual({
      selection_id: first.selection_partition?.selection_id,
      partition: 1,
      final_partition: 1,
    });
    expect(
      await service.describe({ canvas_id: handle.canvas_id, limit: 1 }, canvas.ctx),
    ).toMatchObject({
      selection_coverage: [
        {
          selection_id: first.selection_partition?.selection_id,
          partitions_present: [0, 1],
          final_partition: 1,
          chain_complete: true,
        },
      ],
    });
  });

  it('keeps the failed staged partition cursor retryable when companion admission exceeds capacity', async () => {
    canvas = fixture();
    initCanvasService(canvas.canvas, 25000);
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

  it('enforces strict 500-row validation on both tool response surfaces', async () => {
    vi.resetModules();
    vi.stubEnv('SDWIS_CLAMP_LIMITS', 'false');
    const { searchContaminantsTool: strictTool } = await import(
      '../../src/mcp-server/tools/definitions/search-contaminants.tool.js'
    );
    const { setUcmrProducer: bind } = await import(
      '../../src/services/sdwis/drinking-water-service.js'
    );
    const { createUcmrProducer: producer } = await import(
      '../../src/services/ucmr5/ucmr5-producer.js'
    );
    const service = install(
      Array.from({ length: 500 }, (_, i) => occurrence({ SampleID: String(i) })),
    );
    bind(producer(service));
    const exact = await runToolContract(strictTool, { ...scope, limit: 500 });
    expectParity(exact);
    expect(exact.structuredContent).toMatchObject({
      returned: 500,
      limit: 500,
      has_more: false,
      source_complete: true,
    });
    for (const invalid of [501, 0, -1, 1.5]) {
      const rejected = await runToolContract(strictTool, { ...scope, limit: invalid });
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: { error: { code: -32602 } },
      });
      expect(JSON.stringify(rejected.content)).toContain('limit');
    }
  });
});
