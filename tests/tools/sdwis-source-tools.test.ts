/**
 * @fileoverview Real SDWIS source jobs through schema, network and both tool response surfaces.
 * @module tests/tools/sdwis-source-tools.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectParity, network, paced } from '../services/sdwis/sdwis-fixtures.js';

let reference: typeof import('../../src/mcp-server/tools/definitions/list-reference.tool.js').listReferenceTool;
let search: typeof import('../../src/mcp-server/tools/definitions/search-water-systems.tool.js').searchWaterSystemsTool;
let profile: typeof import('../../src/mcp-server/tools/definitions/get-system-profile.tool.js').getSystemProfileTool;
let violations: typeof import('../../src/mcp-server/tools/definitions/get-violations.tool.js').getViolationsTool;
let enforcement: typeof import('../../src/mcp-server/tools/definitions/get-enforcement-actions.tool.js').getEnforcementActionsTool;
let contaminants: typeof import('../../src/mcp-server/tools/definitions/search-contaminants.tool.js').searchContaminantsTool;
let http: ReturnType<typeof network>;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  [reference, search, profile, violations, enforcement, contaminants] = await Promise.all([
    import('../../src/mcp-server/tools/definitions/list-reference.tool.js').then(
      (m) => m.listReferenceTool,
    ),
    import('../../src/mcp-server/tools/definitions/search-water-systems.tool.js').then(
      (m) => m.searchWaterSystemsTool,
    ),
    import('../../src/mcp-server/tools/definitions/get-system-profile.tool.js').then(
      (m) => m.getSystemProfileTool,
    ),
    import('../../src/mcp-server/tools/definitions/get-violations.tool.js').then(
      (m) => m.getViolationsTool,
    ),
    import('../../src/mcp-server/tools/definitions/get-enforcement-actions.tool.js').then(
      (m) => m.getEnforcementActionsTool,
    ),
    import('../../src/mcp-server/tools/definitions/search-contaminants.tool.js').then(
      (m) => m.searchContaminantsTool,
    ),
  ]);
  http = network([]);
});
afterEach(() => {
  http.verify();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function data(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  expectParity(result);
  return result.structuredContent as Record<string, unknown>;
}
function error(result: Awaited<ReturnType<typeof runToolContract>>, reason: string) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
  expect(JSON.stringify(result.content)).toContain(reason);
  expect(JSON.stringify(result)).not.toContain('CONTACT-CANARY');
}
const waterPath = /^\/dmapservice\/sdwis\.water_system\//;
const violationPath = /^\/dmapservice\/sdwis\.violation\//;
const dictionaryPath = /^\/dmapservice\/sdwis\.ref_code_value\//;

describe('SDWIS source tool wiring', () => {
  it('retains a failed stage cursor and keeps later partitions incomplete after retry', async () => {
    const { setStageProducer } = await import('../../src/services/sdwis/drinking-water-service.js');
    let fail = false;
    setStageProducer(async ({ rows, output }) => {
      if (fail) throw new Error('stage admission failed');
      return {
        canvas_id: 'test',
        table_name: 'partition',
        row_count: rows.length,
        source_complete: output.source_complete,
        expires_at: '2026-10-25T01:00:00Z',
        pointer: 'Inspect partition.',
      };
    });
    http = network([
      {
        path: violationPath,
        rows: [
          { pwsid: 'WA1234567', violation_id: 'first' },
          { pwsid: 'WA1234567', violation_id: 'last' },
        ],
      },
    ]);
    const input = { pwsid: 'WA1234567', stage: true, stage_max_rows: 1 };
    const first = data(await paced(runToolContract(violations, input)));
    const next = { ...input, cursor: String(first.next_cursor) };
    fail = true;
    expect((await paced(runToolContract(violations, next))).isError).toBe(true);
    fail = false;
    const last = data(await paced(runToolContract(violations, next)));
    expect(last).toMatchObject({
      items: [{ violation_id: 'last' }],
      has_more: false,
      source_complete: false,
      dataset: { row_count: 1, source_complete: false },
    });
    expect(data(await paced(runToolContract(violations, next)))).toEqual(last);
  });
  it.each(['geography', 'service_areas', 'treatment'] as const)(
    'preserves duplicate %s rows across the network page seam',
    async (section) => {
      const table =
        section === 'geography'
          ? 'geographic_area'
          : section === 'service_areas'
            ? 'service_area'
            : 'treatment';
      const row = { pwsid: 'WA1234567' };
      const path = new RegExp(`/sdwis\\.${table}/`);
      const sourceOffsets: string[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        expect(url.origin).toBe('https://data.epa.gov');
        if (waterPath.test(url.pathname)) {
          expect(url.pathname).toBe(
            '/dmapservice/sdwis.water_system/pwsid/equals/WA1234567/sort/pwsid/1:1/json',
          );
          return Response.json([row]);
        }
        expect(path.test(url.pathname)).toBe(true);
        const range = url.pathname.split('/').at(-2) ?? '';
        sourceOffsets.push(range);
        expect(['1:1000', '1001:2000', '2001:3000']).toContain(range);
        return Response.json(Array.from({ length: range === '2001:3000' ? 1 : 1000 }, () => row));
      });
      let page = data(
        await paced(runToolContract(profile, { pwsid: row.pwsid, section, limit: 100 })),
      );
      let count = Number(page.returned);
      while (page.has_more) {
        page = data(
          await paced(
            runToolContract(profile, {
              pwsid: row.pwsid,
              section,
              limit: 100,
              cursor: String(page.next_cursor),
            }),
          ),
        );
        count += Number(page.returned);
      }
      expect(count).toBe(2001);
      expect(sourceOffsets).toEqual(['1:1000', '1001:2000', '2001:3000']);
      expect(page.source_complete).toBe(false);
    },
  );
  it('returns incomplete membership without querying facts when the call page budget is exhausted', async () => {
    http = network(
      Array.from({ length: 17 }, (_, page) => ({
        path: new RegExp(
          `/sdwis\\.water_system/state_code/equals/WA/sort/pwsid/${page * 1000 + 1}:${page * 1000 + 1000}/json$`,
        ),
        rows: Array.from({ length: 1000 }, (_, index) => ({
          pwsid: `WA${String(page * 1000 + index).padStart(7, '0')}`,
          state_code: 'WA',
        })),
      })),
    );
    const result = data(await paced(runToolContract(violations, { state: 'WA' })));
    expect(result).toMatchObject({
      phase: 'membership',
      items: [],
      returned: 0,
      has_more: true,
      source_complete: false,
    });
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(http.calls).toHaveLength(17);
  });

  it('hands the complete acquired partition to staging and returns its actual manifest', async () => {
    const { setStageProducer } = await import('../../src/services/sdwis/drinking-water-service.js');
    const partitions: unknown[] = [];
    setStageProducer(async (partition) => {
      partitions.push(partition);
      return {
        canvas_id: 'test-capability',
        table_name: 'violations_test',
        row_count: 2,
        source_complete: true,
        expires_at: '2026-10-25T01:00:00Z',
        pointer: 'Inspect the staged table.',
      };
    });
    http = network([
      {
        path: violationPath,
        rows: [
          { pwsid: 'WA1234567', violation_id: 'V1' },
          { pwsid: 'WA1234567', violation_id: 'V2' },
        ],
      },
    ]);
    const result = data(
      await paced(runToolContract(violations, { pwsid: 'WA1234567', stage: true, limit: 1 })),
    );
    expect(partitions).toMatchObject([
      { table: 'violation', rows: [{ violation_id: 'V1' }, { violation_id: 'V2' }] },
    ]);
    expect(result).toMatchObject({
      returned: 1,
      source_complete: true,
      truncated: true,
      phase: 'preview',
      dataset: { table_name: 'violations_test', row_count: 2 },
    });
  });

  it('reads static reference without HTTP and dynamic reference with missing descriptions', async () => {
    const bundled = data(
      await paced(runToolContract(reference, { topic: 'coverage', limit: 100 })),
    );
    expect(bundled.source_complete).toBe(true);
    expect(bundled.returned).toBeGreaterThan(0);
    http = network([
      {
        path: dictionaryPath,
        rows: [
          {
            value_type: 'CONTAMINANT_CODE',
            value_code: '1030',
            value_description: null,
            contact: 'CONTACT-CANARY',
          },
        ],
      },
    ]);
    const live = data(
      await paced(runToolContract(reference, { topic: 'contaminants', query: '1030' })),
    );
    expect(live.items).toEqual([
      { value_type: 'CONTAMINANT_CODE', value_code: '1030', value_description: null },
    ]);
    expect(live).toMatchObject({ has_more: false, source_complete: true });
  });

  it('normalizes discovery blanks and case, preserves null geography and unknown shaped IDs', async () => {
    http = network([
      {
        path: waterPath,
        rows: [
          {
            pwsid: '01234567A',
            pws_activity_code: 'A',
            state_code: null,
            population_served_count: null,
            pws_name: 'Synthetic',
            phone: 'CONTACT-CANARY',
          },
        ],
      },
    ]);
    const result = data(
      await paced(runToolContract(search, { pwsid: '01234567a', name_contains: ' ', limit: 101 })),
    );
    expect(result).toMatchObject({
      effective_filters: { pwsid: '01234567A', activity: 'active' },
      limit: 100,
      source_complete: true,
    });
    expect(JSON.stringify(result)).not.toContain('CONTACT-CANARY');
    expect(JSON.stringify(result.notices)).toContain('clamped');
    http.verify();
    http = network([{ path: waterPath, rows: [] }]);
    expect(data(await paced(runToolContract(profile, { pwsid: 'ZZ0000000' })))).toMatchObject({
      found: false,
      items: [],
      source_complete: true,
    });
  });

  it('distinguishes an existing system with empty children from an absent system', async () => {
    http = network([
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
      { path: /^\/dmapservice\/sdwis\.geographic_area\//, rows: [] },
    ]);
    expect(
      data(await paced(runToolContract(profile, { pwsid: 'WA1234567', section: 'geography' }))),
    ).toMatchObject({ found: true, items: [], returned: 0, source_complete: true });
    http.verify();
    http = network([
      { path: waterPath, rows: [{ pwsid: 'WA1234567', pws_name: 'Synthetic', state_code: null }] },
    ]);
    expect(data(await paced(runToolContract(profile, { pwsid: 'wa1234567' })))).toMatchObject({
      found: true,
      system: { pwsid: 'WA1234567', state_code: null },
      items: [],
      returned: 0,
    });
  });

  it('exhausts state and county membership before facts and retains composite IDs', async () => {
    http = network([
      {
        path: /water_system\/state_code\/equals\/WA\//,
        rows: [
          { pwsid: 'WA1234567', state_code: 'WA' },
          { pwsid: '01234567A', state_code: 'WA' },
        ],
      },
      {
        path: /geographic_area\/county_served\/equals\/KING\//,
        rows: [
          { pwsid: 'WA1234567', county_served: 'KING', geo_id: null, state_served: null },
          { pwsid: '01234567A', county_served: 'KING', geo_id: null },
        ],
      },
      {
        path: /violation\/pwsid\/in\/WA1234567%2C01234567A\//,
        rows: [
          {
            pwsid: 'WA1234567',
            violation_id: 'same',
            viol_measure: null,
            compl_per_begin_date: '2024-01-01',
            compl_per_end_date: '2024-02-29',
          },
          {
            pwsid: '01234567A',
            violation_id: 'same',
            compl_per_begin_date: '2024-02-29',
            compl_per_end_date: '2024-03-01',
          },
          {
            pwsid: 'WA1234567',
            violation_id: 'unknown-date',
            compl_per_begin_date: null,
            compl_per_end_date: null,
          },
        ],
      },
    ]);
    const result = data(
      await paced(
        runToolContract(violations, {
          state: 'Washington',
          county: 'King County',
          date_from: '2024-02-29',
          date_to: '2024-02-29',
        }),
      ),
    );
    expect(result.items).toEqual([
      expect.objectContaining({ pwsid: 'WA1234567', violation_id: 'same', viol_measure: null }),
      expect.objectContaining({ pwsid: '01234567A', violation_id: 'same' }),
    ]);
    expect(result).toMatchObject({
      source_complete: true,
      has_more: false,
      effective_filters: { state: 'WA', county: 'KING', state_basis: 'reported_legal_entity' },
    });
  });

  it('decodes identical codes by dictionary type and shares violation routing with contaminant search', async () => {
    http = network([
      {
        path: violationPath,
        rows: [
          {
            pwsid: 'WA1234567',
            violation_id: 'V',
            contaminant_code: '1030',
            violation_code: '1030',
            violation_category_code: '1030',
          },
        ],
      },
      {
        path: /value_type\/equals\/CONTAMINANT_CODE\//,
        rows: [{ value_type: 'CONTAMINANT_CODE', value_code: '1030', value_description: 'Lead' }],
      },
      {
        path: /value_type\/equals\/VIOLATION_CODE\//,
        rows: [
          {
            value_type: 'VIOLATION_CODE',
            value_code: '1030',
            value_description: 'Violation description',
          },
        ],
      },
      { path: /value_type\/equals\/VIOLATION_CATEGORY_CODE\//, rows: [] },
    ]);
    const result = data(
      await paced(
        runToolContract(contaminants, {
          dataset: 'violations',
          pwsid: 'WA1234567',
          contaminant: 'lead',
        }),
      ),
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        contaminant_label: 'Lead',
        violation_label: 'Violation description',
        violation_category_label: null,
      }),
    ]);
    expect(http.calls[0]).toContain('/contaminant_code/equals/1030/');
  });

  it('joins LCR periods by system and sample, retaining unmatched results and null numbers', async () => {
    http = network([
      {
        path: waterPath,
        rows: [
          { pwsid: 'WA1234567', state_code: 'WA' },
          { pwsid: '01234567A', state_code: 'WA' },
        ],
      },
      {
        path: /sdwis\.lcr_sample\//,
        rows: [
          {
            pwsid: 'WA1234567',
            sample_id: 'S',
            sampling_start_date: '2024-01-01',
            sampling_end_date: '2024-06-30',
          },
          {
            pwsid: '01234567A',
            sample_id: 'S',
            sampling_start_date: '2025-01-01',
            sampling_end_date: '2025-06-30',
          },
        ],
      },
      {
        path: /sdwis\.lcr_sample_result\//,
        rows: [
          { pwsid: 'WA1234567', sample_id: 'S', sample_measure: null },
          { pwsid: '01234567A', sample_id: 'S', sample_measure: 0 },
          { pwsid: 'WA1234567', sample_id: 'unjoined', sample_measure: null },
        ],
      },
    ]);
    const result = data(
      await paced(runToolContract(contaminants, { dataset: 'lcr', state: 'WA' })),
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        pwsid: 'WA1234567',
        sampling_start_date: '2024-01-01',
        sample_measure: null,
        period_joined: true,
      }),
      expect.objectContaining({
        pwsid: '01234567A',
        sampling_start_date: '2025-01-01',
        sample_measure: 0,
      }),
      expect.objectContaining({
        sample_id: 'unjoined',
        sampling_start_date: null,
        period_joined: false,
      }),
    ]);
  });

  it('selects actions through association keys and pages associations separately', async () => {
    http = network([
      {
        path: /violation_enf_assoc\/pwsid\/equals\/WA1234567\/and\/violation_id\/equals\/V\//,
        rows: [
          {
            pwsid: 'WA1234567',
            violation_id: 'V',
            enforcement_id: 'E',
            submissionyearquarter: '2024Q1',
          },
        ],
      },
      {
        path: /sdwis\.enforcement_action\//,
        rows: [
          {
            pwsid: 'WA1234567',
            enforcement_id: 'E',
            enforcement_comment_text: 'Public source text',
            enforcement_date: '2024-02-29',
          },
          { pwsid: 'WA1234567', enforcement_id: 'other', enforcement_date: '2024-02-29' },
        ],
      },
    ]);
    expect(
      data(
        await paced(
          runToolContract(enforcement, {
            pwsid: 'WA1234567',
            violation_id: 'V',
            date_from: '2024-02-29',
          }),
        ),
      ),
    ).toMatchObject({
      items: [{ enforcement_id: 'E', enforcement_comment_text: 'Public source text' }],
    });
    http.verify();
    http = network([
      {
        path: /sdwis\.violation_enf_assoc\//,
        rows: [
          {
            pwsid: 'WA1234567',
            violation_id: 'V',
            enforcement_id: 'E',
            submissionyearquarter: '2024Q1',
          },
        ],
      },
    ]);
    expect(
      data(
        await paced(runToolContract(enforcement, { pwsid: 'WA1234567', section: 'associations' })),
      ),
    ).toMatchObject({
      items: [{ violation_id: 'V', enforcement_id: 'E', submissionyearquarter: '2024Q1' }],
    });
  });

  it('rejects illegal selectors before fetching and exposes recovery on both surfaces', async () => {
    for (const result of [
      await runToolContract(search, { county: 'King' }),
      await runToolContract(violations, { pwsid: 'WA1234567', date_from: '2024-02-30' }),
      await runToolContract(enforcement, {
        pwsid: 'WA1234567',
        section: 'associations',
        date_from: '2024-01-01',
      }),
      await runToolContract(contaminants, {
        dataset: 'lcr',
        pwsid: 'WA1234567',
        detected_only: false,
      }),
    ])
      error(result, 'invalid_selector');
  });

  it('continues from the first unconsumed record, replays the previous cursor and rejects changed selectors', async () => {
    http = network([
      {
        path: waterPath,
        rows: Array.from({ length: 103 }, (_, index) => ({
          pwsid: `WA${String(index).padStart(7, '0')}`,
          pws_activity_code: 'A',
          state_code: 'WA',
        })),
      },
    ]);
    const first = data(await paced(runToolContract(search, { state: 'WA', limit: 100 })));
    expect(first).toMatchObject({
      returned: 100,
      has_more: true,
      source_complete: false,
      truncated: true,
    });
    const cursor = String(first.next_cursor);
    const secondResult = await paced(runToolContract(search, { state: 'WA', limit: 100, cursor }));
    const second = data(secondResult);
    expect(second).toMatchObject({
      items: [{ pwsid: 'WA0000100' }, { pwsid: 'WA0000101' }, { pwsid: 'WA0000102' }],
      returned: 3,
      has_more: false,
      source_complete: false,
    });
    expect(second.next_cursor).toBeUndefined();
    const replay = data(await paced(runToolContract(search, { state: 'WA', limit: 100, cursor })));
    expect(replay).toEqual(second);
    error(
      await paced(runToolContract(search, { state: 'OR', limit: 100, cursor })),
      'cursor_invalid',
    );
  });

  it('keeps the byte-cut row for the next literal continuation', async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      pwsid: `WA000000${index}`,
      pws_activity_code: 'A',
      pws_name: `${index}:${'🌊'.repeat(900)}`,
    }));
    http = network([{ path: waterPath, rows }]);
    let result = data(await paced(runToolContract(search, { pwsid_prefix: 'WA', limit: 100 })));
    const collected: unknown[] = [];
    expect(result.returned).toBeLessThan(4);
    for (let iteration = 0; iteration < 5; iteration++) {
      collected.push(...(result.items as unknown[]));
      if (!result.has_more) break;
      result = data(
        await paced(
          runToolContract(search, {
            pwsid_prefix: 'WA',
            limit: 100,
            cursor: String(result.next_cursor),
          }),
        ),
      );
    }
    expect(collected).toEqual(rows);
    expect(result.source_complete).toBe(false);
  });

  it('reads an oversized Unicode record losslessly then continues records', async () => {
    const row = { pwsid: 'WA1234567', pws_activity_code: 'A', pws_name: '🌊漢字'.repeat(6000) };
    http = network([
      {
        path: waterPath,
        rows: [row, { pwsid: 'WA1234568', pws_activity_code: 'A', pws_name: 'next' }],
      },
    ]);
    const tooLarge = await paced(runToolContract(search, { pwsid_prefix: 'WA', limit: 2 }));
    error(tooLarge, 'item_too_large');
    const details = tooLarge.structuredContent as { error: { data: { record_cursor: string } } };
    let cursor = details.error.data.record_cursor;
    let serialized = '';
    let next: string | undefined;
    for (let iteration = 0; iteration < 20; iteration++) {
      const result = data(
        await paced(
          runToolContract(search, {
            pwsid_prefix: 'WA',
            limit: 2,
            view: 'text',
            record_cursor: cursor,
          }),
        ),
      );
      expect(result.offset).toBe(Array.from(serialized).length);
      serialized += String(result.text);
      expect(String(result.text)).not.toContain('\uFFFD');
      if (JSON.stringify(result.notices).includes('Record text complete.')) {
        next = typeof result.next_cursor === 'string' ? result.next_cursor : undefined;
        break;
      }
      cursor = String(result.next_cursor);
    }
    expect(JSON.parse(serialized)).toEqual(row);
    expect(next).toBeDefined();
    expect(
      data(await paced(runToolContract(search, { pwsid_prefix: 'WA', limit: 2, cursor: next }))),
    ).toMatchObject({ items: [{ pwsid: 'WA1234568', pws_name: 'next' }], source_complete: false });
  });

  it('expires continuations at idle TTL and reports tampering without HTTP', async () => {
    http = network([
      {
        path: waterPath,
        rows: [
          { pwsid: 'WA1234567', pws_activity_code: 'A' },
          { pwsid: 'WA1234568', pws_activity_code: 'A' },
        ],
      },
    ]);
    const first = data(await paced(runToolContract(search, { pwsid_prefix: 'WA', limit: 1 })));
    error(
      await paced(
        runToolContract(search, {
          pwsid_prefix: 'WA',
          limit: 1,
          cursor: `${String(first.next_cursor)}x`,
        }),
      ),
      'cursor_invalid',
    );
    vi.setSystemTime(new Date('2026-10-25T00:16:00Z'));
    error(
      await paced(
        runToolContract(search, {
          pwsid_prefix: 'WA',
          limit: 1,
          cursor: String(first.next_cursor),
        }),
      ),
      'cursor_invalid',
    );
  });

  it('returns schema and HTTP failures through the production dual-surface error envelope', async () => {
    http = network([{ path: violationPath, rows: [{ pwsid: 'WA1234567' }] }]);
    const invalid = await paced(runToolContract(violations, { pwsid: 'WA1234567' }));
    error(invalid, 'upstream_contract_changed');
    expect(JSON.stringify(invalid.content)).toContain('EPA response');
    http.verify();
    http = network([
      { path: waterPath, response: () => new Response('CONTACT-CANARY', { status: 403 }) },
    ]);
    const forbidden = await paced(runToolContract(search, { pwsid: 'WA1234567' }));
    expect(forbidden).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { status: 403, retryable: false } } },
    });
    expect(JSON.stringify(forbidden.content)).toContain('403');
    expect(JSON.stringify(forbidden)).not.toContain('CONTACT-CANARY');
  });

  it('cancels a cursor call at the network boundary and permits retry of the same cursor', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      pwsid: `WA${String(index).padStart(7, '0')}`,
      pws_activity_code: 'A',
    }));
    http = network([{ path: waterPath, rows }]);
    let result = data(await paced(runToolContract(search, { pwsid_prefix: 'WA', limit: 100 })));
    for (let index = 0; index < 8; index++)
      result = data(
        await paced(
          runToolContract(search, {
            pwsid_prefix: 'WA',
            limit: 100,
            cursor: String(result.next_cursor),
          }),
        ),
      );
    http.verify();
    const cursor = String(result.next_cursor);
    const caller = new AbortController();
    http = network([
      {
        path: /\/1001:2000\/json$/,
        response: () => {
          caller.abort(new DOMException('caller stopped', 'AbortError'));
          return Response.json([]);
        },
      },
    ]);
    const cancelled = await paced(
      runToolContract(
        search,
        { pwsid_prefix: 'WA', limit: 100, cursor },
        { context: { signal: caller.signal } },
      ),
    );
    expect(cancelled).toMatchObject({
      isError: true,
      structuredContent: { error: { code: -32011 } },
    });
    expect(JSON.stringify(cancelled.content)).toContain('caller stopped');
    http.verify();
    http = network([{ path: /\/1001:2000\/json$/, rows: [] }]);
    expect(
      data(await paced(runToolContract(search, { pwsid_prefix: 'WA', limit: 100, cursor }))),
    ).toMatchObject({ returned: 100, source_complete: false });
  });

  it.each(['metadata', 'repeated'] as const)(
    'detects %s source paging changes rather than declaring complete',
    async (kind) => {
      const rows = Array.from({ length: 1000 }, (_, index) => ({
        pwsid: `WA${String(index).padStart(7, '0')}`,
        pws_activity_code: 'A',
      }));
      http = network([
        { path: waterPath, response: () => Response.json(rows, { headers: { etag: 'a' } }) },
      ]);
      let result = data(await paced(runToolContract(search, { pwsid_prefix: 'WA', limit: 100 })));
      for (let index = 0; index < 8; index++)
        result = data(
          await paced(
            runToolContract(search, {
              pwsid_prefix: 'WA',
              limit: 100,
              cursor: String(result.next_cursor),
            }),
          ),
        );
      http.verify();
      http = network([
        {
          path: /\/1001:2000\/json$/,
          response: () =>
            Response.json(kind === 'repeated' ? rows : [], {
              headers: { etag: kind === 'metadata' ? 'b' : 'a' },
            }),
        },
      ]);
      error(
        await paced(
          runToolContract(search, {
            pwsid_prefix: 'WA',
            limit: 100,
            cursor: String(result.next_cursor),
          }),
        ),
        kind === 'metadata' ? 'source_changed' : 'upstream_paging_changed',
      );
    },
  );
});
