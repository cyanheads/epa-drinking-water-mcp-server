/**
 * @fileoverview Capability-scoped table schemas, provenance and partition manifests.
 * @module mcp-server/tools/definitions/dataframe-describe
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { inlineLimit } from '@/domain/inline-limit.js';
import { optionalText } from '@/domain/source-inputs.js';
import { formatSource, selectionCoverageSchema } from '@/domain/source-output.js';
import { getCanvasService } from '@/services/dataframe/canvas-service.js';

/** Inspect only the explicit caller-held canvas; no global canvas listing exists. */
export const dataframeDescribeTool = tool('sdwis_dataframe_describe', {
  description:
    'Inspect live table names, column types, row counts, source filters, provenance, completeness, continuation and expiry inside a canvas_id you already hold. Results page whole tables, each with its complete columns array. UCMR additional elements join occurrence by pwsid, facility_id, sample_point_id and sample_event_code; service ZIP membership joins by pwsid and is not sample location.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.strictObject({
    canvas_id: CanvasIdSchema,
    table_name: optionalText('Optional exact table name within this canvas.'),
    cursor: optionalText('Continuation from this exact describe selection.'),
    limit: inlineLimit.describe(
      'Whole tables requested; defaults to 10, with an effective maximum of 500.',
    ),
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
    has_more: z.boolean().describe('More whole tables remain.'),
    next_cursor: optionalText('Next page of whole tables in this selection.'),
    notices: z.array(z.string()).describe('Paging guidance.'),
  }),
  errors: [
    {
      reason: 'cursor_invalid',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A continuation is invalid, expired, or its live table metadata or exact selector changed.',
      recovery:
        'Repeat sdwis_dataframe_describe with the original canvas_id and table_name, omitting cursor.',
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
