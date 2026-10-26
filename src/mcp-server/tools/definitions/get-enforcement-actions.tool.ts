/**
 * @fileoverview Retrieve enforcement actions separately from composite-key associations.
 * @module mcp-server/tools/definitions/get-enforcement-actions
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { dateFields, optionalText, pagingFields, requiredPwsid } from '@/domain/source-inputs.js';
import { formatSource, sourceOutputShape } from '@/domain/source-output.js';
import { produceSource } from '@/services/sdwis/drinking-water-service.js';

/** Read public enforcement source text and explicitly paged association rows. */
export const getEnforcementActionsTool = tool('sdwis_get_enforcement_actions', {
  description:
    'Retrieve a public water system’s reported enforcement actions or their violation associations. section actions returns source action codes, originator, calendar date and untrusted source comments; it does not imply every record is a federal order or a monetary penalty. section associations pages composite PWSID/violation/action keys and reported snapshot-quarter fields separately. Date filters mean inclusive enforcement date and apply only to actions. Pass violation_id to select related actions through composite association joins. Set stage true for a bounded analytical partition.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    pwsid: requiredPwsid.describe(
      'Exact nine-character alphanumeric PWSID from sdwis_search_water_systems; unknown but shaped IDs return no matches.',
    ),
    section: z
      .enum(['actions', 'associations'])
      .default('actions')
      .describe(
        'Actions by default; associations has independent paging and does not accept action/date predicates.',
      ),
    violation_id: optionalText(
      'Exact violation_id returned by sdwis_get_violations; always joined together with PWSID.',
    ),
    ...dateFields,
    ...pagingFields,
    action_type: optionalText('Exact enforcement-action type code; actions section only.'),
    originator: optionalText('Exact reported originator code; actions section only.'),
    stage: z
      .boolean()
      .default(false)
      .describe('Stage a bounded source partition with enabled DataCanvas.'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Explicit existing canvas capability; requires stage true.',
    ),
    stage_max_rows: z
      .number()
      .int()
      .positive()
      .default(5000)
      .describe('Partition row request; above the effective cap 25000 is clamped with a notice.'),
  }),
  output: z.object(sourceOutputShape),
  errors: [
    {
      reason: 'selection_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
      when: 'Live selections or retained source data reached the process capacity.',
      recovery:
        'Wait fifteen minutes for source selections to expire, then retry with narrower selectors.',
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
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Association section contains action-only selectors.',
      recovery:
        'Use sdwis_list_reference to check identifiers and dataset-specific selectors, then retry the source tool.',
    },
    {
      reason: 'cursor_invalid',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Continuation expired or changed selectors.',
      recovery:
        'Repeat the same source tool with the original filters and omit cursor to begin again.',
    },
    {
      reason: 'source_changed',
      code: JsonRpcErrorCode.Conflict,
      thrownBy: 'service',
      when: 'EPA source metadata changed during retrieval.',
      recovery:
        'Repeat the same source tool without cursor to retrieve the newly published source revision.',
    },
    {
      reason: 'upstream_contract_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'EPA action or association schema changed.',
      recovery:
        'Retry the source tool later; the EPA response no longer matches the verified table contract.',
    },
    {
      reason: 'upstream_paging_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'EPA pages repeat without progress.',
      recovery:
        'Repeat the source tool without cursor or narrow the selection while EPA paging is unstable.',
    },
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ConfigurationError,
      thrownBy: 'service',
      when: 'Staging requested without an initialized canvas.',
      recovery:
        'Use the source tool without stage, or run the npm or Docker server with CANVAS_PROVIDER_TYPE=duckdb.',
    },
    {
      reason: 'item_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'One complete action/comment exceeds the inline wire budget.',
      recovery:
        'Repeat this tool with view text and the returned record_cursor to read the complete record in text chunks.',
    },
  ],
  handler(input, ctx) {
    if (
      input.section === 'associations' &&
      (input.date_from || input.date_to || input.action_type || input.originator)
    )
      throw ctx.fail(
        'invalid_selector',
        'Association paging accepts violation_id but action/date predicates require section actions.',
      );
    return produceSource(
      'sdwis_get_enforcement_actions',
      input.section === 'actions' ? 'enforcement_action' : 'violation_enf_assoc',
      input,
      ctx,
    );
  },
  format: formatSource,
});
