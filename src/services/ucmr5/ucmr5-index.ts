/**
 * @fileoverview Bounded dictionary and typed-column storage for the three UCMR relations.
 * @module services/ucmr5/ucmr5-index
 */
import { setImmediate } from 'node:timers/promises';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  additionalColumns,
  occurrenceColumns,
  type Ucmr5AdditionalElement,
  type Ucmr5Occurrence,
  type Ucmr5ZipMembership,
  ucmr5OccurrenceSchema,
  zipColumns,
} from '../../domain/ucmr5-schemas.js';

const CHUNK = 16384;
const DAY_MS = 86400000;
const INDEX_BUDGET = 512 * 1024 * 1024;
type Cell = string | number | null;
/** Occurrence column positions read directly by the scan. */
const PWSID = occurrenceColumns.indexOf('pwsid');
const COLLECTION_DATE = occurrenceColumns.indexOf('collection_date');
const CONTAMINANT = occurrenceColumns.indexOf('contaminant');
const RESULT_SIGN = occurrenceColumns.indexOf('analytical_results_sign');
const RESULT_VALUE = occurrenceColumns.indexOf('analytical_result_value');

/** Fail closed on an unsupported archive rather than dropping fields or rows. */
export function datasetChanged(message: string, cause?: unknown): Error {
  return serviceUnavailable(
    message,
    { reason: 'dataset_changed' },
    cause === undefined ? undefined : { cause },
  );
}

class Column {
  readonly kind: 'string' | 'number' | 'date';
  readonly chunks: (Uint32Array | Float64Array | Int32Array)[] = [];
  readonly valid: Uint8Array[] = [];
  readonly values: string[] = [];
  dictionary = new Map<string, number>();
  dictionaryBytes = 0;
  arrayBytes = 0;

  constructor(kind: Column['kind']) {
    this.kind = kind;
  }

  append(text: string, row: number): void {
    const chunkId = Math.floor(row / CHUNK);
    const position = row % CHUNK;
    if (!this.chunks[chunkId]) {
      const chunk =
        this.kind === 'number'
          ? new Float64Array(CHUNK)
          : this.kind === 'date'
            ? new Int32Array(CHUNK)
            : new Uint32Array(CHUNK);
      this.chunks.push(chunk);
      this.arrayBytes += chunk.byteLength;
      if (this.kind === 'number') {
        const validity = new Uint8Array(CHUNK / 8);
        this.valid.push(validity);
        this.arrayBytes += validity.byteLength;
      }
    }
    const chunk = this.chunks[chunkId];
    if (!chunk) throw new Error('Missing allocated UCMR column chunk.');
    if (this.kind === 'string') {
      let code = this.dictionary.get(text);
      if (code === undefined) {
        code = this.values.length;
        this.values.push(text);
        this.dictionary.set(text, code);
        // Includes conservative string, array slot and dictionary-node accounting.
        this.dictionaryBytes += text.length * 2 + 96;
      }
      chunk[position] = code;
    } else if (this.kind === 'date') {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
      if (!match)
        throw datasetChanged('UCMR collection date no longer uses the supported calendar format.');
      const iso = `${match[3]}-${match[1]?.padStart(2, '0')}-${match[2]?.padStart(2, '0')}`;
      const millis = Date.parse(`${iso}T00:00:00Z`);
      if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== iso)
        throw datasetChanged('UCMR collection date is not a real calendar date.');
      chunk[position] = millis / DAY_MS;
    } else if (text !== '') {
      if (
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ||
        !Number.isFinite(Number(text))
      )
        throw datasetChanged('UCMR measurement is not a finite decimal number.');
      chunk[position] = Number(text);
      const validity = this.valid[chunkId];
      if (!validity) throw new Error('Missing UCMR numeric validity bitmap.');
      validity[position >> 3] = (validity[position >> 3] ?? 0) | (1 << (position & 7));
    }
  }

  get(row: number): Cell {
    const chunkId = Math.floor(row / CHUNK);
    const position = row % CHUNK;
    const value = this.chunks[chunkId]?.[position];
    if (value === undefined) throw new Error('UCMR row offset is outside the column.');
    if (this.kind === 'string') {
      const text = this.values[value];
      if (text === undefined) throw new Error('UCMR dictionary code is invalid.');
      return text;
    }
    if (this.kind === 'date') return new Date(value * DAY_MS).toISOString().slice(0, 10);
    return ((this.valid[chunkId]?.[position >> 3] ?? 0) & (1 << (position & 7))) === 0
      ? null
      : value;
  }
}

