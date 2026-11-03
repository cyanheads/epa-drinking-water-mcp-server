/**
 * @fileoverview Public projection, identifiers and source calendar contracts.
 * @module tests/domain/sdwis-contracts.test
 */
import { describe, expect, it } from 'vitest';
import { calendarDate, parseRows, sortColumns } from '../../src/domain/sdwis-contracts.js';
import { normalizeSelectors, optionalText } from '../../src/domain/source-inputs.js';

describe('SDWIS public contracts', () => {
  it('strips unknown and contact columns while preserving sparse nulls and numeric IDs', () => {
    expect(
      parseRows('water_system', [
        {
          pwsid: '01234567A',
          state_code: null,
          population_served_count: null,
          phone_number: 'CONTACT-CANARY',
          unknown: 'CONTACT-CANARY',
        },
      ]),
    ).toEqual([{ pwsid: '01234567A', state_code: null, population_served_count: null }]);
    expect(
      parseRows('geographic_area', [{ pwsid: 'WA1234567', geo_id: null, state_served: null }]),
    ).toEqual([{ pwsid: 'WA1234567', geo_id: null, state_served: null }]);
    expect(
      parseRows('lcr_sample_result', [
        { pwsid: 'WA1234567', sample_id: 'S', sar_id: 123, sample_measure: null },
      ]),
    ).toEqual([{ pwsid: 'WA1234567', sample_id: 'S', sar_id: '123', sample_measure: null }]);
  });
  it.each([
    '2024-02-30',
    '2023-02-29',
    '2024-01-01T00:00:00Z',
    '2024-01-01 24:00:00',
    '2024-01-01 12:60:00',
    '2024-01-01 12:00:60',
    'not-a-date',
  ])('rejects invalid source date %s', (value) => {
    expect(() =>
      parseRows('violation', [{ pwsid: 'WA1234567', violation_id: 'V', rtc_date: value }]),
    ).toThrow(expect.objectContaining({ data: { reason: 'upstream_contract_changed' } }));
  });
  it('normalizes a valid nonmidnight EPA timestamp without losing its source text', () => {
    expect(
      parseRows('water_system', [
        { pwsid: 'WA1234567', pws_deactivation_date: '2013-02-19 10:42:29' },
      ]),
    ).toEqual([
      {
        pwsid: 'WA1234567',
        pws_deactivation_date: '2013-02-19',
        pws_deactivation_date_raw: '2013-02-19 10:42:29',
      },
    ]);
  });
  it('normalizes calendar dates and selectors without inferring geography', () => {
    expect(calendarDate('2024-02-29 00:00:00')).toBe('2024-02-29');
    expect(optionalText('optional').parse('  ')).toBeUndefined();
    expect(
      normalizeSelectors({
        pwsid: ' 01234567a ',
        state: 'washington',
        county: 'King County',
        contaminant: 'pb90',
      }),
    ).toEqual({
      pwsid: '01234567A',
      state: 'WA',
      state_basis: 'reported_legal_entity',
      county: 'KING',
      contaminant: 'PB90',
    });
  });
  it.each([
    { county: 'King' },
    { pwsid: 'WA123456/' },
    { state: 'XX' },
    { date_from: '2024-03-01', date_to: '2024-02-29' },
  ])('rejects invalid selector %j', (input) => {
    expect(() => normalizeSelectors(input)).toThrow(
      expect.objectContaining({ data: { reason: 'invalid_selector' } }),
    );
  });
  it('keeps system identity in fact sorts and all geographic tie breakers', () => {
    expect(sortColumns('water_system_facility')).toEqual(['pwsid', 'facility_id']);
    expect(sortColumns('violation')).toEqual(['pwsid', 'violation_id']);
    expect(sortColumns('lcr_sample_result')).toEqual(['pwsid', 'sample_id', 'sar_id']);
    expect(sortColumns('geographic_area')).toContain('geo_id');
    expect(sortColumns('geographic_area')).toContain('state_served');
  });
  it('requires composite facility identities and allowlists all public facility fields', () => {
    const row = {
      pwsid: 'WA1234567',
      facility_id: '0007',
      facility_name: null,
      state_facility_id: 'local',
      facility_type_code: 'TP',
      facility_activity_code: 'A',
      facility_deactivation_date: null,
      is_source_ind: 'N',
      is_source_treated_ind: 'Y',
      water_type_code: 'SW',
      availability_code: 'P',
      filtration_status_code: 'F',
      seller_pwsid: null,
      seller_pws_name: null,
      seller_treatment_code: null,
      submission_status_code: 'Y',
    };
    expect(
      parseRows('water_system_facility', [
        { ...row, contact: 'CONTACT-CANARY', pws_name: 'Not a facility field' },
      ]),
    ).toEqual([row]);
    for (const input of [
      { pwsid: 'WA1234567' },
      { pwsid: 'WA1234567', facility_id: '' },
      { facility_id: '0007' },
    ])
      expect(() => parseRows('water_system_facility', [input])).toThrow(
        expect.objectContaining({ data: { reason: 'upstream_contract_changed' } }),
      );
  });
});
