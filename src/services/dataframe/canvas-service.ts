/**
 * @fileoverview Capability-scoped atomic staging and bounded immutable SQL pagination.
 * @module services/dataframe/canvas-service
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Context, z } from '@cyanheads/mcp-ts-core';
import {
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  DUCKDB_ERROR_REASONS,
  type QueryResult,
  SQL_GATE_REASONS,
  type TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  configurationError,
  databaseError,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { resolveInlineLimit } from '@/domain/inline-limit.js';
import { type PublicRow, type Table, tableSchemas } from '@/domain/sdwis-contracts.js';
import type { SelectionCoverage, SourceOutput } from '@/domain/source-output.js';
import type { SourcePartition } from '@/services/sdwis/drinking-water-service.js';

/** Every capability carries executable next steps. */
export const CANVAS_POINTER =
  'Use sdwis_dataframe_describe with this canvas_id to inspect table names and columns, then sdwis_dataframe_query with this canvas_id to analyze the staged rows.';
const TTL_MS = 3600000;
/** Only framework caller-error contracts carry public diagnostics; arbitrary engine errors do not. */
const SQL_DIAGNOSTICS = new Map<string, readonly string[]>([
  [SQL_GATE_REASONS.invalidSql, ['binderMessage', 'statementType']],
  [SQL_GATE_REASONS.deniedFunction, ['function']],
  [SQL_GATE_REASONS.deniedFunctionInPlan, ['functions']],
  [SQL_GATE_REASONS.planOperatorNotAllowed, ['operators']],
  [SQL_GATE_REASONS.systemCatalogAccess, ['catalog']],
  [SQL_GATE_REASONS.multiStatement, ['statementCount']],
  [SQL_GATE_REASONS.nonSelectStatement, ['statementType']],
  [DUCKDB_ERROR_REASONS.sqlExecutionError, []],
  [DUCKDB_ERROR_REASONS.sqlParseError, []],
  [DUCKDB_ERROR_REASONS.sqlReadOnly, []],
]);
const capacityExhausted = () =>
  rateLimited(
    'Reuse a canvas_id you already hold, wait for expiry, or narrow the source selection.',
    { reason: 'canvas_capacity_exhausted', retryable: true },
  );
const cursorSchema = z
  .object({
    kind: z.enum(['describe', 'query']),
    entry: z.string(),
    offset: z.number().int().nonnegative(),
    expires: z.number().int(),
  })
  .strict();
