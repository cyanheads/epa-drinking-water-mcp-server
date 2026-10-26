/** @fileoverview Production dataframe schema, handler and both consumption surfaces over DuckDB. */
import { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireBytes } from '@/domain/source-output.js';
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
import { expectParity, renderedText } from '../services/sdwis/sdwis-fixtures.js';
import { archive, occurrence, relations } from '../services/ucmr5/ucmr5-fixtures.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
  initCanvasService(f.canvas, 25000);
});
afterEach(async () => {
  vi.useRealTimers();
  initCanvasService(undefined, 25000);
  await f.canvas.shutdown(f.ctx);
});
function success(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  expectParity(result);
  expect(result.structuredContent).toMatchObject({ pointer: CANVAS_POINTER });
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}
describe('dataframe tool contracts', () => {
  it('keeps oversized-row recovery bounded for long Unicode SQL and resumes with the original SQL', async () => {
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
    const failure = await runToolContract(dataframeQueryTool, { canvas_id: h.canvas_id, sql });
    expect(failure).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'item_too_large' } } },
    });
    expect(Buffer.byteLength(JSON.stringify(failure))).toBeLessThan(24000);
    console.info('Long SQL recovery wire bytes:', Buffer.byteLength(JSON.stringify(failure)));
    const details = (
      failure.structuredContent as {
        error: { data: { record_cursor: string; follow_up: Record<string, unknown> } };
      }
    ).error;
    expect(details.data.follow_up).toEqual({
      tool: 'sdwis_dataframe_query',
      canvas_id: h.canvas_id,
      view: 'text',
      record_cursor: details.data.record_cursor,
    });
    expect(JSON.stringify(failure.content)).toContain('same sql');
    let record_cursor: string | undefined = details.data.record_cursor;
    let text = '';
    while (record_cursor) {
      const response = await runToolContract(dataframeQueryTool, {
        canvas_id: h.canvas_id,
        sql,
        view: 'text',
        record_cursor,
      });
      const page = success(response);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(24000);
      text += page?.text;
      record_cursor = page?.next_cursor as string | undefined;
    }
    expect(JSON.parse(text)).toEqual({ value: 'x'.repeat(40000) });
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
        { dataset: 'ucmr5', pwsid: 'WA1234567', stage: true, limit: 10, view: 'records' },
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
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(24000);
      console.info('UCMR grouped describe wire bytes:', Buffer.byteLength(JSON.stringify(result)));
    } finally {
      await ucmr.close();
    }
  });

  it('reconstructs complete oversized Unicode table metadata through executable text recovery', async () => {
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
    const failure = await runToolContract(dataframeDescribeTool, args);
    expect(failure).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'item_too_large' } } },
    });
    const error = (
      failure.structuredContent as {
        error: { data: { record_cursor: string; follow_up: Record<string, unknown> } };
      }
    ).error;
    expect(
      failure.content
        .filter((block) => block.type === 'text')
        .map((block) => renderedText(block.text))
        .join('\n'),
    ).toContain(error.data.record_cursor);
    expect(error.data.follow_up).toMatchObject({
      tool: 'sdwis_dataframe_describe',
      ...args,
      view: 'text',
    });
    let cursor: string | undefined = error.data.record_cursor;
    let text = '';
    let offset = 0;
    while (cursor) {
      const result = await runToolContract(dataframeDescribeTool, {
        ...args,
        view: 'text',
        record_cursor: cursor,
      });
      const page = success(result);
      expect(page?.offset).toBe(offset);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(24000);
      text += page?.text;
      offset += Array.from(String(page?.text)).length;
      cursor = page?.next_cursor as string | undefined;
    }
    expect(JSON.parse(text)).toEqual({
      table_name: h.table_name,
      row_count: 0,
      expires_at: h.expires_at,
      columns: [{ name: 'value', type: 'VARCHAR', nullable: true }],
      source_complete: false,
      provenance: source.provenance,
      effective_filters: source.effective_filters,
      relation: 'large',
      next_cursor: 'source-next',
    });
    for (const invalid of [
      { ...args, cursor: error.data.record_cursor },
      { ...args, view: 'text', record_cursor: `${error.data.record_cursor}x` },
      { canvas_id: h.canvas_id, view: 'text', record_cursor: error.data.record_cursor },
      { ...args, view: 'text' },
    ] as const) {
      const result = await runToolContract(dataframeDescribeTool, invalid);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason: 'cursor_invalid' } } },
      });
      expect(JSON.stringify(result.content)).toContain('cursor_invalid');
    }
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 900001);
    expect(
      await runToolContract(dataframeDescribeTool, {
        ...args,
        view: 'text',
        record_cursor: error.data.record_cursor,
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'cursor_invalid' } } },
    });
    expect(wireBytes(JSON.parse(text))).toBeGreaterThan(24000);
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
