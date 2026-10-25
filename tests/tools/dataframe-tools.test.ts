/** @fileoverview Production dataframe schema, handler and both consumption surfaces over DuckDB. */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import {
  CANVAS_POINTER,
  getCanvasService,
  initCanvasService,
} from '@/services/dataframe/canvas-service.js';
import { fixture, output } from '../services/dataframe/canvas-fixtures.js';
import { expectParity } from '../services/sdwis/sdwis-fixtures.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
  initCanvasService(f.canvas, 25000);
});
afterEach(async () => {
  initCanvasService(undefined, 25000);
  await f.canvas.shutdown(f.ctx);
});
function success(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  expectParity(result);
  expect(result.structuredContent).toMatchObject({ pointer: CANVAS_POINTER });
  return result.structuredContent;
}
describe('dataframe tool contracts', () => {
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