/** A table expires with its own TTL or its canvas, whichever comes first. */
function tableExpiry(table: TableInfo, instance: CanvasInstance): string {
  return new Date(
    Math.min(Date.parse(table.expiresAt ?? instance.expiresAt), Date.parse(instance.expiresAt)),
  ).toISOString();
}
interface Lineage {
  effective_filters: Record<string, unknown>;
  next_cursor?: string;
  provenance: SourceOutput['provenance'];
  relation: string;
  required_relations?: string[];
  selection_partition?: SourceOutput['selection_partition'];
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
  selection_coverage: SelectionCoverage;
  sql: string;
  tenant: string;
}
type Cursor = z.infer<typeof cursorSchema>;
interface DescribeOutput extends Record<string, unknown> {
  canvas_id: string;
  has_more: boolean;
  items: Record<string, unknown>[];
  next_cursor?: string;
  notices: string[];
  pointer: string;
  returned: number;
  selection_coverage: SelectionCoverage;
  totalCount: number;
}
interface SqlOutput extends Record<string, unknown> {
  canvas_id: string;
  columns: string[];
  has_more: boolean;
  items: Record<string, unknown>[];
  next_cursor?: string;
  notices: string[];
  pointer: string;
  provenance: unknown[];
  returned: number;
  row_count: number;
  selection_coverage: SelectionCoverage;
  source_complete: boolean;
  truncated: boolean;
}
/** Validated query paging input; SQL is never interpreted by this service. */
export interface QueryInput {
  canvas_id: string;
  cursor?: string | undefined;
  limit: number;
  sql: string;
}
/** Explicitly typed source schema, including columns absent from sparse rows. */
function sourceSchema(table: Table, rows: PublicRow[]): ColumnSchema[] {
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
  private readonly rowLimit: number;
  private states = new Set<State>();
  private active = 0;
  private waiting: Waiter[] = [];
  private cache = new Map<string, CacheEntry>();
  private readonly cursorSecret = randomBytes(32);
  constructor(canvas: DataCanvas, configuredRowLimit: number) {
    this.canvas = canvas;
    this.rowLimit = Math.min(configuredRowLimit, 25000);
  }

  private sweep(): void {
    for (const state of this.states)
      if (!state.busy && !state.queue.length && Date.parse(state.expiresAt) <= Date.now())
        this.states.delete(state);
    for (const [key, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(key);
  }
  private mintCursor(position: Cursor): string {
    const payload = Buffer.from(JSON.stringify(position)).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }
  private readCursor(token: string, kind: Cursor['kind']): Cursor {
    const [payload, signature, extra] = token.split('.');
    if (payload && signature && extra === undefined) {
      const expected = createHmac('sha256', this.cursorSecret).update(payload).digest();
      const supplied = Buffer.from(signature, 'base64url');
      if (
        supplied.toString('base64url') === signature &&
        supplied.length === expected.length &&
        timingSafeEqual(supplied, expected)
      ) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
        } catch {
          // Invalid JSON is rejected by the same cursor contract below.
        }
        const parsed = cursorSchema.safeParse(decoded);
        if (parsed.success && parsed.data.kind === kind && parsed.data.expires > Date.now())
          return parsed.data;
      }
    }
    throw validationError('Continuation expired or does not match this selection.', {
      reason: 'cursor_invalid',
    });
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
      if (this.states.size >= 8) throw capacityExhausted();
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
      throw capacityExhausted();
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          signal: ctx.signal,
          state: held,
          resolve,
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
  private coverage(state: State): SelectionCoverage {
    const selections = new Map<
      string,
      {
        final: number | null;
        partitions: Map<number, { required: Set<string>; present: Set<string> }>;
      }
    >();
    for (const lineage of state.tables.values()) {
      const position = lineage.selection_partition;
      if (!position) continue;
      let selection = selections.get(position.selection_id);
      if (!selection) {
        selection = { final: null, partitions: new Map() };
        selections.set(position.selection_id, selection);
      }
      if (position.final_partition !== null) selection.final = position.final_partition;
      let partition = selection.partitions.get(position.partition);
      if (!partition) {
        partition = { required: new Set(), present: new Set() };
        selection.partitions.set(position.partition, partition);
      }
      for (const relation of lineage.required_relations ?? []) partition.required.add(relation);
      partition.present.add(lineage.relation);
    }
    return [...selections].map(([selection_id, selection]) => {
      const partitions_present = [...selection.partitions]
        .filter(([, partition]) =>
          [...partition.required].every((relation) => partition.present.has(relation)),
        )
        .map(([sequence]) => sequence)
        .sort((a, b) => a - b);
      return {
        selection_id,
        partitions_present,
        final_partition: selection.final,
        chain_complete:
          selection.final !== null &&
          partitions_present.length === selection.final + 1 &&
          partitions_present.every((sequence, index) => sequence === index),
      };
    });
  }
  private async executeQuery(
    instance: CanvasInstance,
    sql: string,
    signal: AbortSignal,
  ): Promise<QueryResult> {
    try {
      return await instance.query(sql, {
        rowLimit: this.rowLimit,
        denySystemCatalogs: true,
        signal,
      });
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
      const diagnosticFields =
        cause.code === JsonRpcErrorCode.ValidationError && typeof reason === 'string'
          ? SQL_DIAGNOSTICS.get(reason)
          : cause.code === JsonRpcErrorCode.NotFound && reason === 'missing_table'
            ? ['tableName']
            : undefined;
      const hint =
        reason === 'canvas_not_found'
          ? 'Check canvas_id or repeat the producing source tool with stage true.'
          : reason === 'sql_execution_error'
            ? 'Use sdwis_dataframe_describe with this canvas_id to check column types, then retry sdwis_dataframe_query using TRY_CAST or a filter for incompatible values.'
            : 'Use sdwis_dataframe_describe with this canvas_id to check table names and columns, then retry sdwis_dataframe_query with one read-only statement against staged tables.';
      throw new McpError(
        cause.code,
        diagnosticFields
          ? cause.message
          : 'The canvas query was refused or could not complete; inspect its reason and recovery guidance.',
        {
          ...(typeof reason === 'string' ? { reason } : {}),
          recovery: { hint },
          ...Object.fromEntries(
            (diagnosticFields ?? [])
              .filter((field) => cause.data?.[field] !== undefined)
              .map((field) => [field, cause.data?.[field]]),
          ),
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
          throw capacityExhausted();
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
              ...(output.selection_partition
                ? {
                    selection_partition: { ...output.selection_partition },
                    required_relations: relations.map((entry) => entry.relation),
                  }
                : {}),
              ...(output.next_cursor ? { next_cursor: output.next_cursor } : {}),
            });
          }
          const first = created[0];
          const table = tables.find((candidate) => candidate.name === first);
          if (!first || !table) throw new Error('Registered partition is absent from canvas.');
          const position = output.selection_partition;
          if (position && position.final_partition !== null)
            for (const [name, lineage] of state.tables)
              if (lineage.selection_partition?.selection_id === position.selection_id)
                state.tables.set(name, {
                  ...lineage,
                  selection_partition: {
                    ...lineage.selection_partition,
                    final_partition: position.final_partition,
                  },
                });
          return {
            canvas_id: instance.canvasId,
            table_name: first,
            row_count: table.rowCount,
            expires_at: tableExpiry(table, instance),
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
  /** Inspect only the capability the caller supplied, paging complete table metadata. */
  describe(
    input: {
      canvas_id: string;
      table_name?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    },
    ctx: Context,
  ) {
    const { limit, notices } = resolveInlineLimit(input.limit, ctx);
    return this.operation(input.canvas_id, ctx, async (instance, state) => {
      const tables = (await this.reconcile(instance, state, ctx.signal)).filter(
        (table) => !input.table_name || table.name === input.table_name,
      );
      const items = tables.map((table) => ({
        table_name: table.name,
        row_count: table.rowCount,
        expires_at: tableExpiry(table, instance),
        columns: table.columns,
        ...state.tables.get(table.name),
      }));
      // Sliding TTL extensions do not change records-page membership or structural metadata.
      const entry = createHash('sha256')
        .update(
          JSON.stringify({
            canvas: input.canvas_id,
            tenant: state.tenant,
            table: input.table_name ?? null,
            items: items.map(({ expires_at: _expiresAt, ...identity }) => identity),
          }),
        )
        .digest('base64url');
      const cursor = input.cursor ? this.readCursor(input.cursor, 'describe') : undefined;
      if (cursor && (cursor.entry !== entry || cursor.offset > items.length))
        throw validationError('Describe continuation does not match this live selection.', {
          reason: 'cursor_invalid',
        });
      const offset = cursor?.offset ?? 0;
      const expires =
        cursor?.expires ??
        Math.min(
          Date.now() + 900000,
          Date.parse(instance.expiresAt),
          ...items.map((item) => Date.parse(item.expires_at)),
        );
      const mint = (position: number) =>
        this.mintCursor({
          kind: 'describe',
          entry,
          offset: position,
          expires,
        });
      const page = items.slice(offset, offset + limit);
      const hasMore = offset + page.length < items.length;
      const output: DescribeOutput = {
        selection_coverage: this.coverage(state),
        canvas_id: instance.canvasId,
        pointer: CANVAS_POINTER,
        items: page,
        returned: page.length,
        totalCount: items.length,
        has_more: hasMore,
        notices,
        ...(hasMore ? { next_cursor: mint(offset + page.length) } : {}),
      };
      return output;
    });
  }
  /** Execute once; every continuation reads the same bounded retained result. */
  query(input: QueryInput, ctx: Context) {
    const { limit, notices } = resolveInlineLimit(input.limit, ctx);
    return this.operation(input.canvas_id, ctx, async (instance, state) => {
      let key: string;
      let offset = 0;
      let entry: CacheEntry;
      if (input.cursor) {
        const pointer = this.readCursor(input.cursor, 'query');
        const retained = this.cache.get(pointer.entry);
        if (
          !retained ||
          retained.canvas !== input.canvas_id ||
          retained.tenant !== state.tenant ||
          retained.sql !== input.sql ||
          retained.expires <= Date.now() ||
          pointer.offset > retained.result.rows.length
        )
          throw validationError('Query continuation expired or selection changed.', {
            reason: 'cursor_invalid',
          });
        key = pointer.entry;
        entry = retained;
        offset = pointer.offset;
      } else {
        const result = await this.executeQuery(instance, input.sql, ctx.signal);
        ctx.signal.throwIfAborted();
        const selection_coverage = this.coverage(state);
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            result,
            lineage: [...state.tables.values()],
            selection_coverage,
            sql: input.sql,
          }),
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
          selection_coverage,
          expires: Date.now() + 900000,
          bytes,
        };
        this.cache.set(key, entry);
      }
      const page = entry.result.rows.slice(offset, offset + limit);
      const hasMore = offset + page.length < entry.result.rows.length;
      const output: SqlOutput = {
        selection_coverage: entry.selection_coverage,
        canvas_id: instance.canvasId,
        pointer: CANVAS_POINTER,
        columns: entry.result.columns,
        items: page,
        returned: page.length,
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
        has_more: hasMore,
        notices: [
          'Source completeness conservatively includes every live source partition in this canvas, including partitions not referenced by this SQL.',
          ...(entry.result.truncated
            ? [
                `The framework retained only ${this.rowLimit} query rows; narrow SQL to retrieve omitted rows.`,
              ]
            : []),
          ...notices,
        ],
        ...(hasMore
          ? {
              next_cursor: this.mintCursor({
                kind: 'query',
                expires: entry.expires,
                entry: key,
                offset: offset + page.length,
              }),
            }
          : {}),
      };
      return output;
    });
  }
  /** Missing capabilities and missing tables are both idempotent removal misses. */
  async drop(input: { canvas_id: string; table_name: string }, ctx: Context) {
    const outcome = (dropped: boolean, remaining_tables: number) => ({
      canvas_id: input.canvas_id,
      pointer: CANVAS_POINTER,
      table_name: input.table_name,
      dropped,
      remaining_tables,
      notices: [dropped ? 'Staged table removed.' : 'No staged table remains to remove.'],
    });
    try {
      return await this.operation(input.canvas_id, ctx, async (instance, state) => {
        ctx.signal.throwIfAborted();
        const dropped = await instance.drop(input.table_name);
        state.tables.delete(input.table_name);
        return outcome(dropped, state.tables.size);
      });
    } catch (cause) {
      if (cause instanceof McpError && cause.data?.reason === 'canvas_not_found')
        return outcome(false, 0);
      throw cause;
    }
  }
}
let service: CanvasService | undefined;
/** Bind the optional framework canvas exactly once during setup. */
export function initCanvasService(
  canvas: DataCanvas | undefined,
  configuredRowLimit: number,
): void {
  service = canvas ? new CanvasService(canvas, configuredRowLimit) : undefined;
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
