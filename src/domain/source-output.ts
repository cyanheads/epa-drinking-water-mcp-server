/**
 * @fileoverview Source output envelope and reversible whole-row formatting.
 * @module domain/source-output
 */
import { z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';

/** JSON-safe source values, including sparse source nulls. */
export const rowSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe('Flat allowlisted source fields; null represents unknown source data.');
/** Public provenance, kept distinct from observation and snapshot dates. */
const provenanceSchema = z
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
const datasetSchema = z
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
/** Source-delivery identity is independent of filters and continuation work checkpoints. */
const selectionPartitionSchema = z.object({
  selection_id: z.string().describe('Stable identity of this source retrieval.'),
  partition: z.number().int().nonnegative().describe('Zero-based delivered source partition.'),
  final_partition: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe('Final source partition when exhaustion is known; otherwise null.'),
});
/** Canvas acquisition coverage does not establish SQL table lineage or result completeness. */
export const selectionCoverageSchema = z
  .array(
    z
      .object({
        selection_id: z
          .string()
          .describe('Stable source retrieval identity, independent of filters.'),
        partitions_present: z
          .array(z.number().int().nonnegative())
          .describe('Source partitions whose required relations are all live in this canvas.'),
        final_partition: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .describe('Observed final partition; null until exhaustion is known.'),
        chain_complete: z
          .boolean()
          .describe(
            'Every partition from zero through observed exhaustion and all required companions remain live; independent of SQL truncation and table references.',
          ),
      })
      .describe('Acquisition coverage for one source retrieval across live canvas relations.'),
  )
  .describe('Canvas-wide source acquisition coverage, snapshotted for retained SQL results.');
/** Compact source-chain coverage entry. */
export type SelectionCoverage = z.infer<typeof selectionCoverageSchema>;
/** Common source fields preserve whole rows and exact continuation positions. */
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
  selection_partition: selectionPartitionSchema
    .optional()
    .describe('Delivered source position; membership-only work has no position.'),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True when this inline preview omits retained or unfetched source rows; follow the exact continuation or live dataset.',
    ),
};
/** Normalized source output used by producers and staging integration. */
export type SourceOutput = z.infer<z.ZodObject<typeof sourceOutputShape>>;
/** Render every value reversibly as labeled data without emitting a duplicate raw JSON object. */
export function formatSource(result: Record<string, unknown>): { type: 'text'; text: string }[] {
  const lines: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      if (!value.length) lines.push(escapeMarkdownInline(`${path} = []`));
      for (const [index, child] of value.entries()) visit(child, `${path}[${index}]`);
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) lines.push(escapeMarkdownInline(`${path} = {}`));
      for (const [key, child] of entries)
        if (child !== undefined)
          visit(child, path ? `${path}.${JSON.stringify(key)}` : JSON.stringify(key));
    } else if (value !== undefined) {
      const serialized = JSON.stringify(value);
      const protocol =
        typeof value === 'string' && !/[\r\n]/.test(value) ? URL.parse(value)?.protocol : undefined;
      const rendered =
        protocol === 'http:' || protocol === 'https:'
          ? markdownLink(serialized, String(value))
          : escapeMarkdownInline(serialized);
      lines.push(`${escapeMarkdownInline(path)} = ${rendered}`);
    }
  };
  visit(result, '');
  return [{ type: 'text', text: lines.join('\n') }];
}
