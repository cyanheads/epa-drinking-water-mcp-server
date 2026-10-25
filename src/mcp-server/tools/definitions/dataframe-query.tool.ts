/** @fileoverview Read-only SQL over an explicitly held public-data canvas. */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { optionalText, pagingFields } from '@/domain/source-inputs.js';
import { formatSource } from '@/domain/source-output.js';
import { getCanvasService } from '@/services/dataframe/canvas-service.js';

/** Query pagination reads an immutable bounded result, never reruns SQL for a cursor. */
export const dataframeQueryTool = tool('sdwis_dataframe_query', {
  description:
    'Run one read-only SELECT, WITH or FROM query against staged tables in a canvas_id you already hold. Call sdwis_dataframe_describe first for exact table names and columns. No file, network or system-catalog access. Results retain at most 25000 rows with immutable inline/text continuations; source incompleteness survives aggregation. Narrow SQL when the framework reports truncation.',
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
    source_complete: z.boolean().describe('All live source partitions are complete.'),
    provenance: z.array(z.unknown()).describe('Source attribution and limitations.'),
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
  handler: (input, ctx) => getCanvasService().query(input, ctx),
  format: formatSource,
});
