/**
 * @fileoverview Contact-free SDWIS projections and strict source normalization.
 * @module domain/sdwis-contracts
 */
import { z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

const text = z.string().nullable().optional();
const number = z.number().finite().nullable().optional();
const identity = z.string().min(1);
const pwsid = z.string().regex(/^[A-Z0-9]{9}$/);
const base = { pwsid };
/** Validated, explicitly allowlisted public projections; unknown fields are stripped. */
export const tableSchemas = {
  water_system: z.object({
    ...base,
    pws_name: text,
    pws_activity_code: text,
    pws_type_code: text,
    state_code: text,
    primacy_agency_code: text,
    primacy_type: text,
    epa_region: text,
    primary_source_code: text,
    gw_sw_code: text,
    owner_type_code: text,
    source_water_protection_code: text,
    submission_status_code: text,
    population_served_count: number,
    service_connections_count: number,
    pws_deactivation_date: text,
    source_protection_begin_date: text,
    season_begin_date: text,
    season_end_date: text,
  }),
  geographic_area: z.object({
    ...base,
    geo_id: text,
    area_type_code: text,
    county_served: text,
    city_served: text,
    zip_code_served: text,
    state_served: text,
    tribal_code: text,
    ansi_entity_code: text,
    primacy_agency_code: text,
    epa_region: text,
  }),
  service_area: z.object({
    ...base,
    service_area_type_code: text,
    is_primary_service_area_code: text,
  }),
  treatment: z.object({
    ...base,
    facility_id: text,
    treatment_id: text,
    treatment_objective_code: text,
    treatment_process_code: text,
    comments_text: text,
  }),
  violation: z.object({
    ...base,
    violation_id: identity,
    facility_id: text,
    contaminant_code: text,
    violation_code: text,
    violation_category_code: text,
    rule_code: text,
    rule_family_code: text,
    rule_group_code: text,
    compliance_status_code: text,
    is_health_based_ind: text,
    is_major_viol_ind: text,
    latest_enforcement_id: text,
    rtc_enforcement_id: text,
    originator_code: text,
    unit_of_measure: text,
    compl_per_begin_date: text,
    compl_per_end_date: text,
    rtc_date: text,
    viol_measure: number,
    state_mcl: number,
    severity_ind_cnt: number,
    public_notification_tier: number,
    population_served_count: number,
  }),
  enforcement_action: z.object({
    ...base,
    enforcement_id: identity,
    enforcement_action_type_code: text,
    originator_code: text,
    enforcement_comment_text: text,
    enforcement_date: text,
  }),
  violation_enf_assoc: z.object({
    ...base,
    violation_id: identity,
    enforcement_id: identity,
    submissionyearquarter: text,
    submissionyear: number,
    submissionquarter: number,
  }),
  lcr_sample: z.object({
    ...base,
    sample_id: identity,
    sampling_start_date: text,
    sampling_end_date: text,
    reconciliation_id: text,
    primacy_agency_code: text,
    epa_region: text,
  }),
  lcr_sample_result: z.object({
    ...base,
    sample_id: identity,
    contaminant_code: text,
    result_sign_code: text,
    unit_of_measure: text,
    sample_measure: number,
    sar_id: z.union([z.string(), z.number().int().safe()]).nullable().optional(),
  }),
  ref_code_value: z.object({ value_type: identity, value_code: identity, value_description: text }),
} as const;
/** Known DMAP tables, never caller-selected raw paths. */
export type Table = keyof typeof tableSchemas;
/** Public JSON row; absence and source null remain distinct. */
export type PublicRow = Record<string, string | number | boolean | null>;
/** Stable deterministic source sorting, with all projected columns for nonunique tables. */
export function sortColumns(table: Table): string[] {
  const keys: Partial<Record<Table, string[]>> = {
    water_system: ['pwsid'],
    violation: ['pwsid', 'violation_id'],
    enforcement_action: ['pwsid', 'enforcement_id'],
    lcr_sample: ['pwsid', 'sample_id'],
    lcr_sample_result: ['pwsid', 'sample_id', 'sar_id'],
    ref_code_value: ['value_type', 'value_code'],
    treatment: ['pwsid', 'facility_id', 'treatment_id'],
  };
  return keys[table] ?? Object.keys(tableSchemas[table].shape);
}
/** Parse a real ISO calendar date without timezone inference. */
export function calendarDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?: 00:00:00)?$/.exec(value);
  if (!match?.[1] || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1])
    throw new Error('Invalid calendar date');
  return match[1];
}
/** Parse before returning or retaining a row, dropping every nonpublic upstream field. */
export function parseRows(table: Table, input: unknown): PublicRow[] {
  const parsed = z.array(tableSchemas[table]).safeParse(input);
  if (!parsed.success)
    throw serviceUnavailable('EPA response does not match the public table contract.', {
      reason: 'upstream_contract_changed',
    });
  return parsed.data.map((source) => {
    const row: PublicRow = {};
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (key.endsWith('_date') && typeof value === 'string') {
        try {
          row[key] = calendarDate(value);
        } catch (cause) {
          throw serviceUnavailable(
            'EPA returned an invalid calendar date.',
            {
              reason: 'upstream_contract_changed',
            },
            { cause },
          );
        }
      } else row[key] = key === 'sar_id' && typeof value === 'number' ? String(value) : value;
    }
    return row;
  });
}
