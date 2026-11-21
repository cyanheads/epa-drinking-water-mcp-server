/**
 * @fileoverview Bundled interpretation references and live EPA code dictionaries.
 * @module mcp-server/tools/definitions/list-reference
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { bundledReference, dynamicReferenceTypes } from '@/domain/reference.js';
import { optionalText, pagingFields } from '@/domain/source-inputs.js';
import { formatSource, sourceOutputShape } from '@/domain/source-output.js';
import { produceSource } from '@/services/sdwis/drinking-water-service.js';

/** Decode selectors before querying evidence, keeping dynamic dictionary data distinct. */
export const listReferenceTool = tool('sdwis_list_reference', {
  description:
    'Decode drinking-water identifiers, contaminant codes, coverage and regulatory terminology before filtering records. identifiers, system_types, sources, standards and coverage are bundled reviewed reference; contaminants, violation_types, enforcement_types, treatment and service_areas retrieve the public EPA dictionary. Exact codes remain meaningful when a description is missing. Standards distinguish MCL, MCLG and action level and never classify historical rows as exceedances. UCMR analytes and SDWIS contaminant codes are separate namespaces; choose an explicit dataset in sdwis_search_contaminants.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    topic: z
      .enum([
        'identifiers',
        'system_types',
        'sources',
        'contaminants',
        'violation_types',
        'enforcement_types',
        'treatment',
        'service_areas',
        'standards',
        'coverage',
      ])
      .describe('Bundled interpretation topic or live EPA dictionary topic.'),
    query: optionalText(
      'Case-insensitive exact-field substring search within the selected reference topic.',
    ),
    ...pagingFields,
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
      reason: 'cursor_invalid',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Reference cursor expired or topic/query changed.',
      recovery:
        'Repeat the same source tool with the original filters and omit cursor to begin again.',
    },
    {
      reason: 'source_changed',
      code: JsonRpcErrorCode.Conflict,
      thrownBy: 'service',
      when: 'EPA dictionary metadata changed during retrieval.',
      recovery:
        'Repeat the same source tool without cursor to retrieve the newly published source revision.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'EPA reports a server error or transport attempts are exhausted.',
      recovery: 'Retry the source tool later when the EPA endpoint is available.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      thrownBy: 'service',
      when: 'The EPA endpoint returned HTTP 408.',
      recovery: 'Retry the source tool with narrower selectors or try again later.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
      when: 'The EPA endpoint returned HTTP 429.',
      recovery: 'Wait before retrying the source tool and reduce concurrent calls.',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      thrownBy: 'service',
      when: 'The EPA endpoint refused the request with HTTP 403.',
      recovery: 'Check whether the EPA endpoint is accessible from this server before retrying.',
    },
    {
      reason: 'upstream_contract_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'The fixed EPA endpoint rejected the request or live reference rows fail the public table contract.',
      recovery:
        'Retry the source tool later; the EPA response no longer matches the verified table contract.',
    },
    {
      reason: 'upstream_paging_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'Live reference paging repeats without progress.',
      recovery:
        'Repeat the source tool without cursor or narrow the selection while EPA paging is unstable.',
    },
  ],
  handler(input, ctx) {
    const type = dynamicReferenceTypes.get(input.topic);
    return produceSource(
      'sdwis_list_reference',
      'ref_code_value',
      { ...input, ...(type ? { value_type: type } : {}) },
      ctx,
      type ? undefined : bundledReference(input.topic),
    );
  },
  format: formatSource,
});
