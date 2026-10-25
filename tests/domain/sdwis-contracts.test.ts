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
  it.each(['2024-02-30', '2023-02-29', '2024-01-01T00:00:00Z', 'not-a-date'])(
    'rejects invalid source date %s',
    (value) => {
      expect(() =>
        parseRows('violation', [{ pwsid: 'WA1234567', violation_id: 'V', rtc_date: value }]),
      ).toThrow(expect.objectContaining({ data: { reason: 'upstream_contract_changed' } }));
    },
  );
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
    expect(sortColumns('violation')).toEqual(['pwsid', 'violation_id']);
    expect(sortColumns('lcr_sample_result')).toEqual(['pwsid', 'sample_id', 'sar_id']);
    expect(sortColumns('geographic_area')).toContain('geo_id');
    expect(sortColumns('geographic_area')).toContain('state_served');
  });
});
