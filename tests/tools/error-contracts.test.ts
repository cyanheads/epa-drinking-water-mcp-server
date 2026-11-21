/** @fileoverview Reachable service failures retain actionable recovery on both tool surfaces. */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture, output } from '../services/dataframe/canvas-fixtures.js';
import { expectParity, network, paced } from '../services/sdwis/sdwis-fixtures.js';

async function definitions() {
  const [
    search,
    profile,
    violations,
    enforcement,
    contaminants,
    reference,
    query,
    describe,
    drop,
    service,
    source,
  ] = await Promise.all([
    import('@/mcp-server/tools/definitions/search-water-systems.tool.js'),
    import('@/mcp-server/tools/definitions/get-system-profile.tool.js'),
    import('@/mcp-server/tools/definitions/get-violations.tool.js'),
    import('@/mcp-server/tools/definitions/get-enforcement-actions.tool.js'),
    import('@/mcp-server/tools/definitions/search-contaminants.tool.js'),
    import('@/mcp-server/tools/definitions/list-reference.tool.js'),
    import('@/mcp-server/tools/definitions/dataframe-query.tool.js'),
    import('@/mcp-server/tools/definitions/dataframe-describe.tool.js'),
    import('@/mcp-server/tools/definitions/dataframe-drop.tool.js'),
    import('@/services/dataframe/canvas-service.js'),
    import('@/services/sdwis/drinking-water-service.js'),
  ]);
  return {
    search: search.searchWaterSystemsTool,
    profile: profile.getSystemProfileTool,
    violations: violations.getViolationsTool,
    enforcement: enforcement.getEnforcementActionsTool,
    contaminants: contaminants.searchContaminantsTool,
    reference: reference.listReferenceTool,
    query: query.dataframeQueryTool,
    describe: describe.dataframeDescribeTool,
    drop: drop.dataframeDropTool,
    ...service,
    ...source,
  };
}
let d: Awaited<ReturnType<typeof definitions>>;
beforeEach(async () => {
  vi.resetModules();
  d = await definitions();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function failure(
  result: Awaited<ReturnType<typeof runToolContract>>,
  reason: string,
  hint: string,
  code = JsonRpcErrorCode.RateLimited,
) {
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code, data: { reason, recovery: { hint } } } },
  });
  expect(JSON.stringify(result.content)).toContain(reason);
  expect(JSON.stringify(result.content)).toContain(hint);
}
const selectionHint =
  'Wait fifteen minutes for source selections to expire, then retry with narrower selectors.';
const canvasHint =
  'Reuse a canvas_id you already hold, wait for expiry, or narrow the source selection.';