class Relation {
  readonly columns: Column[];
  count = 0;
  readonly names: readonly string[];
  constructor(names: readonly string[], occurrence = false) {
    this.names = names;
    this.columns = names.map(
      (name) =>
        new Column(
          occurrence && (name === 'mrl' || name === 'analytical_result_value')
            ? 'number'
            : occurrence && name === 'collection_date'
              ? 'date'
              : 'string',
        ),
    );
  }
  append(cells: string[]): void {
    if (cells.length !== this.columns.length)
      throw datasetChanged('UCMR TSV column count changed.');
    for (let i = 0; i < cells.length; i++) {
      const column = this.columns[i];
      const cell = cells[i];
      if (!column || cell === undefined) throw new Error('UCMR column contract mismatch.');
      if (this.names[i] === 'mrl' && cell === '')
        throw datasetChanged('UCMR minimum reporting level is missing.');
      column.append(cell, this.count);
    }
    this.count++;
  }
  cell(row: number, column: number): Cell {
    const selected = this.columns[column];
    if (!selected) throw new Error('Unknown UCMR column.');
    return selected.get(row);
  }
  row(row: number): Record<string, Cell> {
    const result: Record<string, Cell> = Object.create(null);
    for (let i = 0; i < this.names.length; i++) {
      const name = this.names[i];
      if (name) result[name] = this.cell(row, i);
    }
    return result;
  }
  measurements(): { typedArrayBytes: number; dictionaryEstimatedBytes: number } {
    return this.columns.reduce(
      (total, column) => ({
        typedArrayBytes: total.typedArrayBytes + column.arrayBytes,
        dictionaryEstimatedBytes: total.dictionaryEstimatedBytes + column.dictionaryBytes,
      }),
      { typedArrayBytes: 0, dictionaryEstimatedBytes: 0 },
    );
  }
  finish(): void {
    for (const column of this.columns) column.dictionary.clear();
  }
}

/** Filters apply to occurrence rows; reported state membership is resolved by SDWIS first. */
export interface Ucmr5Selection {
  contaminant?: string;
  dateFrom?: string;
  dateTo?: string;
  detectedOnly?: boolean;
  pwsids?: ReadonlySet<string>;
}
/** Source offsets refer to the next unconsumed occurrence row in the exact archive revision. */
export interface Ucmr5Page {
  exhausted: boolean;
  items: Ucmr5Occurrence[];
  nextOffset: number;
}

/** One complete columnar archive revision; no materialized national row array. */
export class Ucmr5Index {
  private readonly occurrence = new Relation(occurrenceColumns, true);
  private readonly additional = new Relation(additionalColumns);
  private readonly zip = new Relation(zipColumns);
  private readonly zipKeys = new Set<string>();

  append(relation: 'occurrence' | 'additional' | 'zip', cells: string[]): void {
    if (!/^[A-Z0-9]{9}$/.test(cells[0] ?? ''))
      throw datasetChanged('UCMR system identifier contract changed.');
    if (relation === 'zip') {
      const key = JSON.stringify(cells);
      if (this.zipKeys.has(key)) return;
      this.zipKeys.add(key);
    }
    this[relation].append(cells);
    if ((this[relation].count & 16383) === 0) this.checkBudget();
  }
  private checkBudget(): void {
    const memory = this.measurements();
    if (memory.retainedEstimatedBytes > INDEX_BUDGET)
      throw datasetChanged('UCMR columnar index exceeds its 512 MiB memory budget.');
  }
  finish(): void {
    this.checkBudget();
    this.zipKeys.clear();
    this.occurrence.finish();
    this.additional.finish();
    this.zip.finish();
  }

  /** Actual typed allocation sizes and conservative dictionary accounting, with row counts. */
  measurements() {
    let typedArrayBytes = 0;
    let dictionaryEstimatedBytes = 0;
    for (const relation of [this.occurrence, this.additional, this.zip]) {
      const memory = relation.measurements();
      typedArrayBytes += memory.typedArrayBytes;
      dictionaryEstimatedBytes += memory.dictionaryEstimatedBytes;
    }
    return {
      occurrenceRows: this.occurrence.count,
      additionalRows: this.additional.count,
      zipMembershipRows: this.zip.count,
      typedArrayBytes,
      dictionaryEstimatedBytes,
      retainedEstimatedBytes: typedArrayBytes + dictionaryEstimatedBytes,
      budgetBytes: INDEX_BUDGET,
    };
  }

