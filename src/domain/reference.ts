/**
 * @fileoverview Reviewed drinking-water terminology, source coverage and exact aliases.
 * @module domain/reference
 */
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { PublicRow } from './sdwis-contracts.js';

const contaminantAliases = {
  lcr: new Map([
    ['LEAD', 'PB90'],
    ['COPPER', 'CU90'],
    ['PB90', 'PB90'],
    ['CU90', 'CU90'],
  ]),
  violations: new Map([
    ['LEAD', '1030,5000'],
    ['ARSENIC', '1005'],
    ['NITRATE', '1040'],
    ['TTHM', '2950'],
  ]),
};
/** Exact SDWIS aliases; LCR summary namespaces are deliberately separate. */
export function resolveContaminant(
  value: string | undefined,
  mode: 'violations' | 'lcr',
): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  const resolved = contaminantAliases[mode].get(normalized);
  if (resolved) return resolved;
  if (mode === 'violations' && /^[A-Z0-9]{4}$/.test(normalized)) return normalized;
  throw validationError(
    'Contaminant requires an exact code or a supported alias in the selected namespace.',
    { reason: 'unknown_contaminant' },
  );
}
/** Reference topics which query the public EPA dictionary rather than bundled terminology. */
export const dynamicReferenceTypes = new Map([
  ['contaminants', 'CONTAMINANT_CODE'],
  ['violation_types', 'VIOLATION_CODE'],
  ['enforcement_types', 'ENFORCEMENT_ACTION_TYPE_CODE'],
  ['treatment', 'TREATMENT_PROCESS_CODE'],
  ['service_areas', 'SERVICE_AREA_TYPE_CODE'],
]);
const standardsUrl =
  'https://www.epa.gov/ground-water-and-drinking-water/national-primary-drinking-water-regulations';
/** Small reviewed reference, never interpreted as a historical exceedance classifier. */
export function bundledReference(topic: string): PublicRow[] {
  switch (topic) {
    case 'identifiers':
      return [
        {
          code: 'PWSID',
          namespace: 'SDWIS',
          label:
            'Nine alphanumeric characters, including numeric tribal prefixes and alphabetic suffixes.',
          source: 'https://echo.epa.gov/tools/data-downloads/sdwa-download-summary',
        },
        {
          code: 'state',
          namespace: 'WATER_SYSTEM',
          label:
            'Reported legal-entity USPS state; not a complete physical service boundary. County matching intersects reported state with service membership.',
          source: 'https://echo.epa.gov/tools/data-downloads/sdwa-download-summary',
        },
        {
          code: 'PB90/CU90',
          namespace: 'LCR',
          label:
            'Lead/copper summaries; not individual household samples. Copper 1022 means COPPER, FREE and is not CU90.',
          source: 'https://echo.epa.gov/tools/data-downloads/sdwa-download-summary',
        },
      ];
    case 'system_types':
      return [
        { code: 'CWS', namespace: 'PWS_TYPE_CODE', label: 'Community water system' },
        {
          code: 'NTNCWS',
          namespace: 'PWS_TYPE_CODE',
          label: 'Non-transient non-community water system',
        },
        {
          code: 'TNCWS',
          namespace: 'PWS_TYPE_CODE',
          label: 'Transient non-community water system',
        },
      ];
    case 'sources':
      return [
        {
          code: 'SDWIS',
          label: 'Quarterly reported inventory, violations, enforcement and LCR summaries.',
          source: 'https://www.epa.gov/enviro/envirofacts-data-service-api',
        },
        {
          code: 'UCMR5',
          label:
            'Final occurrence dataset released August 2026; principally monitoring during 2023–2025.',
          source:
            'https://www.epa.gov/dwucmr/fifth-unregulated-contaminant-monitoring-rule-data-finder',
        },
      ];
    case 'coverage':
      return [
        {
          code: 'SDWIS',
          label:
            'SDWIS is a quarterly publication of reported records; missing or resolved historical records do not establish current compliance or water safety.',
          consistency: 'quarterly_non_atomic',
          source: 'https://echo.epa.gov/tools/data-downloads/sdwa-download-summary',
        },
        {
          code: 'UCMR5',
          label:
            'UCMR 5 occurrence results are not compliance monitoring; a missing result does not mean a contaminant is absent. MRL is a reporting threshold, not a health threshold. Monitoring participation is limited.',
          source:
            'https://www.epa.gov/dwucmr/occurrence-data-unregulated-contaminant-monitoring-rule',
        },
      ];
    case 'standards':
      return [
        {
          code: '1005',
          label: 'Arsenic',
          reference_type: 'mcl',
          value: 0.01,
          units: 'mg/L',
          effective_date: '2006-01-23',
          source: standardsUrl,
        },
        {
          code: '1005',
          label: 'Arsenic',
          reference_type: 'mclg',
          value: 0,
          units: 'mg/L',
          effective_date: null,
          source: standardsUrl,
        },
        {
          code: '1040',
          label: 'Nitrate as nitrogen',
          reference_type: 'mcl',
          value: 10,
          units: 'mg/L',
          effective_date: null,
          source: standardsUrl,
        },
        {
          code: '1040',
          label: 'Nitrate as nitrogen',
          reference_type: 'mclg',
          value: 10,
          units: 'mg/L',
          effective_date: null,
          source: standardsUrl,
        },
        {
          code: '2950',
          label: 'Total trihalomethanes',
          reference_type: 'mcl',
          value: 0.08,
          units: 'mg/L',
          effective_date: null,
          source: standardsUrl,
        },
        {
          code: 'CU90',
          label: 'Copper',
          reference_type: 'action_level',
          value: 1.3,
          units: 'mg/L',
          effective_date: null,
          source: standardsUrl,
        },
        {
          code: 'CU90',
          label: 'Copper',
          reference_type: 'mclg',
          value: 1.3,
          units: 'mg/L',
          effective_date: null,
          source: standardsUrl,
        },
        {
          code: 'PB90',
          label: 'Lead legacy LCR comparison reference; not a universal current threshold.',
          reference_type: 'action_level',
          value: 0.015,
          units: 'mg/L',
          effective_date: null,
          source: standardsUrl,
        },
        {
          code: 'PB90',
          label: 'Lead',
          reference_type: 'mclg',
          value: 0,
          units: 'mg/L',
          effective_date: null,
          source: standardsUrl,
        },
        {
          code: 'PFAS',
          label:
            'Consult the current EPA PFAS rule and implementation pages; pending rule changes affect applicability. Do not infer compliance from UCMR occurrence results.',
          reference_type: 'rule_context',
          effective_date: null,
          source: 'https://www.epa.gov/sdwa/and-polyfluoroalkyl-substances-pfas',
        },
      ];
    default:
      throw validationError('Unknown bundled reference topic.', { reason: 'invalid_selector' });
  }
}