describe('source error recovery', () => {
  it.each([
    [503, 3, 'upstream_unavailable', JsonRpcErrorCode.ServiceUnavailable, /retry/i],
    [408, 3, 'upstream_timeout', JsonRpcErrorCode.Timeout, /narrow/i],
    [429, 3, 'upstream_rate_limited', JsonRpcErrorCode.RateLimited, /wait/i],
    [403, 1, 'upstream_forbidden', JsonRpcErrorCode.Forbidden, /access/i],
    [400, 1, 'upstream_contract_changed', JsonRpcErrorCode.ServiceUnavailable, /retry/i],
    [404, 1, 'upstream_contract_changed', JsonRpcErrorCode.ServiceUnavailable, /retry/i],
    [501, 1, 'upstream_unavailable', JsonRpcErrorCode.ServiceUnavailable, /retry/i],
  ] as const)(
    'classifies EPA HTTP %i with recovery on both tool surfaces',
    async (status, attempts, reason, code, recovery) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const http = network(
        Array.from({ length: attempts }, () => ({
          path: /sdwis\.violation\//,
          response: () => new Response('BODY-CANARY', { status, headers: { 'retry-after': '0' } }),
        })),
      );
      const result = await paced(runToolContract(d.violations, { pwsid: 'WA1234567' }));
      expect(result).toMatchObject({
        structuredContent: { error: { data: { status, retryable: attempts > 1 } } },
      });
      const declaration = d.violations.errors?.find((entry) => entry.reason === reason);
      expect(declaration).toMatchObject({
        thrownBy: 'service',
        recovery: expect.stringMatching(recovery),
      });
      failure(result, reason, declaration!.recovery, code);
      expect(JSON.stringify(result)).not.toContain('BODY-CANARY');
      http.verify();
    },
  );

  it('advertises every EPA failure on each source tool', () => {
    for (const tool of [
      d.reference,
      d.search,
      d.profile,
      d.violations,
      d.enforcement,
      d.contaminants,
    ]) {
      expect(tool.errors?.map(({ reason }) => reason)).toEqual(
        expect.arrayContaining([
          'upstream_contract_changed',
          'upstream_forbidden',
          'upstream_rate_limited',
          'upstream_timeout',
          'upstream_unavailable',
        ]),
      );
    }
  });

  it('renders exhausted DMAP transport recovery without the private cause', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const http = network(
      Array.from({ length: 3 }, () => ({
        path: /sdwis\.violation\//,
        response: () => {
          throw new TypeError('NETWORK-CANARY');
        },
      })),
    );
    const result = await paced(runToolContract(d.violations, { pwsid: 'WA1234567' }));
    failure(
      result,
      'upstream_unavailable',
      'Retry the source tool later when the EPA endpoint is available.',
      JsonRpcErrorCode.ServiceUnavailable,
    );
    expect(JSON.stringify(result)).not.toContain('NETWORK-CANARY');
    http.verify();
  });

  it('renders non-retryable archive failure recovery through the UCMR tool', async () => {
    const { createUcmrProducer } = await import('@/services/ucmr5/ucmr5-producer.js');
    const { Ucmr5Service } = await import('@/services/ucmr5/ucmr5-service.js');
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('BODY-CANARY', { status: 501 }),
    );
    const service = new Ucmr5Service({ fetch });
    d.setUcmrProducer(createUcmrProducer(service, () => {}));
    try {
      const result = await runToolContract(d.contaminants, {
        dataset: 'ucmr5',
        pwsid: 'WA1234567',
      });
      failure(
        result,
        'upstream_unavailable',
        'Retry the source tool later when the EPA endpoint is available.',
        JsonRpcErrorCode.ServiceUnavailable,
      );
      expect(result).toMatchObject({
        structuredContent: { error: { data: { status: 501, retryable: false } } },
      });
      expect(JSON.stringify(result)).not.toContain('BODY-CANARY');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
    }
  });

  it('adds profile selector recovery without fetching malformed IDs', async () => {
    const http = network([]);
    failure(
      await runToolContract(d.profile, { pwsid: 'WA53' }),
      'invalid_selector',
      'Use sdwis_search_water_systems to obtain a nine-character PWSID, then retry this profile.',
      JsonRpcErrorCode.ValidationError,
    );
    http.verify();
  });

  it.each(['discovery', 'reference'] as const)(
    'renders revision-change recovery on a paged %s selection',
    async (surface) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const [tool, selectors, table, rows] =
        surface === 'discovery'
          ? ([
              d.search,
              { pwsid_prefix: 'WA' },
              'water_system',
              Array.from({ length: 1000 }, (_, index) => ({
                pwsid: `WA${String(index).padStart(7, '0')}`,
                pws_activity_code: 'A',
              })),
            ] as const)
          : ([
              d.reference,
              { topic: 'enforcement_types' },
              'ref_code_value',
              Array.from({ length: 1000 }, (_, index) => ({
                value_type: 'ENFORCEMENT_ACTION_TYPE_CODE',
                value_code: String(index).padStart(4, '0'),
              })),
            ] as const);
      const http = network([
        {
          path: new RegExp(`sdwis\\.${table}/.*/1:1000/json$`),
          response: () => Response.json(rows, { headers: { etag: 'revision-a' } }),
        },
        {
          path: new RegExp(`sdwis\\.${table}/.*/1001:2000/json$`),
          response: () => Response.json([], { headers: { etag: 'revision-b' } }),
        },
      ]);
      const args = { ...selectors, limit: 500 };
      const first = await paced(runToolContract(tool, args));
      expect(first.structuredContent).toMatchObject({ returned: 500, has_more: true });
      const { next_cursor: cursor } = z
        .object({ next_cursor: z.string() })
        .parse(first.structuredContent);
      failure(
        await paced(runToolContract(tool, { ...args, cursor })),
        'source_changed',
        'Repeat the same source tool without cursor to retrieve the newly published source revision.',
        JsonRpcErrorCode.Conflict,
      );
      http.verify();
    },
  );

  it('reaches selection capacity from all six EPA tools and recovers after actual expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const http = network([]);
    for (let i = 0; i < 100; i++) {
      const result = await runToolContract(d.reference, {
        topic: 'coverage',
        query: `absent-${i}`,
      });
      expect(result.isError).not.toBe(true);
      expectParity(result);
      expect(result.structuredContent).toMatchObject({ items: [], returned: 0 });
    }
    for (const [tool, args] of [
      [d.reference, { topic: 'coverage' }],
      [d.search, { pwsid: 'WA1234567' }],
      [d.profile, { pwsid: 'WA1234567' }],
      [d.violations, { pwsid: 'WA1234567' }],
      [d.enforcement, { pwsid: 'WA1234567' }],
      [d.contaminants, { dataset: 'violations', pwsid: 'WA1234567' }],
    ] as const)
      failure(await runToolContract(tool, args), 'selection_capacity_exhausted', selectionHint);
    vi.setSystemTime(Date.now() + 900001);
    const recovered = await runToolContract(d.reference, { topic: 'coverage' });
    expect(recovered.isError).not.toBe(true);
    expectParity(recovered);
    http.verify();
  });
});

