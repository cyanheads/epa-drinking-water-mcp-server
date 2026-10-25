/**
 * @fileoverview Retrieve historical SDWA violations without inferring compliance.
 * @module mcp-server/tools/definitions/get-violations
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { resolveContaminant } from '@/domain/reference.js';
import { dateFields, geographyFields, optionalText, pagingFields } from '@/domain/source-inputs.js';
import { formatSource, sourceOutputShape } from '@/domain/source-output.js';
import { produceSource } from '@/services/sdwis/drinking-water-service.js';

/** Retrieve the selected published violation rows or stage a bounded partition. */
export const getViolationsTool = tool('sdwis_get_violations', {
  description:
    'Retrieve reported historical SDWA violations for a PWSID or reported legal-entity state, optionally narrowed by county, contaminant, category or compliance flags. Dates mean inclusive compliance-period overlap, not sampling dates; unknown dates do not match date filters. Monitoring/reporting violations may have no measured concentration. Missing records do not establish current compliance or water safety. Set stage true to acquire a bounded analytical partition, retaining every continuation before drawing complete conclusions.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    ...geographyFields,
    ...dateFields,
    ...pagingFields,
    contaminant: optionalText(
      'Exact SDWIS contaminant code or lead, arsenic, nitrate, TTHM; not a UCMR family selector.',
    ),
    category: optionalText(
      'Exact violation-category code; preserves monitoring/reporting distinctions.',
    ),
    health_based: z
      .boolean()
      .optional()
      .describe('Filter the source Y/N health-based indicator; unknown indicators are not false.'),
    compliance_status: optionalText(
      'Exact source compliance-status code, not a current safety verdict.',
    ),
    stage: z
      .boolean()
      .default(false)
      .describe('Acquire and stage a bounded source partition; requires enabled DataCanvas.'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Existing explicit canvas capability; accepted only with stage true.',
    ),
    stage_max_rows: z
      .number()
      .int()
      .positive()
      .default(5000)
      .describe(
        'Partition row request; above 25000 is clamped with a notice. Twenty upstream pages per call still bound acquisition.',
      ),
  }),
  output: z.object(sourceOutputShape),
  errors: [
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'PWSID/state missing or selectors are incompatible.',
      recovery:
        'Use sdwis_list_reference to check identifiers and dataset-specific selectors, then retry the source tool.',
    },
    {
      reason: 'unknown_contaminant',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Contaminant is not an exact supported alias or code.',
      recovery:
        'Use sdwis_list_reference with topic contaminants to choose an exact code or analyte.',
    },
    {
      reason: 'cursor_invalid',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Continuation expired or changed filters.',
      recovery:
        'Repeat the same source tool with the original filters and omit cursor to begin again.',
    },
    {
      reason: 'source_changed',
      code: JsonRpcErrorCode.Conflict,
      thrownBy: 'service',
      when: 'EPA metadata shifted within a retrieval.',
      recovery:
        'Repeat the same source tool without cursor to retrieve the newly published source revision.',
    },
    {
      reason: 'upstream_contract_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'EPA table no longer matches verified public schema.',
      recovery:
        'Retry the source tool later; the EPA response no longer matches the verified table contract.',
    },
    {
      reason: 'upstream_paging_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'EPA source paging does not progress.',
      recovery:
        'Repeat the source tool without cursor or narrow the selection while EPA paging is unstable.',
    },
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ConfigurationError,
      thrownBy: 'service',
      when: 'Staging was requested without a real configured canvas.',
      recovery:
        'Use the source tool without stage, or run the npm or Docker server with CANVAS_PROVIDER_TYPE=duckdb.',
    },
    {
      reason: 'item_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A complete row exceeds the inline response budget.',
      recovery:
        'Repeat this tool with view text and the returned record_cursor to read the complete record in text chunks.',
    },
  ],
  handler(input, ctx) {
    if (!input.pwsid && !input.state) throw ctx.fail('invalid_selector', 'Provide pwsid or state.');
    const contaminant = resolveContaminant(input.contaminant, 'violations');
    return produceSource(
      'sdwis_get_violations',
      'violation',
      { ...input, ...(contaminant ? { contaminant } : {}) },
      ctx,
    );
  },
  format: (result) => formatSource(result),
});
