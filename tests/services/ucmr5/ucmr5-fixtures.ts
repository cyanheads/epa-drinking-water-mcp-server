/**
 * @fileoverview Tiny stored ZIP and CP1252 fixtures for the real UCMR ingestion seam.
 * @module tests/services/ucmr5/ucmr5-fixtures
 */
import { crc32 } from 'node:zlib';
import {
  additionalHeaders,
  occurrenceHeaders,
  zipHeaders,
} from '../../../src/domain/ucmr5-schemas.js';

/** One occurrence in source column order, with a censored blank measurement. */
export function occurrence(overrides: Record<string, string> = {}): string[] {
  const fields = [
    'WA1234567',
    'Water "District"',
    'L',
    'F1',
    'Plant',
    'SW',
    'SP1',
    'Entry',
    'EP',
    'AF1',
    'ASP1',
    '2/29/2024',
    'S1',
    'PFOA',
    '0.004',
    'µg/L',
    '533',
    '<',
    '',
    'SE1',
    'AM',
    '10',
    'WA',
    'SS',
  ];
  return occurrenceHeaders.map((name, position) => overrides[name] ?? fields[position] ?? '');
}

function tsv(headers: readonly string[], rows: string[][]): string {
  const quote = (value: string) =>
    /[\t\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `${[headers.join('\t'), ...rows.map((row) => row.map(quote).join('\t'))].join('\r\n')}\r\n`;
}

/** A complete publication; Latin-1 encoding deliberately writes the CP1252 micro sign byte. */
export function relations(rows = [occurrence()]): [string, Buffer][] {
  return [
    ['UCMR5_All.txt', Buffer.from(tsv(occurrenceHeaders, rows), 'latin1')],
    [
      'UCMR5_AddtlDataElem.txt',
      Buffer.from(
        tsv(additionalHeaders, [
          ['WA1234567', 'F1', 'SP1', 'SE1', 'Treatment', 'A', ''],
          ['WA1234567', 'F1', 'SP1', 'SE1', 'Treatment', 'B', 'Other\ttext\nnext line'],
          ['WA1234567', 'F1', 'SP1', 'SE2', 'Treatment', 'wrong event', ''],
          ['WA1234567', 'F2', 'SP1', 'SE1', 'Treatment', 'wrong facility', ''],
          ['WA1234567', 'F1', 'SP2', 'SE1', 'Treatment', 'wrong point', ''],
          ['OR1234567', 'F1', 'SP1', 'SE1', 'Treatment', 'wrong system', ''],
        ]),
        'latin1',
      ),
    ],
    [
      'UCMR5_ZIPCodes.txt',
      Buffer.from(
        tsv(zipHeaders, [
          ['WA1234567', '98101'],
          ['WA1234567', '98101'],
          ['WA1234567', '98102'],
          ['OR1234567', '98101'],
        ]),
        'latin1',
      ),
    ],
  ];
}

/** Build a standards-shaped stored ZIP without a fixture-only dependency. */
export function archive(entries = relations()): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
