/**
 * @fileoverview Discover contact-free EPA public water systems.
 * @module mcp-server/tools/definitions/search-water-systems
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { geographyFields, optionalText, pagingFields } from '@/domain/source-inputs.js';
import { formatSource, sourceOutputShape } from '@/domain/source-output.js';
import { produceSource } from '@/services/sdwis/drinking-water-service.js';

/** Find public systems before selecting profiles or historical fact records. */
export const searchWaterSystemsTool = tool('sdwis_search_water_systems', {
  description:
    'Find public water systems by name, PWSID, reported legal-entity state, county served, population, activity or source. Supply at least one narrowing selector. Discovery defaults to active systems; activity all includes inactive inventory. State and county matches do not establish complete physical service boundaries. Pass a returned PWSID to sdwis_get_system_profile; continue incomplete selections with the same filters and next_cursor.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ...geographyFields,
    ...pagingFields,
    name_contains: optionalText('Case-insensitive substring of the reported system name.'),
    population_min: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Inclusive minimum reported population.'),
    population_max: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Inclusive maximum reported population; unknown populations do not match.'),
    source: optionalText('Exact primary-source code from sdwis_list_reference.'),
    system_type: optionalText('Exact system type such as CWS, NTNCWS or TNCWS.'),
    activity: z
      .enum(['active', 'inactive', 'all'])
      .default('active')
      .describe('Inventory activity filter; active by default, explicitly echoed.'),
    primacy_agency: optionalText(
      'Exact primacy-agency jurisdiction code; not a physical state selector.',
    ),
    pwsid_prefix: optionalText('Alphanumeric jurisdiction prefix; not a physical state selector.'),
  }),
  output: z.object(sourceOutputShape),
  errors: [
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No narrowing selector or invalid geography, ID or population range.',
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
      reason: 'upstream_contract_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'EPA schema or predicates differ from the verified contract.',
      recovery:
        'Retry the source tool later; the EPA response no longer matches the verified table contract.',
    },
    {
      reason: 'upstream_paging_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'EPA returned a repeated source boundary.',
      recovery:
        'Repeat the source tool without cursor or narrow the selection while EPA paging is unstable.',
    },
    {
      reason: 'item_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'One complete public record exceeds the inline wire budget.',
      recovery:
        'Repeat this tool with view text and the returned record_cursor to read the complete record in text chunks.',
    },
  ],
  handler(input, ctx) {
    if (
      ![
        input.pwsid,
        input.name_contains,
        input.state,
        input.county,
        input.source,
        input.system_type,
        input.primacy_agency,
        input.pwsid_prefix,
        input.population_min,
        input.population_max,
      ].some((value) => value !== undefined)
    )
      throw ctx.fail('invalid_selector', 'Provide at least one narrowing system selector.');
    if (
      input.population_min !== undefined &&
      input.population_max !== undefined &&
      input.population_min > input.population_max
    )
      throw ctx.fail('invalid_selector', 'population_min must not exceed population_max.');
    if (input.pwsid_prefix && !/^[A-Z0-9]{1,9}$/i.test(input.pwsid_prefix))
      throw ctx.fail(
        'invalid_selector',
        'PWSID prefix must contain one to nine letters or digits.',
      );
    return produceSource('sdwis_search_water_systems', 'water_system', input, ctx);
  },
  format: (result) => formatSource(result),
});
