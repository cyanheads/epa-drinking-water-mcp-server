/**
 * @fileoverview Capability-scoped table schemas, provenance and partition manifests.
 * @module mcp-server/tools/definitions/dataframe-describe
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { optionalText } from '@/domain/source-inputs.js';
import { formatSource, selectionCoverageSchema } from '@/domain/source-output.js';
import { getCanvasService } from '@/services/dataframe/canvas-service.js';

/** Inspect only the explicit caller-held canvas; no global canvas listing exists. */
export const dataframeDescribeTool = tool('sdwis_dataframe_describe', {
  description:
    'Inspect live table names, column types, row counts, source filters, provenance, completeness, continuation and expiry inside a canvas_id you already hold. Results page whole tables, each with its complete columns array. Oversized tables are available as lossless JSON text chunks. UCMR additional elements join occurrence by pwsid, facility_id, sample_point_id and sample_event_code; service ZIP membership joins by pwsid and is not sample location.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema,
    table_name: optionalText('Optional exact table name within this canvas.'),
    cursor: optionalText('Continuation from this exact describe selection.'),
    view: z
      .enum(['records', 'text'])
      .default('records')
      .describe('Whole tables or lossless oversized-table JSON text.'),
    record_cursor: optionalText('Oversized-table text continuation from this exact selection.'),
    limit: z
      .number()
      .int()
      .positive()
      .default(10)
      .describe('Tables requested; clamped to 100 with a notice.'),
  }),
  output: z.object({
    selection_coverage: selectionCoverageSchema,
    canvas_id: z.string().describe('Explicit canvas capability.'),
    pointer: z.string().describe('Executable describe/query next steps.'),
    items: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'One entry per table: table_name, row_count, expires_at, complete columns array with name/type/nullability, source filters, provenance, relation and completeness, plus any source continuation.',
      ),
    returned: z.number().int().describe('Whole tables in this response.'),
    totalCount: z.number().int().describe('Current matching tables.'),
    has_more: z.boolean().describe('More tables or table text remain.'),
    next_cursor: optionalText(
      'Next whole table or text chunk; use phase to choose cursor or record_cursor.',
    ),
    notices: z.array(z.string()).describe('Paging guidance.'),
    encoding: z
      .literal('json')
      .optional()
      .describe('Concatenate text chunks to reconstruct the complete table item.'),
    text: z.string().optional().describe('Lossless oversized-table JSON text.'),
    offset: z.number().int().optional().describe('Unicode code-point offset.'),
    record_identity: z.string().optional().describe('Exact live table metadata identity.'),
    phase: z
      .enum(['records', 'text'])
      .optional()
      .describe('Use next_cursor as cursor for records or record_cursor for text.'),
  }),
  errors: [
    {
      reason: 'cursor_invalid',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A continuation is invalid, expired, or its live table metadata or exact selector changed.',
      recovery:
        'Repeat sdwis_dataframe_describe with the original canvas_id and table_name, omitting cursor and record_cursor.',
    },
    {
      reason: 'item_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A complete table metadata item cannot fit inline.',
      recovery:
        'Repeat sdwis_dataframe_describe with view text, the returned record_cursor, and the same canvas_id and table_name.',
    },
    {
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
      when: 'Canvas admission, operation queue, table or row capacity is full.',
      recovery:
        'Reuse a canvas_id you already hold, wait for expiry, or narrow the source selection.',
    },
  ],
  handler: (input, ctx) => getCanvasService().describe(input, ctx),
  format: formatSource,
});
