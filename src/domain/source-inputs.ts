/**
 * @fileoverview Shared drinking-water selector normalization and input contracts.
 * @module domain/source-inputs
 */
import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { calendarDate } from './sdwis-contracts.js';

/** Optional strings treat blank client-form values as unset. */
export function optionalText(description: string) {
  return z
    .preprocess(
      (value) => (typeof value === 'string' ? value.trim() || undefined : value),
      z.string().optional(),
    )
    .describe(description);
}
/** Shared paging selectors; the effective inline cap is applied by the producer. */
export const pagingFields = {
  cursor: optionalText(
    'Opaque continuation from this tool; retain exactly the original selectors.',
  ),
  limit: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe(
      'Inline items requested; values above the effective maximum 100 are clamped with a notice.',
    ),
  view: z
    .enum(['records', 'text'])
    .default('records')
    .describe('Records by default; text reads an oversized record losslessly using record_cursor.'),
  record_cursor: optionalText(
    'Signed oversized-record pointer returned by this same tool; use with view text.',
  ),
};
/** Geographic membership selectors, resolved before querying fact tables. */
export const geographyFields = {
  pwsid: optionalText(
    'Exact nine-character alphanumeric PWSID, including numeric tribal prefixes and alphabetic suffixes.',
  ),
  state: optionalText(
    'Reported WATER_SYSTEM legal-entity postal state or territory name/code; not a physical service boundary.',
  ),
  county: optionalText(
    'County served, requiring state; terminal County is ignored for matching, never inferred from operator address.',
  ),
};
/** Analytical interval selectors use inclusive source calendar-date overlap. */
export const dateFields = {
  date_from: optionalText(
    'Inclusive YYYY-MM-DD lower date; violations use compliance-period overlap, LCR sample-period overlap, actions enforcement date.',
  ),
  date_to: optionalText(
    'Inclusive YYYY-MM-DD upper date; unknown source dates do not match a requested date interval.',
  ),
};
const stateNames =
  'Alabama:AL|Alaska:AK|Arizona:AZ|Arkansas:AR|California:CA|Colorado:CO|Connecticut:CT|Delaware:DE|District of Columbia:DC|Florida:FL|Georgia:GA|Hawaii:HI|Idaho:ID|Illinois:IL|Indiana:IN|Iowa:IA|Kansas:KS|Kentucky:KY|Louisiana:LA|Maine:ME|Maryland:MD|Massachusetts:MA|Michigan:MI|Minnesota:MN|Mississippi:MS|Missouri:MO|Montana:MT|Nebraska:NE|Nevada:NV|New Hampshire:NH|New Jersey:NJ|New Mexico:NM|New York:NY|North Carolina:NC|North Dakota:ND|Ohio:OH|Oklahoma:OK|Oregon:OR|Pennsylvania:PA|Rhode Island:RI|South Carolina:SC|South Dakota:SD|Tennessee:TN|Texas:TX|Utah:UT|Vermont:VT|Virginia:VA|Washington:WA|West Virginia:WV|Wisconsin:WI|Wyoming:WY|American Samoa:AS|Guam:GU|Northern Mariana Islands:MP|Puerto Rico:PR|Virgin Islands:VI|United States Virgin Islands:VI|Federated States of Micronesia:FM|Marshall Islands:MH|Palau:PW';
const states = new Map<string, string>();
for (const entry of stateNames.split('|')) {
  const [name, code] = entry.split(':');
  if (name && code) {
    states.set(name.toUpperCase(), code);
    states.set(code, code);
  }
}
/** Normalize a complete state/territory name or postal abbreviation. */
export function normalizeState(value: string): string {
  const state = states.get(value.trim().toUpperCase());
  if (!state) throw validationError('Unknown state or territory.', { reason: 'invalid_selector' });
  return state;
}
/** Normalize selector strings without accepting path syntax or control characters. */
export function normalizeSelectors(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  for (const [key, value] of Object.entries(result))
    if (typeof value === 'string') {
      if (
        /[/\\?#%]/.test(value) ||
        Array.from(value).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw validationError('Selector contains path or control characters.', {
          reason: 'invalid_selector',
        });
      result[key] = value.trim();
    }
  if (typeof result.pwsid === 'string') {
    result.pwsid = result.pwsid.toUpperCase();
    if (!/^[A-Z0-9]{9}$/.test(String(result.pwsid)))
      throw validationError('PWSID must contain nine letters or digits.', {
        reason: 'invalid_selector',
      });
  }
  if (typeof result.state === 'string') {
    result.state = normalizeState(result.state);
    result.state_basis = 'reported_legal_entity';
  }
  if (result.county && !result.state)
    throw validationError('County requires a reported legal-entity state selector.', {
      reason: 'invalid_selector',
    });
  if (typeof result.county === 'string')
    result.county = result.county.replace(/ County$/i, '').toUpperCase();
  for (const key of ['date_from', 'date_to'])
    if (typeof result[key] === 'string') {
      try {
        result[key] = calendarDate(result[key]);
      } catch {
        throw validationError('Dates must be real YYYY-MM-DD calendar dates.', {
          reason: 'invalid_selector',
        });
      }
    }
  if (
    typeof result.date_from === 'string' &&
    typeof result.date_to === 'string' &&
    result.date_from > result.date_to
  )
    throw validationError('date_from must not follow date_to.', { reason: 'invalid_selector' });
  for (const key of [
    'contaminant',
    'category',
    'compliance_status',
    'action_type',
    'originator',
    'source',
    'system_type',
    'primacy_agency',
    'pwsid_prefix',
  ])
    if (typeof result[key] === 'string') result[key] = result[key].toUpperCase();
  return result;
}
