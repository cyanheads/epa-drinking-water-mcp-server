/**
 * @fileoverview Source output envelope and reversible formatting used for wire-byte accounting.
 * @module domain/source-output
 */
import { z } from '@cyanheads/mcp-ts-core';

/** JSON-safe source values, including sparse source nulls. */
export const rowSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe('Flat allowlisted source fields; null represents unknown source data.');
/** Public provenance, kept distinct from observation and snapshot dates. */
export const provenanceSchema = z
  .object({
    source: z.string().describe('EPA source name.'),
    url: z.string().describe('Public source URL.'),
    retrieved_at: z.string().describe('HTTP retrieval time, not observation or snapshot time.'),
    last_modified: z.string().optional().describe('HTTP Last-Modified when provided.'),
    published_release: z
      .string()
      .optional()
      .describe('Publisher release label, distinct from HTTP modification and observation dates.'),
    etag: z.string().optional().describe('HTTP entity validator when provided.'),
    consistency: z.string().describe('Publication consistency limitation.'),
    caveats: z.array(z.string()).describe('Interpretation and coverage limitations.'),
  })
  .describe('EPA attribution and retrieval provenance.');
/** Dataset metadata is supplied exclusively by an actual staging service. */
export const datasetSchema = z
  .object({
    canvas_id: z.string().describe('Explicit capability for this canvas.'),
    table_name: z.string().describe('Staged partition table.'),
    row_count: z.number().int().describe('Rows staged in this partition.'),
    source_complete: z
      .boolean()
      .describe('Whether this staged partition contains the entire selected source.'),
    expires_at: z.string().describe('Partition expiry timestamp.'),
    next_cursor: z.string().optional().describe('Exact source-partition continuation.'),
    pointer: z.string().describe('Executable next steps for the canvas capability.'),
  })
  .describe('Live staged source partition.');
/** Common source fields, including optional lossless oversized-record text chunks. */
export const sourceOutputShape = {
  effective_filters: z
    .record(z.string(), z.unknown())
    .describe(
      'Normalized effective selection; state_basis identifies legal-entity state matching.',
    ),
  items: z.array(rowSchema).describe('Complete public source rows, never truncated strings.'),
  returned: z.number().int().describe('Items in this response, not a total.'),
  limit: z.number().int().describe('Effective inline item maximum.'),
  has_more: z.boolean().describe('Whether the indicated continuation has more work.'),
  next_cursor: z
    .string()
    .optional()
    .describe('Opaque continuation pointing at the first unconsumed item or source work.'),
  phase: z
    .enum(['membership', 'source', 'preview'])
    .describe('Work addressed by the continuation.'),
  source_complete: z
    .boolean()
    .describe(
      'All selected source rows are contained in this output or its current staged partition; false after earlier rows were delivered.',
    ),
  provenance: provenanceSchema,
  notices: z.array(z.string()).describe('Scope, paging and interpretation guidance.'),
  dataset: datasetSchema.optional(),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True when this inline preview omits retained or unfetched source rows; follow the exact continuation or live dataset.',
    ),
  record_identity: z.string().optional().describe('Identity of the oversized record being read.'),
  encoding: z
    .literal('json')
    .optional()
    .describe('Concatenated text is the exact serialized JSON record.'),
  text: z.string().optional().describe('Lossless code-point-aligned record text chunk.'),
  offset: z.number().int().optional().describe('Unicode code-point offset of this chunk.'),
};
/** Normalized source output used by producers and staging integration. */
export type SourceOutput = z.infer<z.ZodObject<typeof sourceOutputShape>>;
/** Render every value reversibly as labeled data without emitting a duplicate raw JSON object. */
export function formatSource(result: Record<string, unknown>): { type: 'text'; text: string }[] {
  const lines: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      if (!value.length) lines.push(`${path} = []`);
      for (const [index, child] of value.entries()) visit(child, `${path}[${index}]`);
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) lines.push(`${path} = {}`);
      for (const [key, child] of entries)
        if (child !== undefined)
          visit(child, path ? `${path}.${JSON.stringify(key)}` : JSON.stringify(key));
    } else if (value !== undefined) lines.push(`${path} = ${JSON.stringify(value)}`);
  };
  visit(result, '');
  return [{ type: 'text', text: lines.join('\n') }];
}
/** Actual serialized MCP dual-surface bytes, including envelope and notices. */
export function wireBytes(result: Record<string, unknown>): number {
  return new TextEncoder().encode(
    JSON.stringify({ content: formatSource(result), structuredContent: result }),
  ).byteLength;
}