describe('canvas error recovery', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
    d.initCanvasService(f.canvas, 25000);
  });
  afterEach(async () => {
    d.initCanvasService(undefined, 25000);
    await f.canvas.shutdown(f.ctx);
  });
  const relation = {
    relation: 'measurements',
    rows: [{ value: 1 }],
    schema: [{ name: 'value', type: 'INTEGER' as const, nullable: false }],
  };
  async function stage() {
    return d.getCanvasService().stageRelations({}, output(true), [relation], f.ctx);
  }

  it('reports query cache capacity and restores query admission after its immutable TTL', async () => {
    const h = await stage();
    for (let i = 0; i < 16; i++) {
      const result = await runToolContract(d.query, {
        canvas_id: h.canvas_id,
        sql: `SELECT ${i} AS value`,
      });
      expect(result.isError).not.toBe(true);
      expectParity(result);
    }
    failure(
      await runToolContract(d.query, { canvas_id: h.canvas_id, sql: 'SELECT 17 AS value' }),
      'query_capacity_exhausted',
      'Wait fifteen minutes for retained queries to expire, then retry sdwis_dataframe_query with narrower SQL.',
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 900001);
    const recovered = await runToolContract(d.query, {
      canvas_id: h.canvas_id,
      sql: 'SELECT 17 AS value',
    });
    expect(recovered.isError).not.toBe(true);
    expectParity(recovered);
  });

  it('exposes bounded operation-queue recovery through query, describe and drop', async () => {
    const h = await stage();
    // All calls enter the real reservation queue before native DuckDB completes the first query.
    const pending = Array.from({ length: 5 }, () =>
      d.getCanvasService().query({ canvas_id: h.canvas_id, sql: 'SELECT 1', limit: 10 }, f.ctx),
    );
    const results = Promise.allSettled(pending);
    for (const [tool, args] of [
      [d.query, { canvas_id: h.canvas_id, sql: 'SELECT 2' }],
      [d.describe, { canvas_id: h.canvas_id }],
      [d.drop, { canvas_id: h.canvas_id, table_name: h.table_name }],
    ] as const)
      failure(await runToolContract(tool, args), 'canvas_capacity_exhausted', canvasHint);
    expect((await results).every((result) => result.status === 'fulfilled')).toBe(true);
  });

  it('passes real staging admission failures through every staging producer', async () => {
    const handles = [];
    for (let i = 0; i < 8; i++) handles.push(await stage());
    d.setStageProducer((partition, ctx) => d.getCanvasService().stage(partition, ctx));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const http = network([
      { path: /sdwis\.violation\//, rows: [{ pwsid: 'WA1234567', violation_id: 'v1' }] },
      { path: /sdwis\.enforcement_action\//, rows: [{ pwsid: 'WA1234567', enforcement_id: 'e1' }] },
      { path: /sdwis\.violation\//, rows: [{ pwsid: 'WA1234567', violation_id: 'v1' }] },
    ]);
    for (const [tool, args] of [
      [d.violations, { pwsid: 'WA1234567', stage: true }],
      [d.enforcement, { pwsid: 'WA1234567', stage: true }],
      [d.contaminants, { dataset: 'violations', pwsid: 'WA1234567', stage: true }],
    ] as const)
      failure(await paced(runToolContract(tool, args)), 'canvas_capacity_exhausted', canvasHint);
    http.verify();
    // Table removal does not release a canvas slot; reusing a held capability does.
    const removed = await runToolContract(d.drop, {
      canvas_id: handles[0]!.canvas_id,
      table_name: handles[0]!.table_name,
    });
    expect(removed.isError).not.toBe(true);
    const reused = await d
      .getCanvasService()
      .stageRelations({ canvas_id: handles[0]!.canvas_id }, output(true), [relation], f.ctx);
    expect(reused.canvas_id).toBe(handles[0]!.canvas_id);
  });
});
