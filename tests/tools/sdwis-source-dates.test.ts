/** @fileoverview Valid EPA time-bearing dates through profile and geographic source selection. */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSystemProfileTool } from '@/mcp-server/tools/definitions/get-system-profile.tool.js';
import { getViolationsTool } from '@/mcp-server/tools/definitions/get-violations.tool.js';
import { searchContaminantsTool } from '@/mcp-server/tools/definitions/search-contaminants.tool.js';
import { expectParity, network, paced } from '../services/sdwis/sdwis-fixtures.js';

let http: ReturnType<typeof network>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  http = network([]);
});
afterEach(() => {
  http.verify();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('returns the profile calendar day and original nonmidnight timestamp on both surfaces', async () => {
  http = network([
    {
      path: /\/sdwis\.water_system\/pwsid\/equals\/WA1234567\//,
      rows: [{ pwsid: 'WA1234567', pws_deactivation_date: '2013-02-19 10:42:29' }],
    },
  ]);
  const result = await paced(runToolContract(getSystemProfileTool, { pwsid: 'WA1234567' }));
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    found: true,
    system: {
      pws_deactivation_date: '2013-02-19',
      pws_deactivation_date_raw: '2013-02-19 10:42:29',
    },
  });
  expectParity(result);
});

it('continues state membership and source retrieval past a valid time-bearing inventory row', async () => {
  http = network([
    {
      path: /\/sdwis\.water_system\/state_code\/equals\/WA\//,
      rows: [
        { pwsid: 'WA1234567', state_code: 'WA', pws_deactivation_date: '2013-02-19 10:42:29' },
      ],
    },
    {
      path: /\/sdwis\.violation\/pwsid\/in\/WA1234567\//,
      rows: [{ pwsid: 'WA1234567', violation_id: 'V1', rtc_date: '2024-02-29 23:59:59' }],
    },
  ]);
  const result = await paced(runToolContract(getViolationsTool, { state: 'WA' }));
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    has_more: false,
    source_complete: true,
    items: [{ violation_id: 'V1', rtc_date: '2024-02-29', rtc_date_raw: '2024-02-29 23:59:59' }],
  });
  expectParity(result);
});

it('retains inclusive known periods and excludes known nonoverlap', async () => {
  http = network([
    {
      path: /\/sdwis\.violation\//,
      rows: [
        {
          pwsid: 'WA1234567',
          violation_id: 'boundary',
          compl_per_begin_date: '2024-02-01',
          compl_per_end_date: '2024-02-29 23:59:59',
        },
        {
          pwsid: 'WA1234567',
          violation_id: 'earlier',
          compl_per_begin_date: '2024-01-01',
          compl_per_end_date: '2024-02-28',
        },
      ],
    },
  ]);
  const result = await paced(
    runToolContract(getViolationsTool, {
      pwsid: 'WA1234567',
      date_from: '2024-02-29',
      date_to: '2024-02-29',
    }),
  );
  expect(result.structuredContent).toMatchObject({
    items: [{ violation_id: 'boundary', compl_per_end_date_raw: '2024-02-29 23:59:59' }],
    returned: 1,
  });
  expectParity(result);
});

it.each([getViolationsTool, searchContaminantsTool])(
  'includes provable null-end overlap and reports only examined unknown rows through $name',
  async (tool) => {
    http = network([
      {
        path: /\/sdwis\.violation\//,
        rows: [
          {
            pwsid: 'WA1234567',
            violation_id: 'first',
            compl_per_begin_date: '2024-02-29 12:30:00',
            compl_per_end_date: null,
          },
          {
            pwsid: 'WA1234567',
            violation_id: 'second',
            compl_per_begin_date: '2024-02-29',
            compl_per_end_date: null,
          },
          {
            pwsid: 'WA1234567',
            violation_id: 'unknown',
            compl_per_begin_date: '2024-02-28',
            compl_per_end_date: null,
          },
          {
            pwsid: 'WA1234567',
            violation_id: 'absent',
            compl_per_begin_date: null,
            compl_per_end_date: null,
          },
          {
            pwsid: 'WA1234567',
            violation_id: 'later',
            compl_per_begin_date: '2024-03-01',
            compl_per_end_date: null,
          },
        ],
      },
    ]);
    const input = {
      ...(tool.name === 'sdwis_search_contaminants' ? { dataset: 'violations' } : {}),
      pwsid: 'WA1234567',
      date_from: '2024-02-29',
      date_to: '2024-02-29',
      limit: 1,
    };
    const first = await paced(runToolContract(tool, input));
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      items: [
        {
          violation_id: 'first',
          compl_per_end_date: null,
          compl_per_begin_date_raw: '2024-02-29 12:30:00',
        },
      ],
      has_more: true,
    });
    const page = first.structuredContent as { next_cursor: string; notices: string[] };
    expect(page.notices).toContain(
      'Date overlap is unknown for 2 of 5 source rows examined during this call; those rows were excluded. Counts do not describe unexamined source rows.',
    );
    expectParity(first);
    const next = { ...input, cursor: page.next_cursor };
    const last = await paced(runToolContract(tool, next));
    expect(last.structuredContent).toMatchObject({
      items: [{ violation_id: 'second' }],
      has_more: false,
      source_complete: false,
    });
    expect(JSON.stringify(last.structuredContent)).not.toContain('Date overlap is unknown');
    expectParity(last);
    expect(await paced(runToolContract(tool, next))).toEqual(last);
  },
);

it('includes a known begin before date_to when the end is null and no lower bound was requested', async () => {
  http = network([
    {
      path: /\/sdwis\.violation\//,
      rows: [
        {
          pwsid: 'WA1234567',
          violation_id: 'open',
          compl_per_begin_date: '2015-12-01',
          compl_per_end_date: null,
        },
      ],
    },
  ]);
  const result = await paced(
    runToolContract(getViolationsTool, { pwsid: 'WA1234567', date_to: '2016-12-31' }),
  );
  expect(result.structuredContent).toMatchObject({
    items: [{ violation_id: 'open', compl_per_end_date: null }],
    source_complete: true,
  });
  expectParity(result);
});

it('uses a known end inside the requested interval as overlap evidence with an unknown begin', async () => {
  http = network([
    {
      path: /\/sdwis\.violation\//,
      rows: [
        {
          pwsid: 'WA1234567',
          violation_id: 'known-end',
          compl_per_begin_date: null,
          compl_per_end_date: '2024-02-29',
        },
      ],
    },
  ]);
  const result = await paced(
    runToolContract(getViolationsTool, {
      pwsid: 'WA1234567',
      date_from: '2024-02-29',
      date_to: '2024-02-29',
    }),
  );
  expect(result.structuredContent).toMatchObject({
    items: [{ violation_id: 'known-end', compl_per_begin_date: null }],
    source_complete: true,
  });
  expectParity(result);
});
