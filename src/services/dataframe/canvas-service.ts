/** @fileoverview Capability-scoped atomic staging and bounded immutable SQL pagination. */
import { randomBytes } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import type {
  CanvasInstance,
  ColumnSchema,
  DataCanvas,
  QueryResult,
  TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  configurationError,
  databaseError,
  McpError,
  notFound,
  rateLimited,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { type PublicRow, type Table, tableSchemas } from '@/domain/sdwis-contracts.js';
import { type SourceOutput, wireBytes } from '@/domain/source-output.js';
import type { SourcePartition } from '@/services/sdwis/drinking-water-service.js';

/** Every capability carries executable next steps. */
export const CANVAS_POINTER =
  'Use sdwis_dataframe_describe with this canvas_id to inspect table names and columns, then sdwis_dataframe_query with this canvas_id to analyze the staged rows.';
const TTL_MS = 3600000;
const capacityHint =
  'Reuse a canvas_id you already hold, wait for expiry, or narrow the source selection.';
interface Lineage {
  effective_filters: Record<string, unknown>;
  next_cursor?: string;
  provenance: SourceOutput['provenance'];
  relation: string;
  source_complete: boolean;
}
interface State {
  busy: boolean;
  expiresAt: string;
  id?: string;
  queue: Waiter[];
  tables: Map<string, Lineage>;
  tenant: string;
}
interface Waiter {
  abort: () => void;
  reject: (cause: unknown) => void;
  resolve: () => void;
  signal: AbortSignal;
  state: State;
}
/** A companion relation is committed and rolled back with its occurrence partition. */
export interface StagedRelation {
  relation: string;
  rows: PublicRow[];
  schema: ColumnSchema[];
}
interface CacheEntry {
  bytes: number;
  canvas: string;
  expires: number;
  lineage: Lineage[];
  result: QueryResult;
  sql: string;
  tenant: string;
}
interface Cursor {
  entry: string;
  offset: number;
  textOffset?: number;
}
interface DescribeOutput extends Record<string, unknown> {
  canvas_id: string;
  has_more: boolean;
  items: Record<string, unknown>[];
  next_cursor?: string;
  notices: string[];
  pointer: string;
  returned: number;
  totalCount: number;
}
interface SqlOutput extends Record<string, unknown> {
  canvas_id: string;
  columns: string[];
  encoding?: 'json';
  has_more: boolean;
  items: Record<string, unknown>[];
  next_cursor?: string;
  notices: string[];
  offset?: number;
  phase?: 'records' | 'text';
  pointer: string;
  provenance: unknown[];
  record_identity?: string;
  returned: number;
  row_count: number;
  source_complete: boolean;
  text?: string;
  truncated: boolean;
}
/** Validated query paging input; SQL is never interpreted by this service. */
export interface QueryInput {
  canvas_id: string;
  cursor?: string | undefined;
  limit: number;
  record_cursor?: string | undefined;
  sql: string;
  view: 'records' | 'text';
}
/** Explicitly typed source schema, including columns absent from sparse rows. */
export function sourceSchema(table: Table, rows: PublicRow[]): ColumnSchema[] {
  const json = tableSchemas[table].toJSONSchema();
  const properties = json.properties ?? {};
  const names = new Set([...Object.keys(properties), ...rows.flatMap((row) => Object.keys(row))]);
  return [...names].map((name) => {
    const property = properties[name];
    const numeric =
      property &&
      typeof property === 'object' &&
      'type' in property &&
      (property.type === 'number' ||
        (Array.isArray(property.type) && property.type.includes('number')));
    const sample = rows.find((row) => row[name] !== null && row[name] !== undefined)?.[name];
    return {
      name,
      nullable: true,
      type: name.endsWith('_date')
        ? 'DATE'
        : numeric || typeof sample === 'number'
          ? 'DOUBLE'
          : typeof sample === 'boolean'
            ? 'BOOLEAN'
            : 'VARCHAR',
    };
  });
}
/** Process-local admission is synchronous before every asynchronous operation. */
export class CanvasService {
  private readonly canvas: DataCanvas;
  private states = new Set<State>();
  private active = 0;
  private waiting: Waiter[] = [];
  private cache = new Map<string, CacheEntry>();
  private cursors = new Map<string, Cursor>();
  constructor(canvas: DataCanvas) {
    this.canvas = canvas;
  }

  private sweep(): void {
    for (const state of this.states)
      if (!state.busy && !state.queue.length && Date.parse(state.expiresAt) <= Date.now())
        this.states.delete(state);
    for (const [key, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(key);
    for (const [key, cursor] of this.cursors)
      if (!this.cache.has(cursor.entry)) this.cursors.delete(key);
  }
  private pump(): void {
    for (let i = 0; i < this.waiting.length && this.active < 2; ) {
      const waiter = this.waiting[i];
      if (!waiter) break;
      if (waiter.state.busy) {
        i++;
        continue;
      }
      this.waiting.splice(i, 1);
      waiter.state.queue.splice(waiter.state.queue.indexOf(waiter), 1);
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.state.busy = true;
      this.active++;
      waiter.resolve();
    }
  }
  private async operation<T>(
    id: string | undefined,
    ctx: Context,
    run: (instance: CanvasInstance, state: State) => Promise<T>,
  ): Promise<T> {
    ctx.signal.throwIfAborted();
    this.sweep();
    const tenant = ctx.tenantId ?? 'default';
    let state = [...this.states].find(
      (candidate) => candidate.id === id && candidate.tenant === tenant && id !== undefined,
    );
    let reservedNew = false;
    if (!state) {
      if (id) {
        // Acquiring an explicit foreign/expired ID remains the framework's authority.
        const instance = await this.canvas.acquire(id, ctx, { signal: ctx.signal });
        throw notFound('Canvas lineage is no longer available; repeat the producing source tool.', {
          reason: 'canvas_not_found',
          canvas_id: instance.canvasId,
        });
      }
      if (this.states.size >= 8)
        throw rateLimited(capacityHint, { reason: 'canvas_capacity_exhausted', retryable: true });
      state = {
        tenant,
        expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
        busy: false,
        tables: new Map(),
        queue: [],
      };
      this.states.add(state);
      reservedNew = true;
    }
    const held = state;
    if (held.queue.length >= 4) {
      if (reservedNew) this.states.delete(held);
      throw rateLimited(capacityHint, { reason: 'canvas_capacity_exhausted', retryable: true });
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          signal: ctx.signal,
          state: held,
          resolve,
          reject,
          abort: () => {
            const index = this.waiting.indexOf(waiter);
            if (index >= 0) this.waiting.splice(index, 1);
            const local = held.queue.indexOf(waiter);
            if (local >= 0) held.queue.splice(local, 1);
            reject(ctx.signal.reason);
          },
        };
        held.queue.push(waiter);
        this.waiting.push(waiter);
        ctx.signal.addEventListener('abort', waiter.abort, { once: true });
        this.pump();
      });
    } catch (cause) {
      if (reservedNew) this.states.delete(held);
      throw cause;
    }
    let instance: CanvasInstance | undefined;
    try {
      instance = await this.canvas.acquire(id, ctx, { signal: ctx.signal });
      held.id = instance.canvasId;
      held.expiresAt = instance.expiresAt;
      await this.reconcile(instance, held, ctx.signal);
      return await run(instance, held);
    } catch (cause) {
      if (reservedNew && instance) await this.canvas.drop(instance.canvasId, ctx);
      if (reservedNew || (cause instanceof McpError && cause.data?.reason === 'canvas_not_found'))
        this.states.delete(held);
      throw cause;
    } finally {
      held.busy = false;
      this.active--;
      this.pump();
    }
  }
  private async reconcile(
    instance: CanvasInstance,
    state: State,
    signal: AbortSignal,
  ): Promise<TableInfo[]> {
    signal.throwIfAborted();
    const tables = await instance.describe();
    signal.throwIfAborted();
    for (const key of state.tables.keys())
      if (!tables.some((table) => table.name === key)) state.tables.delete(key);
    state.expiresAt = instance.expiresAt;
    return tables;
  }
  private async executeQuery(
    instance: CanvasInstance,
    sql: string,
    signal: AbortSignal,
  ): Promise<QueryResult> {
    try {
      return await instance.query(sql, { rowLimit: 25000, denySystemCatalogs: true, signal });
    } catch (cause) {
      signal.throwIfAborted();
      if (!(cause instanceof McpError))
        throw databaseError(
          'The canvas engine could not complete the query.',
          {
            recovery: {
              hint: 'Use sdwis_dataframe_describe with this canvas_id, then retry sdwis_dataframe_query against staged tables.',
            },
          },
          { cause },
        );
      const reason = cause.data?.reason;
      const hint =
        reason === 'canvas_not_found'
          ? 'Check canvas_id or repeat the producing source tool with stage true.'
          : reason === 'sql_execution_error'
            ? 'Use sdwis_dataframe_describe with this canvas_id to check column types, then retry sdwis_dataframe_query using TRY_CAST or a filter for incompatible values.'
            : 'Use sdwis_dataframe_describe with this canvas_id to check table names and columns, then retry sdwis_dataframe_query with one read-only statement against staged tables.';
      throw new McpError(
        cause.code,
        'The canvas query was refused or could not complete; inspect its reason and recovery guidance.',
        {
          ...(typeof reason === 'string' ? { reason } : {}),
          recovery: { hint },
          ...(typeof cause.data?.tableName === 'string' ? { tableName: cause.data.tableName } : {}),
        },
        { cause },
      );
    }
  }
  /** Register the complete bounded partition and all required companions atomically. */
  stage(partition: SourcePartition, ctx: Context): Promise<NonNullable<SourceOutput['dataset']>> {
    return this.stageRelations(
      partition.input,
      partition.output,
      [
        {
          relation: partition.table,
          rows: partition.rows,
          schema: sourceSchema(partition.table, partition.rows),
        },
      ],
      ctx,
    );
  }
  /** UCMR supplies explicit schemas for occurrence and separate one-to-many relations. */
  stageRelations(
    input: Record<string, unknown>,
    output: SourceOutput,
    relations: StagedRelation[],
    ctx: Context,
  ): Promise<NonNullable<SourceOutput['dataset']>> {
    return this.operation(
      typeof input.canvas_id === 'string' ? input.canvas_id : undefined,
      ctx,
      async (instance, state) => {
        const live = await this.reconcile(instance, state, ctx.signal);
        const rows = relations.reduce((sum, relation) => sum + relation.rows.length, 0);
        if (
          live.length + relations.length > 16 ||
          live.reduce((sum, table) => sum + table.rowCount, 0) + rows > 250000
        )
          throw rateLimited(capacityHint, { reason: 'canvas_capacity_exhausted', retryable: true });
        const suffix = randomBytes(8).toString('hex');
        const created: string[] = [];
        try {
          for (const relation of relations) {
            const name = `${relation.relation}_${suffix}`;
            created.push(name);
            await instance.registerTable(name, relation.rows, {
              schema: relation.schema,
              ttlMs: TTL_MS,
              signal: ctx.signal,
            });
            ctx.signal.throwIfAborted();
          }
          const tables = await instance.describe();
          ctx.signal.throwIfAborted();
          for (const [index, relation] of relations.entries()) {
            const name = created[index];
            if (!name) throw new Error('Missing registered partition name.');
            state.tables.set(name, {
              source_complete: output.source_complete,
              provenance: output.provenance,
              effective_filters: output.effective_filters,
              relation: relation.relation,
              ...(output.next_cursor ? { next_cursor: output.next_cursor } : {}),
            });
          }
          const first = created[0];
          const table = tables.find((candidate) => candidate.name === first);
          if (!first || !table) throw new Error('Registered partition is absent from canvas.');
          return {
            canvas_id: instance.canvasId,
            table_name: first,
            row_count: table.rowCount,
            expires_at: new Date(
              Math.min(
                Date.parse(table.expiresAt ?? instance.expiresAt),
                Date.parse(instance.expiresAt),
              ),
            ).toISOString(),
            source_complete: output.source_complete,
            pointer: CANVAS_POINTER,
            ...(output.next_cursor ? { next_cursor: output.next_cursor } : {}),
          };
        } catch (cause) {
          for (const name of created) {
            await instance.drop(name);
            state.tables.delete(name);
          }
          throw cause;
        }
      },
    );
  }
  /** Inspect only the capability the caller supplied, with whole-item byte paging. */
  describe(
    input: {
      canvas_id: string;
      table_name?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    },
    ctx: Context,
  ) {
    return this.operation(input.canvas_id, ctx, async (instance, state) => {
      const tables = (await this.reconcile(instance, state, ctx.signal)).filter(
        (table) => !input.table_name || table.name === input.table_name,
      );
      const items = tables.flatMap((table) =>
        table.columns.map((column) => ({
          table_name: table.name,
          row_count: table.rowCount,
          expires_at: new Date(
            Math.min(
              Date.parse(table.expiresAt ?? instance.expiresAt),
              Date.parse(instance.expiresAt),
            ),
          ).toISOString(),
          column,
          ...state.tables.get(table.name),
        })),
      );
      const offset = input.cursor
        ? this.readDescribeCursor(input.cursor, input.canvas_id, input.table_name)
        : 0;
      const output: DescribeOutput = {
        canvas_id: instance.canvasId,
        pointer: CANVAS_POINTER,
        items: [],
        returned: 0,
        totalCount: items.length,
        has_more: false,
        notices: input.limit > 100 ? ['Requested limit was clamped to 100.'] : [],
      };
      const page: typeof items = [];
      output.items = page;
      for (const item of items.slice(offset, offset + Math.min(input.limit, 100))) {
        page.push(item);
        output.returned = page.length;
        output.has_more = offset + page.length < items.length;
        output.next_cursor = this.describeCursor(
          input.canvas_id,
          input.table_name,
          offset + page.length,
        );
        if (wireBytes(output) >= 23000) {
          page.pop();
          break;
        }
      }
      output.returned = page.length;
      output.has_more = offset + page.length < items.length;
      if (output.has_more)
        output.next_cursor = this.describeCursor(
          input.canvas_id,
          input.table_name,
          offset + page.length,
        );
      else delete output.next_cursor;
      if (!page.length && offset < items.length)
        throw validationError(
          'Table metadata cannot fit inline; inspect a narrower table selection.',
          { reason: 'item_too_large' },
        );
      return output;
    });
  }
  private describeCursor(canvas: string, table: string | undefined, offset: number): string {
    return Buffer.from(JSON.stringify({ canvas, table: table ?? null, offset })).toString(
      'base64url',
    );
  }
  private readDescribeCursor(cursor: string, canvas: string, table: string | undefined): number {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'canvas' in parsed &&
        parsed.canvas === canvas &&
        'table' in parsed &&
        parsed.table === (table ?? null) &&
        'offset' in parsed &&
        typeof parsed.offset === 'number' &&
        Number.isSafeInteger(parsed.offset) &&
        parsed.offset >= 0
      )
        return parsed.offset;
    } catch {
      /* Rejected below. */
    }
    throw validationError('Describe continuation does not match this selection.', {
      reason: 'cursor_invalid',
    });
  }
  /** Execute once; every continuation reads the same bounded retained result. */
  query(input: QueryInput, ctx: Context) {
    return this.operation(input.canvas_id, ctx, async (instance, state) => {
      let key: string;
      let offset = 0;
      let textOffset: number | undefined;
      let entry: CacheEntry;
      const supplied = input.view === 'text' ? input.record_cursor : input.cursor;
      if ((input.view === 'text' && !supplied) || (input.view !== 'text' && input.record_cursor))
        throw validationError('Text view requires record_cursor; records view uses cursor.', {
          reason: 'cursor_invalid',
        });
      if (supplied) {
        const pointer = this.cursors.get(supplied);
        const retained = pointer && this.cache.get(pointer.entry);
        if (
          !pointer ||
          !retained ||
          retained.canvas !== input.canvas_id ||
          retained.tenant !== state.tenant ||
          retained.sql !== input.sql ||
          retained.expires <= Date.now()
        )
          throw validationError('Query continuation expired or selection changed.', {
            reason: 'cursor_invalid',
          });
        key = pointer.entry;
        entry = retained;
        offset = pointer.offset;
        textOffset = pointer.textOffset;
      } else {
        const result = await this.executeQuery(instance, input.sql, ctx.signal);
        ctx.signal.throwIfAborted();
        const bytes = new TextEncoder().encode(
          JSON.stringify({ result, lineage: [...state.tables.values()], sql: input.sql }),
        ).byteLength;
        this.sweep();
        if (
          this.cache.size >= 16 ||
          [...this.cache.values()].reduce((sum, value) => sum + value.bytes, 0) + bytes >
            32 * 1024 * 1024
        )
          throw rateLimited('Query cache is full; narrow SQL or wait fifteen minutes.', {
            reason: 'query_capacity_exhausted',
            retryable: true,
          });
        key = randomBytes(18).toString('base64url');
        entry = {
          canvas: input.canvas_id,
          tenant: state.tenant,
          sql: input.sql,
          result,
          lineage: [...state.tables.values()],
          expires: Date.now() + 900000,
          bytes,
        };
        this.cache.set(key, entry);
      }
      const output: SqlOutput = {
        canvas_id: instance.canvasId,
        pointer: CANVAS_POINTER,
        columns: entry.result.columns,
        items: [],
        returned: 0,
        row_count: entry.result.rowCount,
        truncated: entry.result.truncated ?? false,
        source_complete: entry.lineage.every((lineage) => lineage.source_complete),
        provenance: [
          ...new Map(
            entry.lineage.map((lineage) => [
              JSON.stringify(lineage.provenance),
              lineage.provenance,
            ]),
          ).values(),
        ],
        has_more: false,
        notices: [
          'Source completeness conservatively includes every live source partition in this canvas, including partitions not referenced by this SQL.',
          ...(entry.result.truncated
            ? ['The framework retained only 25000 query rows; narrow SQL to retrieve omitted rows.']
            : []),
          ...(input.limit > 100 ? ['Requested limit was clamped to 100.'] : []),
        ],
      };
      const mint = (position: number, text?: number) => {
        if (this.cursors.size >= 4096)
          throw rateLimited('Query continuation capacity is full; wait for expiry.', {
            reason: 'query_capacity_exhausted',
            retryable: true,
          });
        const token = randomBytes(24).toString('base64url');
        this.cursors.set(token, {
          entry: key,
          offset: position,
          ...(text === undefined ? {} : { textOffset: text }),
        });
        return token;
      };
      if (input.view === 'text') {
        const row = entry.result.rows[offset];
        if (!row || textOffset === undefined)
          throw validationError('Invalid oversized-row continuation.', {
            reason: 'cursor_invalid',
          });
        const points = Array.from(JSON.stringify(row));
        let end = textOffset;
        output.encoding = 'json';
        output.offset = textOffset;
        output.record_identity = `${key}:${offset}`;
        output.text = '';
        output.next_cursor = 'x'.repeat(32);
        while (end < points.length) {
          output.text = points.slice(textOffset, end + 1).join('');
          if (wireBytes(output) >= 23000) break;
          end++;
        }
        if (end === textOffset && end < points.length)
          throw validationError('Query metadata exceeds inline capacity; narrow SQL.', {
            reason: 'item_too_large',
          });
        output.text = points.slice(textOffset, end).join('');
        output.has_more = end < points.length || offset + 1 < entry.result.rows.length;
        if (end < points.length) {
          output.next_cursor = mint(offset, end);
          output.phase = 'text';
        } else if (offset + 1 < entry.result.rows.length) {
          output.next_cursor = mint(offset + 1);
          output.phase = 'records';
        } else delete output.next_cursor;
      } else {
        const page: Record<string, unknown>[] = [];
        output.items = page;
        output.next_cursor = 'x'.repeat(32);
        for (const row of entry.result.rows.slice(offset, offset + Math.min(input.limit, 100))) {
          page.push(row);
          output.returned = page.length;
          if (wireBytes(output) >= 23000) {
            page.pop();
            break;
          }
        }
        if (!page.length && offset < entry.result.rows.length)
          throw validationError('A complete SQL row exceeds inline capacity.', {
            reason: 'item_too_large',
            record_cursor: mint(offset, 0),
            follow_up: {
              tool: 'sdwis_dataframe_query',
              canvas_id: input.canvas_id,
              sql: input.sql,
              view: 'text',
            },
          });
        output.returned = page.length;
        output.has_more = offset + page.length < entry.result.rows.length;
        if (output.has_more) output.next_cursor = mint(offset + page.length);
        else delete output.next_cursor;
      }
      if (wireBytes(output) >= 24000)
        throw validationError('Query metadata exceeds inline capacity; narrow SQL.', {
          reason: 'item_too_large',
        });
      return output;
    });
  }
  /** Missing capabilities and missing tables are both idempotent removal misses. */
  async drop(input: { canvas_id: string; table_name: string }, ctx: Context) {
    try {
      return await this.operation(input.canvas_id, ctx, async (instance, state) => {
        ctx.signal.throwIfAborted();
        const dropped = await instance.drop(input.table_name);
        state.tables.delete(input.table_name);
        return {
          canvas_id: input.canvas_id,
          pointer: CANVAS_POINTER,
          table_name: input.table_name,
          dropped,
          remaining_tables: state.tables.size,
          notices: [dropped ? 'Staged table removed.' : 'No staged table remains to remove.'],
        };
      });
    } catch (cause) {
      if (cause instanceof McpError && cause.data?.reason === 'canvas_not_found')
        return {
          canvas_id: input.canvas_id,
          pointer: CANVAS_POINTER,
          table_name: input.table_name,
          dropped: false,
          remaining_tables: 0,
          notices: ['No staged table remains to remove.'],
        };
      throw cause;
    }
  }
}
let service: CanvasService | undefined;
/** Bind the optional framework canvas exactly once during setup. */
export function initCanvasService(canvas: DataCanvas | undefined): void {
  service = canvas ? new CanvasService(canvas) : undefined;
}
/** Requested staging fails explicitly in runtimes without native canvas support. */
export function getCanvasService(): CanvasService {
  if (!service)
    throw configurationError(
      'DataCanvas is disabled. Use inline records, or npm/Docker with CANVAS_PROVIDER_TYPE=duckdb; MCPB supports inline records only.',
      { reason: 'canvas_disabled' },
    );
  return service;
}
