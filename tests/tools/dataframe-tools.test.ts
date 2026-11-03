/** @fileoverview Production dataframe schema, handler and both consumption surfaces over DuckDB. */
import { z } from '@cyanheads/mcp-ts-core';
import { databaseError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import * as serverConfig from '@/config/server-config.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import {
  CANVAS_POINTER,
  getCanvasService,
  initCanvasService,
} from '@/services/dataframe/canvas-service.js';
import { createUcmrProducer } from '@/services/ucmr5/ucmr5-producer.js';
import { Ucmr5Service } from '@/services/ucmr5/ucmr5-service.js';
import { fixture, output } from '../services/dataframe/canvas-fixtures.js';
import { expectParity } from '../services/sdwis/sdwis-fixtures.js';
import { archive, occurrence, relations } from '../services/ucmr5/ucmr5-fixtures.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
  initCanvasService(f.canvas, 25000);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  initCanvasService(undefined, 25000);
  await f.canvas.shutdown(f.ctx);
});
function success(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expectParity(result);
  expect(result.structuredContent).toMatchObject({ pointer: CANVAS_POINTER });
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}
describe('dataframe tool contracts', () => {
  it.each([true, false])(
    'pages whole rows at the 500 limit with clamp mode %s',
    async (clampLimits) => {
      vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
        clampLimits,
        dataframeDropEnabled: false,
      });
      if (!clampLimits)
        for (const tool of [dataframeDescribeTool, dataframeQueryTool])
          expect(z.toJSONSchema(tool.input)).toMatchObject({
            properties: { limit: { maximum: 500 } },
          });
      const h = await getCanvasService().stageRelations(
        {},
        output(true),
        [
          {
            relation: 'pages',
            rows: Array.from({ length: 502 }, (_, n) => ({ n })),
            schema: [{ name: 'n', type: 'INTEGER', nullable: false }],
          },
        ],
        f.ctx,
      );
      const instance = await f.canvas.acquire(h.canvas_id, f.ctx);
      vi.spyOn(f.canvas, 'acquire').mockResolvedValue(instance);
      const execute = vi.spyOn(instance, 'query');
      const sql = `SELECT n FROM ${h.table_name} ORDER BY n`;
      const first = success(
        await runToolContract(dataframeQueryTool, { canvas_id: h.canvas_id, sql, limit: 500 }),
      );
      expect(first.items).toEqual(Array.from({ length: 500 }, (_, n) => ({ n })));
      expect(first).toMatchObject({
        returned: 500,
        row_count: 502,
        has_more: true,
        truncated: false,
      });
      const next = success(
        await runToolContract(dataframeQueryTool, {
          canvas_id: h.canvas_id,
          sql,
          limit: 500,
          cursor: first.next_cursor,
        }),
      );
      expect(next).toMatchObject({ items: [{ n: 500 }, { n: 501 }], returned: 2, has_more: false });
      expect(execute).toHaveBeenCalledTimes(1);
      await getCanvasService().stageRelations(
        { canvas_id: h.canvas_id },
        output(true),
        Array.from({ length: 15 }, (_, index) => ({
          relation: `empty_${index}`,
          rows: [],
          schema: [{ name: 'n', type: 'INTEGER' as const, nullable: false }],
        })),
        f.ctx,
      );
      const describe = success(
        await runToolContract(dataframeDescribeTool, { canvas_id: h.canvas_id, limit: 500 }),
      );
      expect(describe).toMatchObject({ returned: 16, totalCount: 16, has_more: false });
      for (const [tool, args] of [
        [dataframeQueryTool, { canvas_id: h.canvas_id, sql, limit: 501 }],
        [dataframeDescribeTool, { canvas_id: h.canvas_id, limit: 501 }],
      ] as const) {
        const result = await runToolContract(tool, args);
        if (clampLimits)
          expect(success(result).notices).toContain(
            'Requested limit 501 exceeds the maximum 500; clamped to 500.',
          );
        else {
          expect(result).toMatchObject({
            isError: true,
            structuredContent: { error: { code: -32602 } },
          });
          expect(JSON.stringify(result.content)).toContain('500');
        }
      }
    },
  );

  it('returns oversized Unicode SQL rows whole without recovery fields', async () => {
    const h = await getCanvasService().stageRelations(
      {},
      output(true),
      [
        {
          relation: 'whole',
          rows: [],
          schema: [{ name: 'value', type: 'VARCHAR', nullable: true }],
        },
      ],
      f.ctx,
    );
    const value = '💧"\\\n'.repeat(1800);
    const sql = `SELECT '${value.replaceAll("'", "''")}' AS value`;
    const result = await runToolContract(dataframeQueryTool, { canvas_id: h.canvas_id, sql });
    const data = success(result);
    expect(data.items).toEqual([{ value }]);
    expect(data).toMatchObject({ returned: 1, has_more: false });
    for (const field of ['phase', 'text', 'encoding', 'record_identity', 'offset', 'record_cursor'])
      expect(data).not.toHaveProperty(field);
    expect(JSON.stringify(result)).not.toContain('follow_up');
  });

  it('omits unclassified engine details from both error surfaces', async () => {
    const staged = await getCanvasService().stageRelations(
      {},
      output(true),
      [
        {
          relation: 'errors',
          rows: [],
          schema: [{ name: 'value', type: 'VARCHAR', nullable: true }],
        },
      ],
      f.ctx,
    );
    const instance = await f.canvas.acquire(staged.canvas_id, f.ctx);
    vi.spyOn(f.canvas, 'acquire').mockResolvedValue(instance);
    vi.spyOn(instance, 'query').mockRejectedValue(
      databaseError('INTERNAL_CANARY', {
        reason: 'invalid_sql',
        binderMessage: 'SECRET_CANARY',
        tableName: 'HOST_CANARY',
      }),
    );
    const result = await runToolContract(dataframeQueryTool, {
      canvas_id: staged.canvas_id,
      sql: 'SELECT 1',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: -32010, data: { reason: 'invalid_sql' } } },
    });
    for (const canary of ['INTERNAL_CANARY', 'SECRET_CANARY', 'HOST_CANARY'])
      expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result.content)).toContain('sdwis_dataframe_query');
  });

  it('names native SQL faults on both surfaces while retaining safe structured diagnostics', async () => {
    const h = await getCanvasService().stageRelations(
      {},
      output(true),
      [
        {
          relation: 'diagnostics',
          rows: [{ value: '水_CANARY' }],
          schema: [{ name: 'value', type: 'VARCHAR', nullable: true }],
        },
      ],
      f.ctx,
    );
    for (const [sql, reason, fault, details] of [
      [
        `SELECT nope FROM ${h.table_name}`,
        'invalid_sql',
        'nope',
        { statementType: 'UNKNOWN', binderMessage: expect.stringContaining('nope') },
      ],
      [
        `SELECT CAST(value AS INTEGER) FROM ${h.table_name}`,
        'sql_execution_error',
        '水_CANARY',
        {},
      ],
      [
        "SELECT * FROM read_csv('/unread/file.csv')",
        'denied_function',
        'read_csv',
        { function: 'read_csv' },
      ],
      ['SELECT 1; SELECT 2', 'multi_statement', 'exactly one SQL statement', { statementCount: 2 }],
      [
        'SELECT * FROM information_schema.tables',
        'system_catalog_access',
        'information_schema',
        { catalog: 'information_schema' },
      ],
    ] as const) {
      const result = await runToolContract(dataframeQueryTool, { canvas_id: h.canvas_id, sql });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            message: expect.stringContaining(fault),
            data: {
              reason,
              ...details,
              recovery: { hint: expect.stringContaining('sdwis_dataframe_describe') },
            },
          },
        },
      });
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(fault);
      expect(text).toContain(reason);
      expect(text).toContain('sdwis_dataframe_query');
      const structured = result.structuredContent as { error: { data: Record<string, unknown> } };
      expect(structured.error.data.recovery).not.toHaveProperty('sql');
      expect(structured.error).not.toHaveProperty('cause');
      expect(structured.error).not.toHaveProperty('stack');
    }
    const path = '/tmp/epa-drinking-water-test-canvas';
    const redacted = await runToolContract(dataframeQueryTool, {
      canvas_id: h.canvas_id,
      sql: `SELECT "${path}/HOST_CANARY" FROM ${h.table_name}`,
    });
    expect(JSON.stringify(redacted)).not.toContain(path);
    expect(JSON.stringify(redacted)).toContain('[path]/HOST_CANARY');
  });

  it('continues native describe records after queried-table TTL extension on both surfaces', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    const h = await getCanvasService().stageRelations(
      {},
      output(true),
      ['a', 'b', 'c'].map((relation) => ({
        relation,
        rows: [],
        schema: [{ name: 'value', type: 'VARCHAR', nullable: true }],
      })),
      f.ctx,
    );
    const instance = await f.canvas.acquire(h.canvas_id, f.ctx);
    const expectedTables = (await instance.describe()).map((table) => table.name);
    const first = success(
      await runToolContract(dataframeDescribeTool, { canvas_id: h.canvas_id, limit: 1 }),
    );
    const firstItem = (first.items as { table_name: string; expires_at: string }[])[0];
    assert(firstItem);
    vi.setSystemTime(now + 10000);
    success(
      await runToolContract(dataframeQueryTool, {
        canvas_id: h.canvas_id,
        sql: `SELECT * FROM ${firstItem.table_name}`,
      }),
    );
    const current = success(
      await runToolContract(dataframeDescribeTool, {
        canvas_id: h.canvas_id,
        table_name: firstItem.table_name,
      }),
    );
    expect((current.items as { expires_at: string }[])[0]?.expires_at).toBe(
      new Date(now + 3610000).toISOString(),
    );
    const second = success(
      await runToolContract(dataframeDescribeTool, {
        canvas_id: h.canvas_id,
        limit: 1,
        cursor: first.next_cursor,
      }),
    );
    expect(second).toMatchObject({ returned: 1, totalCount: 3, has_more: true });
    vi.setSystemTime(now + 20000);
    const third = success(
      await runToolContract(dataframeDescribeTool, {
        canvas_id: h.canvas_id,
        limit: 1,
        cursor: second.next_cursor,
      }),
    );
    expect(third).toMatchObject({ returned: 1, totalCount: 3, has_more: false });
    expect([first.items, second.items, third.items].flat()).toEqual(
      expectedTables.map((table_name) => expect.objectContaining({ table_name })),
    );
    vi.setSystemTime(now + 900000);
    const expired = await runToolContract(dataframeDescribeTool, {
      canvas_id: h.canvas_id,
      limit: 1,
      cursor: second.next_cursor,
    });
    expect(expired).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'cursor_invalid' } } },
    });
    expect(JSON.stringify(expired.content)).toContain('cursor_invalid');
  });

  it('returns whole rows for long Unicode SQL and never duplicates SQL in recovery guidance', async () => {
    const h = await getCanvasService().stageRelations(
      {},
      output(true),
      [
        {
          relation: 'results',
          rows: [],
          schema: [{ name: 'value', type: 'VARCHAR', nullable: true }],
        },
      ],
      f.ctx,
    );
    const sql = `SELECT repeat('x', 40000) AS value /*${'水'.repeat(19000)}*/`;
    const response = await runToolContract(dataframeQueryTool, { canvas_id: h.canvas_id, sql });
    expect(success(response).items).toEqual([{ value: 'x'.repeat(40000) }]);
    const invalidSql = `SELECT absent FROM ${h.table_name} /*${'水'.repeat(19000)}*/`;
    const failure = await runToolContract(dataframeQueryTool, {
      canvas_id: h.canvas_id,
      sql: invalidSql,
    });
    expect(failure).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'invalid_sql' } } },
    });
    const error = (failure.structuredContent as { error: { data: Record<string, unknown> } }).error;
    expect(error.data).not.toHaveProperty('follow_up');
    expect(JSON.stringify(error.data.recovery)).not.toContain(invalidSql);
  });
  it('returns all 34 UCMR columns in three whole-table items on both surfaces', async () => {
    const ucmr = new Ucmr5Service({
      fetch: async () =>
        new Response(
          archive(
            relations([
              occurrence(),
              occurrence({ SampleID: 'S2' }),
              occurrence({ SampleID: 'S3' }),
            ]),
          ),
        ),
    });
    try {
      const staged = await createUcmrProducer(ucmr)(
        { dataset: 'ucmr5', pwsid: 'WA1234567', stage: true, limit: 10 },
        f.ctx,
      );
      assert(staged.dataset);
      const result = await runToolContract(dataframeDescribeTool, {
        canvas_id: staged.dataset.canvas_id,
        limit: 100,
      });
      const data = success(result);
      expect(data).toMatchObject({ returned: 3, totalCount: 3, has_more: false });
      const coverage = [
        {
          selection_id: staged.selection_partition?.selection_id,
          partitions_present: [0],
          final_partition: 0,
          chain_complete: true,
        },
      ];
      expect(data).toMatchObject({ selection_coverage: coverage });
      expect(
        success(
          await runToolContract(dataframeQueryTool, {
            canvas_id: staged.dataset.canvas_id,
            sql: 'SELECT 1 WHERE false',
          }),
        ),
      ).toMatchObject({
        selection_coverage: coverage,
        items: [],
        returned: 0,
      });
      const items = data?.items as { columns: unknown[]; provenance: unknown }[];
      expect(items.reduce((sum, item) => sum + item.columns.length, 0)).toBe(34);
      expect(items.every((item) => item.provenance !== undefined)).toBe(true);
    } finally {
      await ucmr.close();
    }
  });

  it('returns complete oversized Unicode table metadata on both surfaces', async () => {
    const source = output();
    source.provenance.caveats = ['💧"\\\n'.repeat(1800)];
    const h = await getCanvasService().stageRelations(
      {},
      source,
      [
        {
          relation: 'large',
          rows: [],
          schema: [{ name: 'value', type: 'VARCHAR', nullable: true }],
        },
      ],
      f.ctx,
    );
    const args = { canvas_id: h.canvas_id, table_name: h.table_name };
    const data = success(await runToolContract(dataframeDescribeTool, args));
    expect(data.items).toEqual([
      {
        table_name: h.table_name,
        row_count: 0,
        expires_at: h.expires_at,
        columns: [{ name: 'value', type: 'VARCHAR', nullable: true }],
        source_complete: false,
        provenance: source.provenance,
        effective_filters: source.effective_filters,
        relation: 'large',
        next_cursor: 'source-next',
      },
    ]);
    expect(data).toMatchObject({ returned: 1, totalCount: 1, has_more: false });
    for (const field of ['phase', 'text', 'encoding', 'record_identity', 'offset'])
      expect(data).not.toHaveProperty(field);
  });
  it('describes, queries and removes a real staged partition on both surfaces', async () => {
    const h = await getCanvasService().stageRelations(
      {},
      output(),
      [
        {
          relation: 'results',
          rows: [{ value: null }, { value: 4.5 }],
          schema: [{ name: 'value', type: 'DOUBLE', nullable: true }],
        },
      ],
      f.ctx,
    );
    expect(
      success(await runToolContract(dataframeDescribeTool, { canvas_id: h.canvas_id })),
    ).toMatchObject({ returned: 1, totalCount: 1 });
    expect(
      success(
        await runToolContract(dataframeQueryTool, {
          canvas_id: h.canvas_id,
          sql: `SELECT * FROM ${h.table_name} ORDER BY value NULLS FIRST`,
          limit: 101,
        }),
      ),
    ).toMatchObject({ items: [{ value: null }, { value: 4.5 }], source_complete: false });
    const dropInput = { canvas_id: h.canvas_id, table_name: h.table_name };
    expect(success(await runToolContract(dataframeDropTool, dropInput))).toMatchObject({
      dropped: true,
    });
    expect(success(await runToolContract(dataframeDropTool, dropInput))).toMatchObject({
      dropped: false,
    });
  });

  it('rejects missing capabilities, malformed IDs, oversized SQL and invalid paging before execution', async () => {
    expect(dataframeQueryTool.input.safeParse({ sql: 'SELECT 1' }).success).toBe(false);
    for (const args of [
      { canvas_id: 'bad', sql: 'SELECT 1' },
      { canvas_id: 'abcdefghij', sql: 'x'.repeat(20001) },
      { canvas_id: 'abcdefghij', sql: 'SELECT 1', limit: 0 },
    ]) {
      const result = await runToolContract(dataframeQueryTool, args);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: -32602 } },
      });
      expect(JSON.stringify(result.content)).toContain('sdwis_dataframe_query');
    }
    expect(dataframeDescribeTool.input.safeParse({}).success).toBe(false);
    expect(dataframeDropTool.input.safeParse({ canvas_id: 'abcdefghij' }).success).toBe(false);
  });

  it('rejects removed text inputs before acquiring a canvas', async () => {
    const acquire = vi.spyOn(f.canvas, 'acquire');
    for (const legacy of [
      { view: 'records' },
      { view: 'text' },
      { record_cursor: 'old-pointer' },
    ]) {
      for (const tool of [dataframeDescribeTool, dataframeQueryTool]) {
        const result = await runToolContract(tool, {
          canvas_id: 'abcdefghij',
          ...(tool === dataframeQueryTool ? { sql: 'SELECT 1' } : {}),
          ...legacy,
        });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: -32602 } },
        });
        expect(JSON.stringify(result.content)).toContain(tool.name);
      }
    }
    expect(acquire).not.toHaveBeenCalled();
  });

  it('returns disabled-canvas failures on both surfaces without fake handles', async () => {
    initCanvasService(undefined, 25000);
    for (const result of [
      await runToolContract(dataframeDescribeTool, { canvas_id: 'abcdefghij' }),
      await runToolContract(dataframeQueryTool, { canvas_id: 'abcdefghij', sql: 'SELECT 1' }),
      await runToolContract(dataframeDropTool, { canvas_id: 'abcdefghij', table_name: 'gone' }),
    ]) {
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason: 'canvas_disabled' } } },
      });
      expect(JSON.stringify(result.content)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect(JSON.stringify(result.content)).toContain('MCPB');
    }
  });

  it('carries missing-table and binder reasons onto the error text', async () => {
    const h = await getCanvasService().stageRelations(
      {},
      output(true),
      [
        {
          relation: 'results',
          rows: [{ value: 1 }],
          schema: [{ name: 'value', type: 'DOUBLE', nullable: true }],
        },
      ],
      f.ctx,
    );
    for (const [sql, reason] of [
      [`SELECT * FROM absent`, 'missing_table'],
      [`SELECT absent FROM ${h.table_name}`, 'invalid_sql'],
    ] as const) {
      const result = await runToolContract(dataframeQueryTool, { canvas_id: h.canvas_id, sql });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason } } },
      });
      expect(JSON.stringify(result.content)).toContain(reason);
      expect(JSON.stringify(result)).not.toContain('/tmp/');
    }
  });
});