  /** Read only selected rows, retaining duplicates and source order. */
  async search(
    selection: Ucmr5Selection,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<Ucmr5Page> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > this.occurrence.count ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      throw new Error('Invalid internal UCMR page bounds.');
    const contaminant = selection.contaminant?.toLowerCase();
    if (
      contaminant &&
      contaminant !== 'pfas' &&
      !this.contaminants().some((name) => name.toLowerCase() === contaminant)
    )
      throw validationError('Unknown UCMR analyte; choose an exact archive analyte or PFAS.', {
        reason: 'unknown_contaminant',
      });
    const items: Ucmr5Occurrence[] = [];
    let position = offset;
    for (; position < this.occurrence.count; position++) {
      if ((position & 16383) === 0) {
        await setImmediate(undefined, { signal });
        signal.throwIfAborted();
      }
      if (selection.pwsids && !selection.pwsids.has(String(this.occurrence.cell(position, PWSID))))
        continue;
      const analyte = String(this.occurrence.cell(position, CONTAMINANT));
      if (
        contaminant &&
        (contaminant === 'pfas'
          ? analyte.toLowerCase() === 'lithium'
          : analyte.toLowerCase() !== contaminant)
      )
        continue;
      if (
        selection.detectedOnly &&
        (this.occurrence.cell(position, RESULT_SIGN) !== '=' ||
          this.occurrence.cell(position, RESULT_VALUE) === null)
      )
        continue;
      const date = String(this.occurrence.cell(position, COLLECTION_DATE));
      if (
        (selection.dateFrom && date < selection.dateFrom) ||
        (selection.dateTo && date > selection.dateTo)
      )
        continue;
      const row = this.occurrence.row(position);
      items.push(
        ucmr5OccurrenceSchema.parse({ ...row, censored: row.analytical_results_sign === '<' }),
      );
      if (items.length === limit) {
        position++;
        break;
      }
    }
    signal.throwIfAborted();
    return { items, nextOffset: position, exhausted: position === this.occurrence.count };
  }

  /** Return every companion row matching the selected occurrence keys, without multiplying occurrences. */
  async companions(
    rows: readonly Ucmr5Occurrence[],
    signal: AbortSignal,
  ): Promise<{ additional: Ucmr5AdditionalElement[]; zipMemberships: Ucmr5ZipMembership[] }> {
    const pwsids = new Set(rows.map((row) => row.pwsid));
    const keys = new Set(
      rows.map((row) =>
        JSON.stringify([row.pwsid, row.facility_id, row.sample_point_id, row.sample_event_code]),
      ),
    );
    const additional: Ucmr5AdditionalElement[] = [];
    const zipMemberships: Ucmr5ZipMembership[] = [];
    for (let i = 0; i < this.additional.count; i++) {
      if ((i & 16383) === 0) await setImmediate(undefined, { signal });
      if (!pwsids.has(String(this.additional.cell(i, 0)))) continue;
      if (!keys.has(JSON.stringify([0, 1, 2, 3].map((column) => this.additional.cell(i, column)))))
        continue;
      const row = this.additional.row(i);
      additional.push({
        pwsid: String(row.pwsid),
        facility_id: String(row.facility_id),
        sample_point_id: String(row.sample_point_id),
        sample_event_code: String(row.sample_event_code),
        additional_data_element: String(row.additional_data_element),
        response: String(row.response),
        if_other_text: String(row.if_other_text),
      });
    }
    for (let i = 0; i < this.zip.count; i++) {
      if ((i & 16383) === 0) await setImmediate(undefined, { signal });
      if (pwsids.has(String(this.zip.cell(i, 0))))
        zipMemberships.push({
          pwsid: String(this.zip.cell(i, 0)),
          zip_code: String(this.zip.cell(i, 1)),
        });
    }
    signal.throwIfAborted();
    return { additional, zipMemberships };
  }
  /** Exact analyte spellings supplied by this archive revision. */
  contaminants(): string[] {
    return [...(this.occurrence.columns[CONTAMINANT]?.values ?? [])];
  }
  /** Distinct system membership for a service ZIP, independent of occurrence cardinality. */
  zipPwsids(zip: string): ReadonlySet<string> {
    const matches = new Set<string>();
    for (let i = 0; i < this.zip.count; i++)
      if (this.zip.cell(i, 1) === zip) matches.add(String(this.zip.cell(i, 0)));
    return matches;
  }
}
