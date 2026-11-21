/** @fileoverview Derived public label columns and their EPA dictionary types. */
import type { Table } from './sdwis-contracts.js';

type LabelColumn = readonly [column: string, valueType: string, selector?: string];

/** Code columns whose EPA descriptions are supplied with facts and staged schemas. */
export const labelColumns: Partial<Record<Table, readonly LabelColumn[]>> = {
  violation: [
    ['contaminant_code', 'CONTAMINANT_CODE', 'contaminant'],
    ['violation_code', 'VIOLATION_CODE'],
    ['violation_category_code', 'VIOLATION_CATEGORY_CODE', 'category'],
    ['compliance_status_code', 'COMPLIANCE_STATUS_CODE', 'compliance_status'],
    ['rule_code', 'RULE_CODE'],
  ],
  enforcement_action: [
    ['enforcement_action_type_code', 'ENFORCEMENT_ACTION_TYPE_CODE'],
    ['originator_code', 'ORIGINATOR_CODE', 'originator'],
  ],
  water_system_facility: [['facility_type_code', 'FACILITY_TYPE_CODE']],
  treatment: [
    ['treatment_objective_code', 'TREATMENT_OBJECTIVE_CODE'],
    ['treatment_process_code', 'TREATMENT_PROCESS_CODE'],
  ],
  lcr_sample_result: [['contaminant_code', 'CONTAMINANT_CODE']],
};

/** Derive the public description key from its matching public code key. */
export function labelField(column: string): string {
  return column.replace(/_code$/, '_label');
}
