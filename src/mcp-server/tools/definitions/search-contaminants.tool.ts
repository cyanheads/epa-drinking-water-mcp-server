/**
 * @fileoverview Keep violation, LCR and UCMR occurrence namespaces distinct.
 * @module mcp-server/tools/definitions/search-contaminants
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { resolveContaminant } from '@/domain/reference.js';
import { dateFields, geographyFields, optionalText, pagingFields } from '@/domain/source-inputs.js';
import { formatSource, sourceOutputShape } from '@/domain/source-output.js';
import { produceSource, produceUcmr } from '@/services/sdwis/drinking-water-service.js';

/** Retrieve one explicitly selected contaminant evidence dataset. */
export const searchContaminantsTool = tool('sdwis_search_contaminants', {
  description:
    'Retrieve SDWIS violations, Lead and Copper Rule summaries or UCMR 5 occurrence measurements by explicitly choosing dataset. Lead/arsenic/nitrate/TTHM aliases in violations resolve to SDWIS codes; LCR lead/copper resolve to PB90/CU90 summaries, which are not individual household samples. UCMR PFAS covers 29 analytes and lithium is separate; censored values remain unknown below reporting limits. ZIP and detected_only apply only to UCMR. Dates select compliance periods, LCR sample periods or UCMR collection dates respectively. Stage analytical partitions only when DataCanvas is enabled and retain all continuations.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    dataset: z
      .enum(['violations', 'lcr', 'ucmr5'])
      .describe('Evidence source; incompatible dataset selectors fail before any HTTP request.'),
    ...geographyFields,
    ...dateFields,
    ...pagingFields,
    zip: optionalText('Five-digit UCMR service-membership ZIP, not sample location; UCMR only.'),
    contaminant: optionalText(
      'Exact dataset-specific code/analyte or known alias; PFAS is a UCMR family selector.',
    ),
    detected_only: z
      .boolean()
      .optional()
      .describe(
        'UCMR only: true requires sign = with a numeric value; censored results are never zero.',
      ),
    stage: z
      .boolean()
      .default(false)
      .describe('Stage a bounded analytical partition with enabled DataCanvas.'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Explicit canvas capability; requires stage true.',
    ),
    stage_max_rows: z
      .number()
      .int()
      .positive()
      .default(5000)
      .describe(
        'Requested source partition size, clamped above the effective maximum 25000 with a notice.',
      ),
  }),
  output: z.object(sourceOutputShape),
  errors: [
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Required scope missing or a selector belongs to a different dataset.',
      recovery:
        'Use sdwis_list_reference to check identifiers and dataset-specific selectors, then retry the source tool.',
    },
    {
      reason: 'unknown_contaminant',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'An exact code or analyte cannot be resolved.',
      recovery:
        'Use sdwis_list_reference with topic contaminants to choose an exact code or analyte.',
    },
    {
      reason: 'cursor_invalid',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Cursor expired or selected filters changed.',
      recovery:
        'Repeat the same source tool with the original filters and omit cursor to begin again.',
    },
    {
      reason: 'source_changed',
      code: JsonRpcErrorCode.Conflict,
      thrownBy: 'service',
      when: 'Archive revision or DMAP metadata changed.',
      recovery:
        'Repeat the same source tool without cursor to retrieve the newly published source revision.',
    },
    {
      reason: 'upstream_contract_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'EPA rows fail verified table or predicate contracts.',
      recovery:
        'Retry the source tool later; the EPA response no longer matches the verified table contract.',
    },
    {
      reason: 'upstream_paging_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'EPA pages repeat without source progress.',
      recovery:
        'Repeat the source tool without cursor or narrow the selection while EPA paging is unstable.',
    },
    {
      reason: 'dataset_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'UCMR archive exceeds its verified publication schema or size.',
      recovery:
        'Use sdwis_list_reference with topic coverage for the supported UCMR publication, then retry after the parser is updated.',
    },
    {
      reason: 'dataset_loading',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      thrownBy: 'service',
      when: 'Another live caller owns an archive acquisition beyond this caller deadline.',
      recovery:
        'Retry sdwis_search_contaminants after the current UCMR archive acquisition finishes, using a longer client timeout.',
    },
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ConfigurationError,
      thrownBy: 'service',
      when: 'No real staging service is configured.',
      recovery:
        'Use the source tool without stage, or run the npm or Docker server with CANVAS_PROVIDER_TYPE=duckdb.',
    },
    {
      reason: 'item_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A complete record cannot fit inline.',
      recovery:
        'Repeat this tool with view text and the returned record_cursor to read the complete record in text chunks.',
    },
  ],
  handler(input, ctx) {
    if (!input.pwsid && !input.state) throw ctx.fail('invalid_selector', 'Provide pwsid or state.');
    if (input.canvas_id && !input.stage)
      throw ctx.fail('invalid_selector', 'canvas_id requires stage true.');
    if (input.dataset !== 'ucmr5' && (input.zip !== undefined || input.detected_only !== undefined))
      throw ctx.fail('invalid_selector', 'zip and detected_only belong to dataset ucmr5 only.');
    if (input.zip && !/^\d{5}$/.test(input.zip))
      throw ctx.fail('invalid_selector', 'ZIP must contain exactly five digits.');
    if (input.dataset === 'ucmr5') return produceUcmr({ ...input, dataset: 'ucmr5' }, ctx);
    const contaminant = resolveContaminant(input.contaminant, input.dataset);
    return produceSource(
      'sdwis_search_contaminants',
      input.dataset === 'lcr' ? 'lcr_sample_result' : 'violation',
      { ...input, ...(contaminant ? { contaminant } : {}) },
      ctx,
    );
  },
  format: (result) => formatSource(result),
});
