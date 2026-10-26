/** @fileoverview Raw selector compatibility and discoverable input formats. */

import process from 'node:process';
import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { dateFields, geographyFields, normalizeSelectors } from '@/domain/source-inputs.js';
import { getEnforcementActionsTool } from '@/mcp-server/tools/definitions/get-enforcement-actions.tool.js';
import { getSystemProfileTool } from '@/mcp-server/tools/definitions/get-system-profile.tool.js';
import { getViolationsTool } from '@/mcp-server/tools/definitions/get-violations.tool.js';
import { searchContaminantsTool } from '@/mcp-server/tools/definitions/search-contaminants.tool.js';
import { searchWaterSystemsTool } from '@/mcp-server/tools/definitions/search-water-systems.tool.js';

function patterns(input: z.ZodType) {
  return z.toJSONSchema(input, { io: 'input' }).properties as Record<string, { pattern?: string }>;
}
function pattern(input: z.ZodType, field: string) {
  const raw = patterns(input)[field]?.pattern;
  expect(typeof raw).toBe('string');
  return new RegExp(raw as string);
}

describe('raw source selector compatibility', () => {
  it('advertises raw optional and required ID forms without regex flags', () => {
    const optional = z.toJSONSchema(z.object(geographyFields), { io: 'input' }).properties?.pwsid;
    const required = z.toJSONSchema(getSystemProfileTool.input, { io: 'input' }).properties?.pwsid;
    for (const [schema, accepted, rejected] of [
      [
        optional,
        [
          'wa1234567',
          '01234567a',
          '\n wa1234567\t',
          '',
          '\n ',
          'wa12345ß',
          'wa123456ſ',
          'wa123456ı',
          'wa1234ﬃ',
        ],
        ['WA53', 'WA12345678', 'WA12\n3456'],
      ],
      [
        required,
        [
          'wa1234567',
          '01234567a',
          ' wa1234567 ',
          '\u00a0wa1234567\u00a0',
          'wa12345ß',
          'wa123456ſ',
          'wa123456ı',
          'wa1234ﬃ',
        ],
        ['', '\twa1234567', 'wa1234567\n'],
      ],
    ] as const) {
      expect(schema).toHaveProperty('pattern');
      const pattern = new RegExp((schema as { pattern: string }).pattern);
      for (const value of accepted) expect(pattern.test(value), JSON.stringify(value)).toBe(true);
      for (const value of rejected) expect(pattern.test(value), JSON.stringify(value)).toBe(false);
    }
  });
  it('preserves optional pretrim, required control rejection and semantic dates', () => {
    for (const [pwsid, normalized] of [
      ['wa12345ß', 'WA12345SS'],
      ['wa123456ſ', 'WA123456S'],
      ['wa123456ı', 'WA123456I'],
      ['wa1234ﬃ', 'WA1234FFI'],
    ])
      expect(normalizeSelectors({ pwsid }).pwsid).toBe(normalized);
    expect(
      normalizeSelectors(z.object(geographyFields).parse({ pwsid: '\n 01234567a\t' })).pwsid,
    ).toBe('01234567A');
    expect(z.object(geographyFields).parse({ pwsid: ' \n\t' }).pwsid).toBeUndefined();
    expect(
      normalizeSelectors(getSystemProfileTool.input.parse({ pwsid: ' wa1234567 ' })).pwsid,
    ).toBe('WA1234567');
    expect(() =>
      normalizeSelectors(getSystemProfileTool.input.parse({ pwsid: '\twa1234567' })),
    ).toThrow();
    expect(
      normalizeSelectors(z.object(dateFields).parse({ date_from: ' 2024-02-29 23:59:59 ' }))
        .date_from,
    ).toBe('2024-02-29');
    for (const date_from of ['2023-02-29', '2024-02-29 24:00:00', '2024-02-29T00:00:00Z'])
      expect(() => normalizeSelectors(z.object(dateFields).parse({ date_from }))).toThrow();
    expect(() => normalizeSelectors({ date_from: '2024-03-01', date_to: '2024-02-29' })).toThrow();
  });

  it('wires the shared grammar to every advertised consumer', () => {
    for (const tool of [
      getSystemProfileTool,
      getEnforcementActionsTool,
      getViolationsTool,
      searchContaminantsTool,
      searchWaterSystemsTool,
    ])
      expect(pattern(tool.input, 'pwsid').test('01234567a')).toBe(true);
    for (const tool of [getEnforcementActionsTool, getViolationsTool, searchContaminantsTool])
      for (const field of ['date_from', 'date_to'])
        expect(pattern(tool.input, field).test('\n 2024-02-29 12:34:56\t')).toBe(true);
  });

  it('does not narrow normalized IDs across positions, uppercase expansion and trimming', () => {
    const rawCases = ['wa1234567', '01234567a'];
    for (const value of ['a', 'ı', 'ſ', 'ß', 'ﬃ']) {
      const width = value.toUpperCase().length;
      for (let before = 0; before <= 9 - width; before++)
        rawCases.push('1'.repeat(before) + value + 'a'.repeat(9 - width - before));
    }
    for (const raw of rawCases)
      for (const trim of ['', ' ', '\u00a0', '\ufeff', '\t', '\r\n']) {
        const value = trim + raw + trim;
        const optional = z.object(geographyFields).parse({ pwsid: value });
        expect(String(normalizeSelectors(optional).pwsid)).toHaveLength(9);
        expect(pattern(getViolationsTool.input, 'pwsid').test(value)).toBe(true);
        if (!/[\x00-\x1f\x7f]/.test(trim)) {
          expect(String(normalizeSelectors({ pwsid: value }).pwsid)).toHaveLength(9);
          expect(pattern(getSystemProfileTool.input, 'pwsid').test(value)).toBe(true);
        }
      }
    // Prefix validation occurs before uppercasing and retains its existing ASCII-only grammar.
    expect(pattern(searchWaterSystemsTool.input, 'pwsid_prefix').test('ſ')).toBe(false);
    expect(/^[A-Z0-9]{1,9}$/i.test('ſ')).toBe(false);
  });

  it('advertises optional ZIP, prefix and date lexical forms without replacing semantic validation', () => {
    for (const [input, field, accepted, rejected] of [
      [
        searchContaminantsTool.input,
        'zip',
        ['', '\n ', ' 98101\t'],
        ['9810', '981011', '98101-1234', '98\n101'],
      ],
      [
        searchWaterSystemsTool.input,
        'pwsid_prefix',
        ['', '\n ', '0', ' wa123456a\t'],
        ['ABCDEFGHIJ', 'WA_1', 'W\nA'],
      ],
      [
        getViolationsTool.input,
        'date_from',
        ['', '\n ', '2024-02-29', ' 2024-02-29 23:59:59\n'],
        ['2024-2-29', '2024-02-29T00:00:00Z', '2024-02-29 00:00', '2024-02-29\n00:00:00'],
      ],
    ] as const) {
      const regex = pattern(input, field);
      for (const value of accepted) expect(regex.test(value), JSON.stringify(value)).toBe(true);
      for (const value of rejected) expect(regex.test(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('keeps raw pattern scans below quadratic growth over a 64-fold input span', () => {
    const regexes = [
      pattern(getSystemProfileTool.input, 'pwsid'),
      pattern(getViolationsTool.input, 'pwsid'),
      pattern(getViolationsTool.input, 'date_from'),
      pattern(searchContaminantsTool.input, 'zip'),
      pattern(searchWaterSystemsTool.input, 'pwsid_prefix'),
    ];
    for (const regex of regexes) {
      const measurements = [5000, 10000, 20000, 40000, 80000, 160000, 320000].map((length) => {
        const values = [
          '1'.repeat(length) + '!',
          ' '.repeat(length) + '!',
          'wa1234567' + ' '.repeat(length) + '!',
          'wa1234567' + ' '.repeat(length) + '\n',
          ' \n'.repeat(length / 2) + '!',
        ];
        // Warm each shape before measuring only this thread's CPU usage.
        for (const value of values) regex.test(value);
        const start = process.threadCpuUsage();
        for (let repeat = 0; repeat < 10; repeat++) for (const value of values) regex.test(value);
        const cpu = process.threadCpuUsage(start);
        const used = cpu.user + cpu.system;
        // Stop before doubling a pathological shape again; never wait on a larger input.
        expect(used).toBeLessThan(500000);
        return used;
      });
      expect(measurements[6]! / Math.max(measurements[0]!, 1)).toBeLessThan(256);
    }
  });
});
