/** @fileoverview Actual entry-point setup, stdio protocol and native DuckDB with fake EPA I/O. */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectParity } from '../services/sdwis/sdwis-fixtures.js';

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(process.cwd(), '.canvas-runtime-test-'));
  await promisify(execFile)('bun', [
    'build',
    'src/index.ts',
    '--target=node',
    '--packages=external',
    '--outfile',
    join(directory, 'index.mjs'),
  ]);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each([
  { configured: undefined, cap: 10000 },
  { configured: '2', cap: 2 },
  { configured: '30000', cap: 25000 },
  { configured: 'invalid', cap: 0 },
])('queries through default setup with row ceiling $configured', async ({ configured, cap }) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_TRANSPORT_TYPE: 'stdio',
    CANVAS_PROVIDER_TYPE: 'duckdb',
    CANVAS_EXPORT_PATH: directory,
    CANVAS_TEMP_PATH: directory,
    STORAGE_PROVIDER_TYPE: 'in-memory',
    OTEL_ENABLED: 'false',
    MCP_LOG_LEVEL: 'error',
  };
  delete env.CANVAS_DEFAULT_ROW_LIMIT;
  if (configured !== undefined) env.CANVAS_DEFAULT_ROW_LIMIT = configured;
  const child = spawn(
    process.execPath,
    [
      '--import',
      join(process.cwd(), 'tests/services/dataframe/runtime-fetch.mjs'),
      join(directory, 'index.mjs'),
    ],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (typeof message.id === 'number') pending.get(message.id)?.resolve(message);
  });
  child.on('exit', () => {
    for (const request of pending.values()) request.reject(new Error(stderr || 'Runtime exited'));
  });
  let id = 0;
  const request = async (method: string, params: unknown) => {
    const requestId = ++id;
    const signal = AbortSignal.timeout(15000);
    const abort = () =>
      pending.get(requestId)?.reject(new Error(`Timed out: ${method}; ${stderr}`));
    try {
      return await new Promise<unknown>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        signal.addEventListener('abort', abort, { once: true });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      });
    } finally {
      signal.removeEventListener('abort', abort);
      pending.delete(requestId);
    }
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = (await request('tools/call', { name, arguments: args })) as {
      result: {
        isError?: boolean;
        content: unknown[];
        structuredContent?: Record<string, unknown>;
      };
    };
    expect(reply.result.isError, JSON.stringify(reply)).not.toBe(true);
    expectParity(reply.result);
    return reply.result.structuredContent;
  };
  try {
    const initialize = () =>
      request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'canvas-regression', version: '1' },
      });
    if (configured === 'invalid') {
      await expect(initialize()).rejects.toThrow('CANVAS_DEFAULT_ROW_LIMIT');
      return;
    }
    await initialize();
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const staged = await call('sdwis_get_violations', { pwsid: 'WA1234567', stage: true });
    const dataset = staged?.dataset as { canvas_id: string; table_name: string };
    const query = (sql: string, extra = {}) =>
      call('sdwis_dataframe_query', { canvas_id: dataset.canvas_id, sql, ...extra });
    expect(
      await query(`SELECT violation_id FROM ${dataset.table_name} ORDER BY violation_id`),
    ).toMatchObject({
      items: [{ violation_id: 'fixture-violation' }, { violation_id: 'second-violation' }],
      truncated: false,
    });
    const joins = Array.from(
      { length: 14 },
      (_, i) => `CROSS JOIN ${dataset.table_name} b${i}`,
    ).join(' ');
    const sql = `SELECT a.violation_id FROM ${dataset.table_name} a ${joins}`;
    const capped = await query(sql, { limit: 1 });
    expect(capped).toMatchObject({
      row_count: cap,
      returned: 1,
      truncated: true,
      has_more: true,
      notices: expect.arrayContaining([
        `The framework retained only ${cap} query rows; narrow SQL to retrieve omitted rows.`,
      ]),
    });
    expect(await query(sql, { cursor: capped?.next_cursor, limit: 1 })).toMatchObject({
      returned: 1,
      truncated: true,
      has_more: cap > 2,
    });
    expect(await query(`${sql} LIMIT ${cap}`, { limit: 1 })).toMatchObject({
      row_count: cap,
      truncated: false,
    });
    expect(await query(`SELECT * FROM ${dataset.table_name} WHERE false`)).toMatchObject({
      items: [],
      row_count: 0,
      truncated: false,
      has_more: false,
    });
    expect(await query(`SELECT * FROM ${dataset.table_name} OFFSET 5`)).toMatchObject({
      items: [],
      row_count: 0,
      has_more: false,
    });
    for (const [args, reason] of [
      [{ sql: 'SELECT 1', cursor: 'unknown' }, 'cursor_invalid'],
      [{ sql: 'SELECT * FROM absent_table' }, 'missing_table'],
    ] as const) {
      const reply = (await request('tools/call', {
        name: 'sdwis_dataframe_query',
        arguments: { canvas_id: dataset.canvas_id, ...args },
      })) as { result: { content: unknown[]; structuredContent: unknown } };
      expect(reply.result).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason } } },
      });
      expect(JSON.stringify(reply.result.content)).toContain(reason);
      if (reason === 'missing_table') {
        expect(reply.result.structuredContent).toMatchObject({
          error: {
            data: { recovery: { hint: expect.stringContaining('sdwis_dataframe_describe') } },
          },
        });
        expect(JSON.stringify(reply.result.content)).toContain('sdwis_dataframe_describe');
      }
    }
  } finally {
    lines.close();
    child.kill('SIGTERM');
    await exited;
  }
});
