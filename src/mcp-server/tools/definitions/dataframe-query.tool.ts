/**
 * @fileoverview Read-only SQL over an explicitly held public-data canvas.
 * @module mcp-server/tools/definitions/dataframe-query
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { optionalText, pagingFields } from '@/domain/source-inputs.js';
import { formatSource, selectionCoverageSchema } from '@/domain/source-output.js';
import { getCanvasService } from '@/services/dataframe/canvas-service.js';

/** Query pagination reads an immutable bounded result, never reruns SQL for a cursor. */
export const dataframeQueryTool = tool('sdwis_dataframe_query', {
  description:
    'Run one read-only SELECT, WITH or FROM query against staged tables in a canvas_id you already hold. Call sdwis_dataframe_describe first for exact table names and columns. No file, network or system-catalog access. Results retain at most the configured canvas row ceiling or 25000 rows, whichever is lower, with immutable inline/text continuations; source incompleteness survives aggregation. Narrow SQL when the framework reports truncation.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema,
    sql: z
      .string()
      .min(1)
      .max(20000)
      .describe('One read-only SQL statement against staged tables; at most 20000 characters.'),
    ...pagingFields,
  }),
  output: z.object({
    selection_coverage: selectionCoverageSchema,
    canvas_id: z.string().describe('Explicit canvas capability.'),
    pointer: z.string().describe('Executable describe/query next steps.'),
    columns: z.array(z.string()).describe('SQL projection names.'),
    items: z.array(z.record(z.string(), z.unknown())).describe('Complete JSON-safe SQL rows.'),
    returned: z.number().int().describe('Rows in this page.'),
    row_count: z
      .number()
      .int()
      .describe('Framework materialized result count; capped when truncated.'),
    truncated: z.boolean().describe('Framework result exceeds the retained row cap.'),
    source_complete: z
      .boolean()
      .describe(
        'Every live source partition in the canvas is complete, including tables this SQL does not reference; aggregation cannot establish completeness.',
      ),
    provenance: z
      .array(z.unknown())
      .describe(
        'Distinct source provenance objects with source, URL, retrieved_at, consistency and caveats, plus publication or HTTP validators when available.',
      ),
    has_more: z.boolean().describe('More retained rows or record text are available.'),
    next_cursor: optionalText('Exact retained-result continuation.'),
    notices: z.array(z.string()).describe('Scope and completeness guidance.'),
    encoding: z
      .literal('json')
      .optional()
      .describe('Concatenate text chunks to reconstruct the whole row.'),
    text: z.string().optional().describe('Lossless oversized-row JSON text.'),
    offset: z.number().int().optional().describe('Unicode code-point offset.'),
    record_identity: z.string().optional().describe('Retained oversized row identity.'),
    phase: z
      .enum(['records', 'text'])
      .optional()
      .describe('Use next_cursor as cursor or record_cursor according to this phase.'),
  }),
  errors: [
    {
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
      when: 'Canvas admission, operation queue, table or row capacity is full.',
      recovery:
        'Reuse a canvas_id you already hold, wait for expiry, or narrow the source selection.',
    },
    {
      reason: 'query_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
      when: 'Immutable query results reached the retained entry or byte capacity.',
      recovery:
        'Wait fifteen minutes for retained queries to expire, then retry sdwis_dataframe_query with narrower SQL.',
    },
  ],
  handler: (input, ctx) => getCanvasService().query(input, ctx),
  format: formatSource,
});
