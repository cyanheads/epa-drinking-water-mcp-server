/** @fileoverview Valid EPA time-bearing dates through profile and geographic source selection. */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSystemProfileTool } from '@/mcp-server/tools/definitions/get-system-profile.tool.js';
import { getViolationsTool } from '@/mcp-server/tools/definitions/get-violations.tool.js';
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
