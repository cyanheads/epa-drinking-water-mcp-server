/** @fileoverview Native DuckDB integration coverage for capability and source-lineage contracts. */

import { databaseError, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_POINTER } from '@/services/dataframe/canvas-service.js';
import { fixture, output } from './canvas-fixtures.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(async () => {
  vi.useRealTimers();
  await f.canvas.shutdown(f.ctx);
});
const relation = {
  relation: 'measurements',
  rows: [
    { value: null, sampled: '2026-01-01' },
    { value: 1.25, sampled: '2026-01-02' },
  ],
  schema: [
    { name: 'value', type: 'DOUBLE' as const, nullable: true },
    { name: 'sampled', type: 'DATE' as const, nullable: true },
  ],
};
async function stage() {
  return f.service.stageRelations({}, output(), [relation], f.ctx);
}
function query(canvas_id: string, sql: string, more = {}) {
  return f.service.query({ canvas_id, sql, limit: 10, ...more }, f.ctx);
}

describe('real canvas service', () => {
  it('executes SQL once when a retained row page is replayed', async () => {
    const h = await stage();
    const instance = await f.canvas.acquire(h.canvas_id, f.ctx);
    vi.spyOn(f.canvas, 'acquire').mockResolvedValue(instance);
    const execute = vi.spyOn(instance, 'query');
    const sql = 'SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3';
    const first = await query(h.canvas_id, sql, { limit: 1 });
    expect(first.items).toEqual([{ n: 1 }]);
    const next = await query(h.canvas_id, sql, { limit: 1, cursor: first.next_cursor });
    expect(next.items).toEqual([{ n: 2 }]);
    expect((await query(h.canvas_id, sql, { limit: 1, cursor: first.next_cursor })).items).toEqual([
      { n: 2 },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps unknown engine failures generic and preserves their cause internally', async () => {
    const h = await stage();
    const instance = await f.canvas.acquire(h.canvas_id, f.ctx);
    vi.spyOn(f.canvas, 'acquire').mockResolvedValue(instance);
    const engine = vi.spyOn(instance, 'query');
    for (const cause of [
      new Error('INTERNAL_CANARY /private/engine'),
      databaseError('INTERNAL_CANARY /private/engine', {
        reason: 'engine_internal',
        secret: 'SECRET_CANARY',
      }),
    ]) {
      engine.mockRejectedValueOnce(cause);
      const failure: unknown = await query(h.canvas_id, 'SELECT 1').catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(McpError);
      expect(failure).toMatchObject({
        cause,
        data: { recovery: { hint: expect.stringContaining('sdwis_dataframe_query') } },
      });
      if (!(failure instanceof McpError)) throw new Error('Expected a typed engine failure.');
      expect(JSON.stringify({ message: failure.message, data: failure.data })).not.toContain(
        'INTERNAL_CANARY',
      );
      expect(JSON.stringify(failure.data)).not.toContain('SECRET_CANARY');
    }
  });

  it('continues describe records across idle time without changing their selection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = await f.service.stageRelations(
      {},
      output(true),
      [relation, { ...relation, relation: 'second' }],
      f.ctx,
    );
    const first = await f.service.describe({ canvas_id: h.canvas_id, limit: 1 }, f.ctx);
    vi.setSystemTime(Date.now() + 10000);
    const second = await f.service.describe(
      { canvas_id: h.canvas_id, limit: 1, cursor: first.next_cursor },
      f.ctx,
    );
    expect(second).toMatchObject({ returned: 1, totalCount: 2, has_more: false });
    expect(second.items[0]?.table_name).not.toBe(first.items[0]?.table_name);
  });

  it.each(['schema', 'lineage', 'added table'])(
    'rejects describe continuation after a change to %s',
    async (change) => {
      const source = output(true);
      const h = await f.service.stageRelations(
        {},
        source,
        [relation, { ...relation, relation: 'second' }],
        f.ctx,
      );
      const first = await f.service.describe({ canvas_id: h.canvas_id, limit: 1 }, f.ctx);
      if (change === 'schema') {
        const instance = await f.canvas.acquire(h.canvas_id, f.ctx);
        await instance.registerTable(h.table_name, [{ replacement: 1 }], {
          schema: [{ name: 'replacement', type: 'INTEGER', nullable: false }],
          ttlMs: 3600000,
        });
      } else if (change === 'lineage') {
        source.provenance.consistency = 'changed source revision';
      } else {
        await f.service.stageRelations({ canvas_id: h.canvas_id }, source, [relation], f.ctx);
      }
      await expect(
        f.service.describe({ canvas_id: h.canvas_id, limit: 1, cursor: first.next_cursor }, f.ctx),
      ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
    },
  );

  it('marks coverage incomplete when an earlier partition expires before the final partition', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    const source = (partition: number, final_partition: number | null) => ({
      ...output(),
      selection_partition: { selection_id: 'expiring', partition, final_partition },
    });
    const first = await f.service.stageRelations({}, source(0, null), [relation], f.ctx);
    vi.setSystemTime(now + 600000);
    await f.service.stageRelations({ canvas_id: first.canvas_id }, source(1, 1), [relation], f.ctx);
    vi.setSystemTime(now + 3600001);
    await f.registry.sweep();
    expect(
      await f.service.describe({ canvas_id: first.canvas_id, limit: 100 }, f.ctx),
    ).toMatchObject({
      selection_coverage: [
        {
          selection_id: 'expiring',
          partitions_present: [1],
          final_partition: 1,
          chain_complete: false,
        },
      ],
    });
  });
  it('derives contiguous atomic coverage from live lineage and snapshots it for SQL replay', async () => {
    const partition = (sequence: number, final: number | null = null) => ({
      ...output(),
      selection_partition: {
        selection_id: 'retrieval-a',
        partition: sequence,
        final_partition: final,
      },
    });
    const first = await f.service.stageRelations(
      {},
      partition(0),
      [relation, { ...relation, relation: 'companion', rows: [] }],
      f.ctx,
    );
    const duplicate = await f.service.stageRelations(
      { canvas_id: first.canvas_id },
      partition(0),
      [relation, { ...relation, relation: 'companion', rows: [] }],
      f.ctx,
    );
    const final = await f.service.stageRelations(
      { canvas_id: first.canvas_id },
      partition(2, 2),
      [relation, { ...relation, relation: 'companion', rows: [] }],
      f.ctx,
    );
    const describe = () => f.service.describe({ canvas_id: first.canvas_id, limit: 1 }, f.ctx);
    expect(await describe()).toMatchObject({
      selection_coverage: [
        {
          selection_id: 'retrieval-a',
          partitions_present: [0, 2],
          final_partition: 2,
          chain_complete: false,
        },
      ],
    });
    await f.service.stageRelations(
      { canvas_id: first.canvas_id },
      partition(1),
      [relation, { ...relation, relation: 'companion', rows: [] }],
      f.ctx,
    );
    const complete = [
      {
        selection_id: 'retrieval-a',
        partitions_present: [0, 1, 2],
        final_partition: 2,
        chain_complete: true,
      },
    ];
    expect(await describe()).toMatchObject({ selection_coverage: complete });
    const sql = 'SELECT 1 AS i UNION ALL SELECT 2';
    const retained = await query(first.canvas_id, sql, { limit: 1 });
    expect(retained).toMatchObject({
      selection_coverage: complete,
      source_complete: false,
      truncated: false,
    });
    const instance = await f.canvas.acquire(first.canvas_id, f.ctx);
    const companions = (await instance.describe()).filter((table) =>
      table.name.startsWith('companion_'),
    );
    const firstCompanion = companions.find((table) =>
      table.name.endsWith(first.table_name.split('_').at(-1)!),
    );
    const duplicateCompanion = companions.find((table) =>
      table.name.endsWith(duplicate.table_name.split('_').at(-1)!),
    );
    if (!firstCompanion || !duplicateCompanion) throw new Error('Missing atomic companion');
    await f.service.drop({ canvas_id: first.canvas_id, table_name: firstCompanion.name }, f.ctx);
    expect(await describe()).toMatchObject({ selection_coverage: complete });
    await f.service.drop(
      { canvas_id: first.canvas_id, table_name: duplicateCompanion.name },
      f.ctx,
    );
    expect(await describe()).toMatchObject({
      selection_coverage: [{ partitions_present: [1, 2], chain_complete: false }],
    });
    expect(await query(first.canvas_id, sql, { cursor: retained.next_cursor })).toMatchObject({
      selection_coverage: complete,
      items: [{ i: 2 }],
    });
    const suffix = final.table_name.split('_').at(-1)!;
    for (const table of await instance.describe())
      if (table.name.endsWith(suffix))
        await f.service.drop({ canvas_id: first.canvas_id, table_name: table.name }, f.ctx);
    expect(await describe()).toMatchObject({
      selection_coverage: [{ partitions_present: [1], final_partition: 2, chain_complete: false }],
    });
  });
  it('groups a table schema once and counts whole tables', async () => {
    const h = await stage();
    const page = await f.service.describe({ canvas_id: h.canvas_id, limit: 100 }, f.ctx);
    expect(page).toMatchObject({ returned: 1, totalCount: 1, has_more: false });
    expect(page.items[0]).toMatchObject({ columns: relation.schema, row_count: 2 });
  });
  it('does not exhaust continuation capacity by replaying a SQL position', async () => {
    const h = await stage();
    const sql = 'SELECT 0 AS value UNION ALL SELECT 1 UNION ALL SELECT 2';
    const first = await query(h.canvas_id, sql, { limit: 1 });
    const instance = await f.canvas.acquire(h.canvas_id, f.ctx);
    const tables = await instance.describe();
    vi.spyOn(instance, 'describe').mockResolvedValue(tables);
    vi.spyOn(f.canvas, 'acquire').mockResolvedValue(instance);
    const started = performance.now();
    const cpu = process.cpuUsage();
    for (let i = 0; i < 4100; i++) {
      const replay = await query(h.canvas_id, sql, { cursor: first.next_cursor, limit: 1 });
      expect(replay.items).toEqual([{ value: 1 }]);
    }
    console.info('4100 retained SQL replays:', {
      elapsedMs: performance.now() - started,
      cpu: process.cpuUsage(cpu),
    });
  });
  it('pages all live tables including empty schemas, rejects changed metadata, and clamps table limits', async () => {
    const h = await f.service.stageRelations(
      {},
      output(true),
      Array.from({ length: 16 }, (_, index) => ({
        ...relation,
        relation: `partition_${index}`,
        rows: index % 2 ? [] : relation.rows,
      })),
      f.ctx,
    );
    let cursor: string | undefined;
    const names: unknown[] = [];
    do {
      const page = await f.service.describe({ canvas_id: h.canvas_id, limit: 3, cursor }, f.ctx);
      expect(page.totalCount).toBe(16);
      expect(
        page.items.every((item) => Array.isArray(item.columns) && item.columns.length === 2),
      ).toBe(true);
      names.push(...page.items.map((item) => item.table_name));
      cursor = page.next_cursor;
    } while (cursor);
    expect(new Set(names).size).toBe(16);
    expect(await f.service.describe({ canvas_id: h.canvas_id, limit: 501 }, f.ctx)).toMatchObject({
      totalCount: 16,
      returned: 16,
      has_more: false,
      notices: ['Requested limit 501 exceeds the maximum 500; clamped to 500.'],
    });
    const first = await f.service.describe({ canvas_id: h.canvas_id, limit: 1 }, f.ctx);
    await f.service.drop(h, f.ctx);
    await expect(
      f.service.describe({ canvas_id: h.canvas_id, limit: 1, cursor: first.next_cursor }, f.ctx),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
    await expect(
      f.service.describe(
        { canvas_id: h.canvas_id, limit: 1, cursor: 'eyJvZmZzZXQiOjk5OTk5fQ' },
        f.ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
  });
  it('rejects forged and foreign SQL positions while retaining whole-row replay after drop', async () => {
    const h = await stage();
    const foreign = await stage();
    const value = '💧'.repeat(4000);
    const sql = `SELECT '${value}' AS value UNION ALL SELECT 'last'`;
    const first = await query(h.canvas_id, sql, { limit: 1 });
    expect(first.items).toEqual([{ value }]);
    await f.service.drop(h, f.ctx);
    const next = await query(h.canvas_id, sql, { cursor: first.next_cursor });
    expect(next.items).toEqual([{ value: 'last' }]);
    expect(await query(h.canvas_id, sql, { cursor: first.next_cursor })).toEqual(next);
    await expect(
      query(h.canvas_id, sql, { cursor: `${first.next_cursor}x` }),
    ).rejects.toMatchObject({
      data: { reason: 'cursor_invalid' },
    });
    await expect(
      query(foreign.canvas_id, sql, { cursor: first.next_cursor }),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
    await expect(
      f.service.query(
        { canvas_id: h.canvas_id, sql, cursor: first.next_cursor, limit: 10 },
        createMockContext({ tenantId: 'foreign' }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'canvas_not_found' } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 900001);
    await expect(query(h.canvas_id, sql, { cursor: first.next_cursor })).rejects.toMatchObject({
      data: { reason: 'cursor_invalid' },
    });
  });
  it('replays an immutable SQL position without advancing it', async () => {
    const h = await stage();
    const sql = `SELECT * FROM ${h.table_name} ORDER BY sampled`;
    const first = await query(h.canvas_id, sql, { limit: 1 });
    const next = await query(h.canvas_id, sql, { cursor: first.next_cursor });
    expect(next.items).toEqual([{ value: 1.25, sampled: '2026-01-02' }]);
    expect((await query(h.canvas_id, sql, { cursor: first.next_cursor })).items).toEqual(
      next.items,
    );
  });
  it('uses declared SDWIS schemas for all-null numeric columns and sparse dates', async () => {
    const h = await f.service.stage(
      {
        input: {},
        output: output(true),
        table: 'violation',
        rows: [
          {
            pwsid: 'WA0000001',
            violation_id: 'v1',
            viol_measure: null,
            compl_per_begin_date: null,
          },
        ],
      },
      f.ctx,
    );
    const metadata = await f.service.describe({ canvas_id: h.canvas_id, limit: 100 }, f.ctx);
    const columns = metadata.items.flatMap((item) => item.columns);
    let cursor = metadata.next_cursor;
    while (cursor) {
      const page = await f.service.describe({ canvas_id: h.canvas_id, limit: 100, cursor }, f.ctx);
      columns.push(...page.items.flatMap((item) => item.columns));
      cursor = page.next_cursor;
    }
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'viol_measure', type: 'DOUBLE' }),
        expect.objectContaining({ name: 'compl_per_begin_date', type: 'DATE' }),
      ]),
    );
    expect(
      (await query(h.canvas_id, `SELECT viol_measure, compl_per_begin_date FROM ${h.table_name}`))
        .items,
    ).toEqual([{ viol_measure: null, compl_per_begin_date: null }]);
  });
  it('preserves typed nulls, dates, partial lineage and idempotent removal without state writes', async () => {
    const write = vi.spyOn(f.ctx.state, 'set');
    const handle = await stage();
    expect(handle).toMatchObject({
      row_count: 2,
      source_complete: false,
      next_cursor: 'source-next',
      pointer: CANVAS_POINTER,
    });
    const metadata = await f.service.describe({ canvas_id: handle.canvas_id, limit: 100 }, f.ctx);
    expect(metadata.items.flatMap((item) => item.columns)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'value', type: 'DOUBLE' }),
        expect.objectContaining({ name: 'sampled', type: 'DATE' }),
      ]),
    );
    expect(
      (await query(handle.canvas_id, `SELECT * FROM ${handle.table_name} ORDER BY sampled`)).items,
    ).toEqual([
      { value: null, sampled: '2026-01-01' },
      { value: 1.25, sampled: '2026-01-02' },
    ]);
    expect(
      await query(handle.canvas_id, `SELECT count(*) AS n FROM ${handle.table_name}`),
    ).toMatchObject({ items: [{ n: '2' }], source_complete: false, truncated: false });
    expect(await f.service.drop(handle, f.ctx)).toMatchObject({
      dropped: true,
      remaining_tables: 0,
    });
    expect(await f.service.drop(handle, f.ctx)).toMatchObject({ dropped: false });
    await expect(
      query(handle.canvas_id, `SELECT * FROM ${handle.table_name}`),
    ).rejects.toMatchObject({ data: { reason: 'missing_table' } });
    expect(write).not.toHaveBeenCalled();
  });

  it('isolates two default-tenant capabilities and rejects unknown or foreign capabilities', async () => {
    const first = await stage();
    const second = await stage();
    expect(first.canvas_id).not.toBe(second.canvas_id);
    expect(
      (await f.service.describe({ canvas_id: second.canvas_id, limit: 100 }, f.ctx)).items.every(
        (item) => item.table_name === second.table_name,
      ),
    ).toBe(true);
    await expect(
      query(second.canvas_id, `SELECT * FROM ${first.table_name}`),
    ).rejects.toMatchObject({ data: { reason: 'missing_table' } });
    await expect(
      f.service.describe(
        { canvas_id: first.canvas_id, limit: 10 },
        createMockContext({ tenantId: 'foreign' }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'canvas_not_found' } });
    await expect(query('abcdefghij', 'SELECT 1')).rejects.toMatchObject({
      data: { reason: 'canvas_not_found' },
    });
    expect(
      await f.service.drop({ canvas_id: 'abcdefghij', table_name: 'gone' }, f.ctx),
    ).toMatchObject({ dropped: false });
  });

  it.each([
    'DELETE FROM missing',
    'SELECT 1; SELECT 2',
    "SELECT * FROM read_csv('/etc/passwd')",
    "SELECT * FROM read_parquet('https://example.com/x')",
    'SELECT * FROM information_schema.tables',
    "SELECT current_setting('temp_directory')",
  ])('refuses SQL outside the analytical boundary: %s', async (sql) => {
    const handle = await stage();
    await expect(query(handle.canvas_id, sql)).rejects.toMatchObject({
      data: { reason: expect.any(String) },
    });
    expect((await query(handle.canvas_id, 'SELECT 1 AS ok')).items).toEqual([{ ok: 1 }]);
  });

  it('distinguishes binder and conversion failures', async () => {
    const h = await stage();
    await expect(query(h.canvas_id, `SELECT absent FROM ${h.table_name}`)).rejects.toMatchObject({
      data: { reason: 'invalid_sql' },
    });
    await expect(query(h.canvas_id, "SELECT CAST('bad' AS DOUBLE)")).rejects.toMatchObject({
      data: { reason: 'sql_execution_error' },
    });
  });

  it('pages retained whole rows immutably after the underlying table is dropped', async () => {
    const h = await stage();
    const sql = `SELECT * FROM ${h.table_name} ORDER BY sampled`;
    const first = await query(h.canvas_id, sql, { limit: 1 });
    expect(first).toMatchObject({ returned: 1, has_more: true });
    await f.service.drop(h, f.ctx);
    const last = await query(h.canvas_id, sql, { cursor: first.next_cursor, limit: 1 });
    expect(last).toMatchObject({
      items: [{ value: 1.25, sampled: '2026-01-02' }],
      returned: 1,
      has_more: false,
    });
    await expect(
      query(h.canvas_id, 'SELECT 2', { cursor: first.next_cursor }),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
  });

  it('preserves oversized Unicode rows as complete items', async () => {
    const h = await stage();
    const value = '💧"\\\n'.repeat(1800);
    const sql = `SELECT '${value.replaceAll("'", "''")}' AS value`;
    const page = await query(h.canvas_id, sql);
    expect(page.items).toEqual([{ value }]);
    expect(page).toMatchObject({ returned: 1, has_more: false });
  });

  it('reserves simultaneous mint slots atomically and frees expired capacity', async () => {
    const results = await Promise.allSettled(Array.from({ length: 9 }, stage));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          data: expect.objectContaining({ reason: 'canvas_capacity_exhausted' }),
        }),
      }),
    ]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3600001);
    expect(await stage()).toMatchObject({ row_count: 2 });
  });

  it('rolls back companion registration and retains previous successful partitions', async () => {
    const h = await stage();
    await expect(
      f.service.stageRelations(
        { canvas_id: h.canvas_id },
        output(),
        [relation, { ...relation, relation: 'invalid-name' }],
        f.ctx,
      ),
    ).rejects.toThrow();
    expect(
      (await f.service.describe({ canvas_id: h.canvas_id, limit: 100 }, f.ctx)).items.map(
        (item) => item.table_name,
      ),
    ).toEqual([h.table_name]);
  });

  it('caps table admission and query rows while preserving incomplete aggregate lineage', async () => {
    const h = await stage();
    await expect(
      f.service.stageRelations(
        { canvas_id: h.canvas_id },
        output(),
        Array.from({ length: 16 }, () => relation),
        f.ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    const large = await f.service.stageRelations(
      { canvas_id: h.canvas_id },
      output(),
      [
        {
          relation: 'many',
          rows: Array.from({ length: 25001 }, (_, i) => ({ i })),
          schema: [{ name: 'i', type: 'INTEGER', nullable: false }],
        },
      ],
      f.ctx,
    );
    const page = await query(h.canvas_id, `SELECT i FROM ${large.table_name}`);
    expect(page).toMatchObject({
      row_count: 25000,
      truncated: true,
      returned: 10,
      source_complete: false,
      has_more: true,
    });
    expect((await query(h.canvas_id, 'SELECT 1 WHERE false')).items).toEqual([]);
    expect(await query(h.canvas_id, `SELECT * FROM ${h.table_name} OFFSET 10`)).toMatchObject({
      items: [],
      returned: 0,
      row_count: 0,
      has_more: false,
      truncated: false,
    });
  });

  it('pages describe metadata and binds its cursor to the exact table selection', async () => {
    const h = await stage();
    await f.service.stageRelations({ canvas_id: h.canvas_id }, output(), [relation], f.ctx);
    const first = await f.service.describe({ canvas_id: h.canvas_id, limit: 1 }, f.ctx);
    const second = await f.service.describe(
      { canvas_id: h.canvas_id, limit: 1, cursor: first.next_cursor },
      f.ctx,
    );
    expect(first).toMatchObject({ returned: 1, has_more: true });
    expect(second).toMatchObject({ returned: 1, has_more: false });
    expect(second.items).not.toEqual(first.items);
    await expect(
      f.service.describe(
        { canvas_id: h.canvas_id, table_name: h.table_name, limit: 1, cursor: first.next_cursor },
        f.ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
    expect(
      await f.service.describe({ canvas_id: h.canvas_id, table_name: 'absent', limit: 10 }, f.ctx),
    ).toMatchObject({ items: [], returned: 0, has_more: false });
  });

  it('expires retained cursors before the source table and expires the capability later', async () => {
    const h = await stage();
    const sql = `SELECT * FROM ${h.table_name}`;
    const first = await query(h.canvas_id, sql, { limit: 1 });
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now + 900001);
    await expect(query(h.canvas_id, sql, { cursor: first.next_cursor })).rejects.toMatchObject({
      data: { reason: 'cursor_invalid' },
    });
    expect((await query(h.canvas_id, sql)).returned).toBe(2);
    vi.setSystemTime(now + 7200001);
    await expect(query(h.canvas_id, sql)).rejects.toMatchObject({
      data: { reason: 'canvas_not_found' },
    });
    expect(await f.service.drop(h, f.ctx)).toMatchObject({ dropped: false });
  });

  it('bounds the per-canvas queue and removes cancellation without blocking its successors', async () => {
    const h = await stage();
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const jobs = controllers.map((controller) =>
      f.service.query(
        { canvas_id: h.canvas_id, sql: 'SELECT 1 AS value', limit: 10 },
        createMockContext({ signal: controller.signal }),
      ),
    );
    const settled = Promise.allSettled(jobs);
    controllers[1]?.abort(new DOMException('Queued fixture cancelled', 'AbortError'));
    const results = await settled;
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { name: 'AbortError', message: 'Queued fixture cancelled' },
    });
    expect(results[5]).toMatchObject({
      status: 'rejected',
      reason: { data: { reason: 'canvas_capacity_exhausted' } },
    });
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(4);
    expect((await query(h.canvas_id, 'SELECT 2 AS value')).items).toEqual([{ value: 2 }]);
  });

  it('rethrows cancellation after admission and leaves the capability usable', async () => {
    const h = await stage();
    const controller = new AbortController();
    const pending = f.service.query(
      { canvas_id: h.canvas_id, sql: 'SELECT 1', limit: 10 },
      createMockContext({ signal: controller.signal }),
    );
    controller.abort(new DOMException('Active fixture cancelled', 'AbortError'));
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Active fixture cancelled',
    });
    expect((await query(h.canvas_id, 'SELECT 1 AS value')).items).toEqual([{ value: 1 }]);
  });

  it('rejects oversized source admission before registration and bounds retained query entries', async () => {
    const h = await stage();
    await expect(
      f.service.stageRelations(
        { canvas_id: h.canvas_id },
        output(),
        [
          {
            ...relation,
            rows: Array.from({ length: 250001 }, () => ({ value: null, sampled: null })),
          },
        ],
        f.ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    for (let i = 0; i < 16; i++) await query(h.canvas_id, `SELECT ${i} AS value`);
    await expect(query(h.canvas_id, 'SELECT 17 AS value')).rejects.toMatchObject({
      data: { reason: 'query_capacity_exhausted' },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 900001);
    expect((await query(h.canvas_id, 'SELECT 17 AS value')).items).toEqual([{ value: 17 }]);
  });
});
