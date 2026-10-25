/** @fileoverview Capability-scoped table schemas, provenance and partition manifests. */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { optionalText } from '@/domain/source-inputs.js';
import { formatSource } from '@/domain/source-output.js';
import { getCanvasService } from '@/services/dataframe/canvas-service.js';

/** Inspect only the explicit caller-held canvas; no global canvas listing exists. */
export const dataframeDescribeTool = tool('sdwis_dataframe_describe', {
  description:
    'Inspect live table names, column types, row counts, source filters, provenance, completeness, continuation and expiry inside a canvas_id you already hold. Results page whole table-column metadata entries. UCMR additional elements join occurrence by pwsid, facility_id, sample_point_id and sample_event_code; service ZIP membership joins by pwsid and is not sample location.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema,
    table_name: optionalText('Optional exact table name within this canvas.'),
    cursor: optionalText('Continuation from this exact describe selection.'),
    limit: z
      .number()
      .int()
      .positive()
      .default(10)
      .describe('Entries requested; clamped to 100 with a notice.'),
  }),
  output: z.object({
    canvas_id: z.string().describe('Explicit canvas capability.'),
    pointer: z.string().describe('Executable describe/query next steps.'),
    items: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Live engine table-column metadata with source lineage.'),
    returned: z.number().int().describe('Entries in this response.'),
    totalCount: z.number().int().describe('Current matching metadata entries.'),
    has_more: z.boolean().describe('More metadata entries remain.'),
    next_cursor: optionalText('Next whole metadata entry.'),
    notices: z.array(z.string()).describe('Paging guidance.'),
  }),
  handler: (input, ctx) => getCanvasService().describe(input, ctx),
  format: formatSource,
});
