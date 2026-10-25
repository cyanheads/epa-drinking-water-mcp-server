/**
 * @fileoverview UCMR 5 source columns and contact-free normalized relation contracts.
 * @module domain/ucmr5-schemas
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Exact supported occurrence header; order is part of the publication contract. */
export const occurrenceHeaders = [
  'PWSID',
  'PWSName',
  'Size',
  'FacilityID',
  'FacilityName',
  'FacilityWaterType',
  'SamplePointID',
  'SamplePointName',
  'SamplePointType',
  'AssociatedFacilityID',
  'AssociatedSamplePointID',
  'CollectionDate',
  'SampleID',
  'Contaminant',
  'MRL',
  'Units',
  'MethodID',
  'AnalyticalResultsSign',
  'AnalyticalResultValue',
  'SampleEventCode',
  'MonitoringRequirement',
  'Region',
  'State',
  'UCMR1SampleType',
] as const;
/** Normalized occurrence names in source order. */
export const occurrenceColumns = [
  'pwsid',
  'pws_name',
  'size',
  'facility_id',
  'facility_name',
  'facility_water_type',
  'sample_point_id',
  'sample_point_name',
  'sample_point_type',
  'associated_facility_id',
  'associated_sample_point_id',
  'collection_date',
  'sample_id',
  'contaminant',
  'mrl',
  'units',
  'method_id',
  'analytical_results_sign',
  'analytical_result_value',
  'sample_event_code',
  'monitoring_requirement',
  'region',
  'state',
  'ucmr1_sample_type',
] as const;
/** Exact additional-element header. */
export const additionalHeaders = [
  'PWSID',
  'FacilityID',
  'SamplePointID',
  'SampleEventCode',
  'AdditionalDataElement',
  'Response',
  'IfOtherText',
] as const;
/** Additional elements retain a one-to-many relationship to occurrence keys. */
export const additionalColumns = [
  'pwsid',
  'facility_id',
  'sample_point_id',
  'sample_event_code',
  'additional_data_element',
  'response',
  'if_other_text',
] as const;
/** Exact ZIP membership header. */
export const zipHeaders = ['PWSID', 'ZIPCODE'] as const;
/** Service ZIP membership is not a sample location. */
export const zipColumns = ['pwsid', 'zip_code'] as const;

const text = z.string().describe('Exact source text, including blank values.');
/** All 24 occurrence fields plus explicit censoring; no compliance inference. */
export const ucmr5OccurrenceSchema = z.object({
  pwsid: text,
  pws_name: text,
  size: text,
  facility_id: text,
  facility_name: text,
  facility_water_type: text,
  sample_point_id: text,
  sample_point_name: text,
  sample_point_type: text,
  associated_facility_id: text,
  associated_sample_point_id: text,
  collection_date: z.string().describe('ISO calendar date of sample collection.'),
  sample_id: text,
  contaminant: text,
  mrl: z.number().finite().describe('Minimum reporting level in original units.'),
  units: text,
  method_id: text,
  analytical_results_sign: text,
  analytical_result_value: z
    .number()
    .finite()
    .nullable()
    .describe('Reported numeric result; censored blanks remain null.'),
  sample_event_code: text,
  monitoring_requirement: text,
  region: text,
  state: text,
  ucmr1_sample_type: text,
  censored: z.boolean().describe('True only when the source analytical results sign is less-than.'),
});
/** Normalized occurrence row reconstructed only when selected. */
export type Ucmr5Occurrence = z.infer<typeof ucmr5OccurrenceSchema>;
/** Separate one-to-many additional element relation. */
export type Ucmr5AdditionalElement = Record<(typeof additionalColumns)[number], string>;
/** Distinct service ZIP relation. */
export type Ucmr5ZipMembership = Record<(typeof zipColumns)[number], string>;
