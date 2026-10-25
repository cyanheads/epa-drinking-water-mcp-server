/** @fileoverview Optional idempotent removal of a recreatable public-data table. */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { formatSource } from '@/domain/source-output.js';
import { getCanvasService } from '@/services/dataframe/canvas-service.js';

/** Registered only when canvas and the explicit drop flag are enabled. */
export const dataframeDropTool = tool('sdwis_dataframe_drop', {
  description:
    'Remove one staged public-data table from a canvas_id you already hold. Missing tables and expired canvases return dropped false. Other partition tables remain available. Requires the operator to enable SDWIS_DATAFRAME_DROP_ENABLED.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema,
    table_name: z
      .string()
      .min(1)
      .max(128)
      .describe('Exact table name returned by a producer or sdwis_dataframe_describe.'),
  }),
  output: z.object({
    canvas_id: z.string().describe('Explicit canvas capability.'),
    pointer: z.string().describe('Executable describe/query next steps.'),
    table_name: z.string().describe('Table requested for removal.'),
    dropped: z.boolean().describe('True only when a live table was removed.'),
    remaining_tables: z.number().int().describe('Remaining known accessible source tables.'),
    notices: z.array(z.string()).describe('Removal outcome.'),
  }),
  handler: (input, ctx) => getCanvasService().drop(input, ctx),
  format: formatSource,
});
