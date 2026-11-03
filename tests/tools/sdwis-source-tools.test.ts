/**
 * @fileoverview Real SDWIS source jobs through schema, network and both tool response surfaces.
 * @module tests/tools/sdwis-source-tools.test
 */
import process from 'node:process';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  vi.unstubAllEnvs();
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
  it('rejects exactly ASCII controls while preserving C1 and Unicode literal selectors', async () => {
    const { normalizeSelectors } = await import('../../src/domain/source-inputs.js');
    for (let code = 0; code <= 159; code++) {
      const name_contains = `A${String.fromCharCode(code)}B`;
      if (code < 32 || code === 127)
        expect(() => normalizeSelectors({ name_contains })).toThrow(
          expect.objectContaining({ data: { reason: 'invalid_selector' } }),
        );
      else expect(normalizeSelectors({ name_contains }).name_contains).toBe(name_contains);
    }
    for (const name_contains of ['漢字🌊', 'A\u2028B', 'A\u2029B'])
      expect(normalizeSelectors({ name_contains }).name_contains).toBe(name_contains);
    const measurements = [5000, 20000, 80000, 320000].map((length) => {
      const values = [
        `${'A'.repeat(length)}\n`,
        '\r\n'.repeat(length / 2),
        '/#%('.repeat(length / 4),
        'A'.repeat(length),
      ];
      const check = () => {
        for (const name_contains of values) {
          try {
            normalizeSelectors({ name_contains });
          } catch (error) {
            expect(error).toMatchObject({ data: { reason: 'invalid_selector' } });
          }
        }
      };
      check();
      const start = process.threadCpuUsage();
      for (let repeat = 0; repeat < 5; repeat++) check();
      const cpu = process.threadCpuUsage(start);
      const used = cpu.user + cpu.system;
      expect(used).toBeLessThan(500000);
      return used;
    });
    expect(measurements[3]! / Math.max(measurements[0]!, 1)).toBeLessThan(256);
  });
  it('preserves treatment facility IDs as opaque strings without inventing a facility profile', async () => {
    http = network([
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
      {
        path: /sdwis\.treatment\//,
        rows: [{ pwsid: 'WA1234567', facility_id: '0007', treatment_id: 'T', comments_text: null }],
      },
    ]);
    const result = data(
      await paced(runToolContract(profile, { pwsid: 'WA1234567', section: 'treatment' })),
    );
    expect(result).toMatchObject({
      found: true,
      items: [{ facility_id: '0007', treatment_id: 'T', comments_text: null }],
    });
    expect(result.items).not.toMatchObject([{ facility_name: expect.anything() }]);
  });

  it('resolves an exact facility profile with its type label and retained source fields', async () => {
    http = network([
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
      {
        path: /sdwis\.water_system_facility\/pwsid\/in\/WA1234567\/and\/facility_id\/equals\/0007\/sort\/pwsid:asc,facility_id:asc\/1:1000\/json$/,
        rows: [
          {
            pwsid: 'WA1234567',
            facility_id: '0007',
            facility_name: 'Cedar',
            facility_type_code: 'TP',
            facility_activity_code: 'A',
            facility_deactivation_date: '2025-02-01 12:34:56',
            seller_pwsid: null,
            contact_name: 'CONTACT-CANARY',
          },
        ],
      },
      {
        path: /value_type\/equals\/FACILITY_TYPE_CODE\/sort\//,
        rows: [
          {
            value_type: 'FACILITY_TYPE_CODE',
            value_code: 'TP',
            value_description: 'Treatment Plant',
          },
        ],
      },
    ]);
    const result = data(
      await paced(
        runToolContract(profile, {
          pwsid: 'wa1234567',
          section: 'facilities',
          facility_id: ' 0007 ',
        }),
      ),
    );
    expect(result).toMatchObject({
      found: true,
      source_complete: true,
      items: [
        {
          facility_id: '0007',
          facility_name: 'Cedar',
          facility_type_label: 'Treatment Plant',
          facility_deactivation_date: '2025-02-01',
          facility_deactivation_date_raw: '2025-02-01 12:34:56',
          seller_pwsid: null,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('CONTACT-CANARY');
  });

  it('filters punctuation-bearing facility IDs exactly and treats blank IDs as unset', async () => {
    http = network([
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
      {
        path: /water_system_facility\/pwsid\/in\/WA1234567\/and\/facility_id\/beginsWith\/ID\//,
        rows: [
          { pwsid: 'WA1234567', facility_id: 'ID-7' },
          { pwsid: 'WA1234567', facility_id: 'ID/7' },
        ],
      },
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
      {
        path: /water_system_facility\/pwsid\/in\/WA1234567\/sort\//,
        rows: [{ pwsid: 'WA1234567', facility_id: 'ID/7', facility_type_code: 'UNKNOWN' }],
      },
      { path: /value_type\/equals\/FACILITY_TYPE_CODE\//, rows: [] },
    ]);
    expect(
      data(
        await paced(
          runToolContract(profile, {
            pwsid: 'WA1234567',
            section: 'facilities',
            facility_id: ' ID/7 ',
          }),
        ),
      ),
    ).toMatchObject({
      items: [{ facility_id: 'ID/7', facility_type_label: null }],
      found: true,
      source_complete: true,
    });
    expect(
      data(
        await paced(
          runToolContract(profile, {
            pwsid: 'WA1234567',
            section: 'facilities',
            facility_id: ' \t\n ',
          }),
        ),
      ),
    ).toMatchObject({ items: [{ facility_id: 'ID/7', facility_type_label: null }], found: true });
  });

  it('pages facility identities across source and pending boundaries without duplicates', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      pwsid: 'WA1234567',
      facility_id: `F${String(i).padStart(4, '0')}`,
      facility_type_code: i % 2 ? 'UNKNOWN' : 'TP',
    }));
    http = network([
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
      { path: /water_system_facility\/.*\/1:1000\/json$/, rows: rows.slice(0, 1000) },
      {
        path: /value_type\/equals\/FACILITY_TYPE_CODE\//,
        rows: [
          {
            value_type: 'FACILITY_TYPE_CODE',
            value_code: 'TP',
            value_description: 'Treatment Plant',
          },
        ],
      },
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
      { path: /water_system_facility\/.*\/1001:2000\/json$/, rows: rows.slice(1000) },
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
    ]);
    const input = { pwsid: 'WA1234567', section: 'facilities', limit: 500 } as const;
    const first = data(await paced(runToolContract(profile, input)));
    const second = data(
      await paced(runToolContract(profile, { ...input, cursor: String(first.next_cursor) })),
    );
    const last = data(
      await paced(runToolContract(profile, { ...input, cursor: String(second.next_cursor) })),
    );
    const collected = [
      ...(first.items as unknown[]),
      ...(second.items as unknown[]),
      ...(last.items as unknown[]),
    ];
    expect(collected).toEqual(
      rows.map((row, i) => ({ ...row, facility_type_label: i % 2 ? null : 'Treatment Plant' })),
    );
    expect([first.returned, second.returned, last.returned]).toEqual([500, 500, 1]);
    expect(last).toMatchObject({
      found: true,
      has_more: false,
      source_complete: false,
      selection_partition: { partition: 2, final_partition: 2 },
    });
  });

  it('rejects a repeated facility identity at a source boundary even when its description changes', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      pwsid: 'WA1234567',
      facility_id: `F${String(i).padStart(4, '0')}`,
    }));
    http = network([
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
      { path: /water_system_facility\/.*\/1:1000\/json$/, rows },
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
      {
        path: /water_system_facility\/.*\/1001:2000\/json$/,
        rows: [{ pwsid: 'WA1234567', facility_id: 'F0999', facility_name: 'Changed source text' }],
      },
    ]);
    const input = { pwsid: 'WA1234567', section: 'facilities', limit: 500 } as const;
    const first = data(await paced(runToolContract(profile, input)));
    const result = await paced(
      runToolContract(profile, { ...input, cursor: String(first.next_cursor) }),
    );
    error(result, 'upstream_paging_changed');
    expect(JSON.stringify(result.content)).toContain('Recovery:');
  });

  it('rejects facility selectors on other sections before HTTP and preserves empty-child found semantics', async () => {
    for (const section of ['summary', 'geography', 'service_areas', 'treatment'] as const) {
      const result = await runToolContract(profile, {
        pwsid: 'WA1234567',
        section,
        facility_id: '0007',
      });
      error(result, 'invalid_selector');
      expect(JSON.stringify(result.content)).toContain('section facilities');
    }
    expect(http.calls).toEqual([]);
    http = network([
      { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
      { path: /water_system_facility\//, rows: [] },
    ]);
    expect(
      data(
        await paced(
          runToolContract(profile, {
            pwsid: 'WA1234567',
            section: 'facilities',
            facility_id: 'missing',
          }),
        ),
      ),
    ).toMatchObject({ found: true, items: [], source_complete: true });
    http.verify();
    http = network([
      { path: waterPath, rows: [] },
      { path: /water_system_facility\//, rows: [] },
    ]);
    expect(
      data(await paced(runToolContract(profile, { pwsid: 'ZZ0000000', section: 'facilities' }))),
    ).toMatchObject({ found: false, items: [], source_complete: true });
  });

  it.each([true, false])(
    'uses school_or_daycare %s as a sole narrowing selector and preserves indicators',
    async (flag) => {
      const indicator = flag ? 'Y' : 'N';
      http = network([
        {
          path: new RegExp(
            `/is_school_or_daycare_ind/equals/${indicator}/and/pws_activity_code/equals/A/`,
          ),
          rows: [
            {
              pwsid: 'WA1234567',
              pws_activity_code: 'A',
              is_school_or_daycare_ind: indicator,
              is_wholesaler_ind: null,
            },
          ],
        },
      ]);
      expect(data(await paced(runToolContract(search, { school_or_daycare: flag })))).toMatchObject(
        {
          returned: 1,
          effective_filters: { school_or_daycare: flag },
          items: [{ is_school_or_daycare_ind: indicator, is_wholesaler_ind: null }],
        },
      );
    },
  );

  it.each([null, undefined, '', 'U'])(
    'preserves sparse indicator %j in discovery and summary without treating it as false',
    async (indicator) => {
      const system = {
        pwsid: 'WA1234567',
        pws_activity_code: 'A',
        ...(indicator === undefined
          ? {}
          : { is_school_or_daycare_ind: indicator, is_wholesaler_ind: indicator }),
      };
      http = network([
        { path: waterPath, rows: [system] },
        { path: waterPath, rows: [system] },
      ]);
      const discovered = data(await paced(runToolContract(search, { pwsid: 'WA1234567' })));
      const summary = data(await paced(runToolContract(profile, { pwsid: 'WA1234567' })));
      expect(discovered.items).toEqual([system]);
      expect(summary.system).toEqual(system);
    },
  );

  it('includes inactive school systems only when all activity is requested and continues exactly', async () => {
    http = network([
      {
        path: /water_system\/is_school_or_daycare_ind\/equals\/Y\/sort\//,
        rows: [
          {
            pwsid: 'WA1234567',
            pws_activity_code: 'A',
            is_school_or_daycare_ind: 'Y',
            is_wholesaler_ind: 'N',
          },
          {
            pwsid: 'WA1234568',
            pws_activity_code: 'I',
            is_school_or_daycare_ind: 'Y',
            is_wholesaler_ind: 'Y',
          },
        ],
      },
    ]);
    const input = { school_or_daycare: true, activity: 'all', limit: 1 } as const;
    const first = data(await paced(runToolContract(search, input)));
    const last = data(
      await paced(runToolContract(search, { ...input, cursor: String(first.next_cursor) })),
    );
    expect(first).toMatchObject({
      items: [{ pwsid: 'WA1234567', is_school_or_daycare_ind: 'Y', is_wholesaler_ind: 'N' }],
      source_complete: false,
    });
    expect(last).toMatchObject({
      items: [
        {
          pwsid: 'WA1234568',
          pws_activity_code: 'I',
          is_school_or_daycare_ind: 'Y',
          is_wholesaler_ind: 'Y',
        },
      ],
      has_more: false,
      source_complete: false,
    });
    expect(http.calls).toHaveLength(1);
  });

  it('fails ignored school filters instead of turning unknown source flags into a false match', async () => {
    http = network([
      {
        path: /is_school_or_daycare_ind\/equals\/N\//,
        rows: [{ pwsid: 'WA1234567', pws_activity_code: 'A', is_school_or_daycare_ind: null }],
      },
    ]);
    const result = await paced(runToolContract(search, { school_or_daycare: false }));
    error(result, 'upstream_contract_changed');
    expect(JSON.stringify(result.content)).toContain('Recovery:');
  });

  it('selects jurisdiction actions through legal-state membership with exact action and date predicates', async () => {
    http = network([
      {
        path: /water_system\/state_code\/equals\/WA\//,
        rows: [{ pwsid: 'WA1234567', state_code: 'WA' }],
      },
      {
        path: /enforcement_action\/pwsid\/in\/WA1234567\/and\/enforcement_action_type_code\/equals\/SFJ\/and\/originator_code\/equals\/S\//,
        rows: [
          {
            pwsid: 'WA1234567',
            enforcement_id: 'before',
            enforcement_action_type_code: 'SFJ',
            originator_code: 'S',
            enforcement_date: '2024-12-31',
          },
          {
            pwsid: 'WA1234567',
            enforcement_id: 'start',
            enforcement_action_type_code: 'SFJ',
            originator_code: 'S',
            enforcement_date: '2025-01-01',
          },
          {
            pwsid: 'WA1234567',
            enforcement_id: 'end',
            enforcement_action_type_code: 'SFJ',
            originator_code: 'S',
            enforcement_date: '2025-12-31',
          },
          {
            pwsid: 'WA1234567',
            enforcement_id: 'after',
            enforcement_action_type_code: 'SFJ',
            originator_code: 'S',
            enforcement_date: '2026-01-01',
          },
        ],
      },
      { path: /value_type\/equals\/ENFORCEMENT_ACTION_TYPE_CODE\//, rows: [] },
    ]);
    const result = data(
      await paced(
        runToolContract(enforcement, {
          state: 'Washington',
          action_type: 'sfj',
          originator: 's',
          date_from: '2025-01-01',
          date_to: '2025-12-31',
        }),
      ),
    );
    expect(result).toMatchObject({
      items: [{ enforcement_id: 'start' }, { enforcement_id: 'end' }],
      effective_filters: { state: 'WA', state_basis: 'reported_legal_entity' },
      source_complete: true,
    });
  });

  it('rejects enforcement scopes missing their required identifiers before HTTP', async () => {
    for (const input of [
      {},
      { state: 'WA', section: 'associations' },
      { state: 'WA', violation_id: 'V' },
      { county: 'King' },
    ] as const) {
      const result = await runToolContract(enforcement, input);
      error(result, 'invalid_selector');
      expect(JSON.stringify(result.content)).toContain('Recovery:');
    }
    expect(http.calls).toEqual([]);
  });

  it.each(['actions', 'associations'] as const)(
    'intersects PWSID, state and punctuated county in section %s',
    async (section) => {
      http = network([
        {
          path: /water_system\/pwsid\/equals\/WA1234567\/and\/state_code\/equals\/WA\//,
          rows: [{ pwsid: 'WA1234567', state_code: 'WA' }],
        },
        {
          path: /geographic_area\/county_served\/beginsWith\/ST\//,
          rows: [
            { pwsid: 'OR1234567', county_served: 'St. Clair' },
            { pwsid: 'WA1234567', county_served: 'St. Clair' },
          ],
        },
        ...(section === 'actions'
          ? [
              {
                path: /enforcement_action\/pwsid\/in\/WA1234567\/and\/enforcement_action_type_code\/beginsWith\/SO\//,
                rows: [
                  {
                    pwsid: 'WA1234567',
                    enforcement_id: 'wanted',
                    enforcement_action_type_code: 'SO+',
                  },
                  {
                    pwsid: 'WA1234567',
                    enforcement_id: 'broad',
                    enforcement_action_type_code: 'SOX',
                  },
                ],
              },
              {
                path: /value_type\/equals\/ENFORCEMENT_ACTION_TYPE_CODE\//,
                rows: [
                  {
                    value_type: 'ENFORCEMENT_ACTION_TYPE_CODE',
                    value_code: 'SO+',
                    value_description: 'Source action',
                  },
                ],
              },
            ]
          : [
              {
                path: /violation_enf_assoc\/pwsid\/in\/WA1234567\/and\/violation_id\/equals\/V\//,
                rows: [{ pwsid: 'WA1234567', violation_id: 'V', enforcement_id: 'wanted' }],
              },
            ]),
      ]);
      const result = data(
        await paced(
          runToolContract(enforcement, {
            pwsid: 'wa1234567',
            state: 'WA',
            county: 'St. Clair County',
            section,
            ...(section === 'actions' ? { action_type: 'SO+' } : { violation_id: 'V' }),
          }),
        ),
      );
      expect(result).toMatchObject({
        items: [{ pwsid: 'WA1234567', enforcement_id: 'wanted' }],
        returned: 1,
        has_more: false,
        source_complete: true,
        effective_filters: { pwsid: 'WA1234567', state: 'WA', county: 'ST. CLAIR' },
      });
    },
  );

  it.each(['actions', 'associations'] as const)(
    'returns empty section %s for unknown IDs or an excluded geographic intersection',
    async (section) => {
      for (const pwsid of ['ZZ0000000', 'OR1234567']) {
        http.verify();
        http = network([
          { path: /water_system\/pwsid\/equals\/.+\/and\/state_code\/equals\/WA\//, rows: [] },
        ]);
        expect(
          data(await paced(runToolContract(enforcement, { pwsid, state: 'WA', section }))),
        ).toMatchObject({ items: [], returned: 0, has_more: false, source_complete: true });
        expect(http.calls).toHaveLength(1);
      }
    },
  );

  it('keeps violation association joins exact after safe-prefix pushdown', async () => {
    http = network([
      { path: waterPath, rows: [{ pwsid: 'WA1234567', state_code: 'WA' }] },
      {
        path: /violation_enf_assoc\/pwsid\/equals\/WA1234567\/and\/violation_id\/beginsWith\/V\//,
        rows: [
          { pwsid: 'WA1234567', violation_id: 'V.1', enforcement_id: 'wanted' },
          { pwsid: 'WA1234567', violation_id: 'V.2', enforcement_id: 'broad' },
        ],
      },
      {
        path: /enforcement_action\/pwsid\/in\/WA1234567\//,
        rows: [
          { pwsid: 'WA1234567', enforcement_id: 'wanted' },
          { pwsid: 'WA1234567', enforcement_id: 'broad' },
        ],
      },
    ]);
    expect(
      data(
        await paced(
          runToolContract(enforcement, { pwsid: 'WA1234567', state: 'WA', violation_id: 'V.1' }),
        ),
      ),
    ).toMatchObject({ items: [{ enforcement_id: 'wanted' }], returned: 1, source_complete: true });
  });

  it('resumes jurisdiction enforcement after a membership checkpoint and replays the immutable result', async () => {
    const inventory = Array.from({ length: 1000 }, (_, i) => ({
      pwsid: `WA${String(i).padStart(7, '0')}`,
      state_code: 'WA',
    }));
    let aborted = false;
    http = network([
      { path: /water_system\/state_code\/equals\/WA\/.*\/1:1000\/json$/, rows: inventory },
      {
        path: /water_system\/state_code\/equals\/WA\/.*\/1001:2000\/json$/,
        response: (signal) =>
          new Promise<Response>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            ),
          ),
      },
    ]);
    const input = { state: 'WA', limit: 1 };
    const checkpoint = data(await paced(runToolContract(enforcement, input)));
    expect(checkpoint).toMatchObject({
      phase: 'membership',
      items: [],
      has_more: true,
      source_complete: false,
    });
    expect(aborted).toBe(true);
    http.verify();
    http = network([
      { path: /water_system\/state_code\/equals\/WA\/.*\/1001:2000\/json$/, rows: [] },
      {
        path: /enforcement_action\/pwsid\/in\//,
        rows: [
          { pwsid: 'WA0000000', enforcement_id: 'one' },
          { pwsid: 'WA0000000', enforcement_id: 'two' },
        ],
      },
    ]);
    const next = { ...input, cursor: String(checkpoint.next_cursor) };
    const resumed = data(await paced(runToolContract(enforcement, next)));
    expect(resumed).toMatchObject({
      items: [{ pwsid: 'WA0000000', enforcement_id: 'one' }],
      returned: 1,
      has_more: true,
      source_complete: false,
    });
    expect(data(await paced(runToolContract(enforcement, next)))).toEqual(resumed);
    error(await paced(runToolContract(enforcement, { ...next, state: 'OR' })), 'cursor_invalid');
    expect(http.calls).toHaveLength(2);
  });

  it.each(['violations', 'contaminants', 'enforcement'] as const)(
    'keeps staged %s work in membership and begins partition zero only after resolution',
    async (name) => {
      const { setStageProducer } = await import(
        '../../src/services/sdwis/drinking-water-service.js'
      );
      const stage = vi.fn<Parameters<typeof setStageProducer>[0]>(async (partition) => ({
        canvas_id: 'test',
        table_name: 'partition',
        row_count: partition.rows.length,
        source_complete: partition.output.source_complete,
        expires_at: '2026-10-25T01:00:00Z',
        pointer: 'Inspect partition.',
      }));
      setStageProducer(stage);
      const definition =
        name === 'enforcement' ? enforcement : name === 'contaminants' ? contaminants : violations;
      const input = {
        state: 'WA',
        stage: true,
        ...(name === 'contaminants' ? { dataset: 'violations' as const } : {}),
      };
      http = network([
        {
          path: waterPath,
          response: (signal) =>
            new Promise<Response>((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            ),
        },
      ]);
      const result = data(await paced(runToolContract(definition, input)));
      expect(result).toMatchObject({
        phase: 'membership',
        items: [],
        has_more: true,
        source_complete: false,
      });
      expect(result.selection_partition).toBeUndefined();
      expect(result.dataset).toBeUndefined();
      expect(stage).not.toHaveBeenCalled();
      expect(JSON.stringify(result.notices)).not.toContain('No matching records');
      http.verify();
      http = network([
        { path: waterPath, rows: [{ pwsid: 'WA1234567', state_code: 'WA' }] },
        {
          path: name === 'enforcement' ? /sdwis\.enforcement_action\// : violationPath,
          rows: [
            {
              pwsid: 'WA1234567',
              ...(name === 'enforcement' ? { enforcement_id: 'one' } : { violation_id: 'one' }),
            },
          ],
        },
      ]);
      const next = { ...input, cursor: String(result.next_cursor) };
      const resumed = data(await paced(runToolContract(definition, next)));
      expect(resumed).toMatchObject({
        returned: 1,
        has_more: false,
        source_complete: true,
        phase: 'preview',
        dataset: { row_count: 1, source_complete: true },
        selection_partition: { partition: 0, final_partition: 0 },
      });
      expect(stage).toHaveBeenCalledTimes(1);
      expect(data(await paced(runToolContract(definition, next)))).toEqual(resumed);
      expect(stage).toHaveBeenCalledTimes(1);
      http.verify();
      http = network([{ path: waterPath, rows: [] }]);
      const empty = data(await paced(runToolContract(definition, input)));
      expect(empty).toMatchObject({
        items: [],
        has_more: false,
        source_complete: true,
        dataset: { row_count: 0, source_complete: true },
        selection_partition: { partition: 0, final_partition: 0 },
      });
      expect(stage).toHaveBeenCalledTimes(2);
      http.verify();
      const caller = new AbortController();
      http = network([
        {
          path: waterPath,
          response: () => {
            caller.abort(new DOMException('cancelled staged membership', 'AbortError'));
            return Response.json([]);
          },
        },
      ]);
      const cancelled = await paced(
        runToolContract(definition, input, { context: { signal: caller.signal } }),
      );
      expect(cancelled).toMatchObject({
        isError: true,
        structuredContent: { error: { code: -32011 } },
      });
      expect(JSON.stringify(cancelled.content)).toContain('cancelled staged membership');
      expect(stage).toHaveBeenCalledTimes(2);
    },
  );
  it.each([true, false])(
    'returns whole 500-row pages and handles 501 with clamping %s',
    async (clamp) => {
      vi.stubEnv('SDWIS_CLAMP_LIMITS', String(clamp));
      vi.resetModules();
      const scopedSearch = (
        await import('../../src/mcp-server/tools/definitions/search-water-systems.tool.js')
      ).searchWaterSystemsTool;
      const rows = Array.from({ length: 501 }, (_, i) => ({
        pwsid: `WA${String(i).padStart(7, '0')}`,
        pws_activity_code: 'A',
        state_code: 'WA',
      }));
      for (const limit of [500, 501]) {
        if (!clamp && limit === 501) {
          error(
            await paced(runToolContract(scopedSearch, { state: 'WA', limit })),
            'invalid_arguments',
          );
          continue;
        }
        http.verify();
        http = network([{ path: waterPath, rows }]);
        const input = { state: 'WA', limit };
        const first = data(await paced(runToolContract(scopedSearch, input)));
        expect(first).toMatchObject({
          items: rows.slice(0, 500),
          returned: 500,
          limit: 500,
          has_more: true,
          source_complete: false,
        });
        expect(
          (first.notices as string[]).filter((notice) => notice.includes('clamped')),
        ).toHaveLength(limit > 500 ? 1 : 0);
        const next = { ...input, cursor: String(first.next_cursor) };
        const last = data(await paced(runToolContract(scopedSearch, next)));
        expect(last).toMatchObject({
          items: rows.slice(500),
          returned: 1,
          has_more: false,
          source_complete: false,
        });
        expect([...(first.items as unknown[]), ...(last.items as unknown[])]).toEqual(rows);
        expect(data(await paced(runToolContract(scopedSearch, next)))).toEqual(last);
        expect(http.calls).toHaveLength(1);
      }
    },
  );

  it.each(['true', 'false'])(
    'wires row limits and strict legacy rejection through each SDWIS tool in clamp mode %s',
    async (mode) => {
      vi.stubEnv('SDWIS_CLAMP_LIMITS', mode);
      vi.resetModules();
      const [s, p, v, e, r] = await Promise.all([
        import('../../src/mcp-server/tools/definitions/search-water-systems.tool.js'),
        import('../../src/mcp-server/tools/definitions/get-system-profile.tool.js'),
        import('../../src/mcp-server/tools/definitions/get-violations.tool.js'),
        import('../../src/mcp-server/tools/definitions/get-enforcement-actions.tool.js'),
        import('../../src/mcp-server/tools/definitions/list-reference.tool.js'),
      ]);
      const cases = [
        [
          s.searchWaterSystemsTool,
          { pwsid: 'WA1234567' },
          { path: waterPath, rows: [{ pwsid: 'WA1234567', pws_activity_code: 'A' }] },
        ],
        [
          p.getSystemProfileTool,
          { pwsid: 'WA1234567' },
          { path: waterPath, rows: [{ pwsid: 'WA1234567' }] },
        ],
        [
          v.getViolationsTool,
          { pwsid: 'WA1234567' },
          { path: violationPath, rows: [{ pwsid: 'WA1234567', violation_id: 'one' }] },
        ],
        [
          e.getEnforcementActionsTool,
          { pwsid: 'WA1234567' },
          {
            path: /sdwis\.enforcement_action\//,
            rows: [{ pwsid: 'WA1234567', enforcement_id: 'one' }],
          },
        ],
        [
          r.listReferenceTool,
          { topic: 'violation_types' },
          { path: dictionaryPath, rows: [{ value_type: 'VIOLATION_CODE', value_code: 'X' }] },
        ],
      ] as const;
      for (const [tool, input, exchange] of cases) {
        expect(tool.errors?.map((contract) => contract.reason)).not.toContain('item_too_large');
        for (const limit of [500, 501]) {
          http.verify();
          if (mode === 'false' && limit === 501) {
            error(await paced(runToolContract(tool, { ...input, limit })), 'invalid_arguments');
            continue;
          }
          http = network([exchange]);
          const result = data(await paced(runToolContract(tool, { ...input, limit })));
          expect(result.limit).toBe(500);
          expect(
            (result.notices as string[]).filter((notice) => notice.includes('clamped')),
          ).toHaveLength(limit === 501 ? 1 : 0);
        }
        for (const legacy of [{ view: 'records' }, { view: 'text' }, { record_cursor: 'obsolete' }])
          error(await paced(runToolContract(tool, { ...input, ...legacy })), 'invalid_arguments');
        for (const limit of [0, -1, 1.5])
          error(await paced(runToolContract(tool, { ...input, limit })), 'invalid_arguments');
      }
    },
  );

  it('resolves a profile clamp once despite its inventory lookup and keeps large summaries whole', async () => {
    const ctx = createMockContext({ errors: profile.errors });
    const notice = vi.spyOn(ctx.log, 'notice');
    http = network([
      {
        path: /water_system\/pwsid\/equals\/WA1234567\/sort\/pwsid\/1:1\/json$/,
        rows: [{ pwsid: 'WA1234567' }],
      },
      { path: /sdwis\.geographic_area\//, rows: [] },
    ]);
    const output = await paced(
      Promise.resolve(
        profile.handler(
          profile.input.parse({ pwsid: 'WA1234567', section: 'geography', limit: 501 }),
          ctx,
        ),
      ),
    );
    expect(output).toMatchObject({ limit: 500, returned: 0, found: true, source_complete: true });
    expect(notice).toHaveBeenCalledTimes(1);
    http.verify();
    const system = { pwsid: 'WA1234567', pws_name: '漢字🌊 **source**'.repeat(6000) };
    http = network([{ path: waterPath, rows: [system] }]);
    expect(data(await paced(runToolContract(profile, { pwsid: 'WA1234567' })))).toMatchObject({
      system,
      items: [],
      returned: 0,
      found: true,
      source_complete: true,
    });
  });

  it('returns the full row-count preview of a larger staged partition and keeps coverage final', async () => {
    const { setStageProducer } = await import('../../src/services/sdwis/drinking-water-service.js');
    const rows = Array.from({ length: 501 }, (_, i) => ({
      pwsid: 'WA1234567',
      violation_id: String(i),
      facility_id: '🌊'.repeat(20),
    }));
    const partitions: unknown[] = [];
    setStageProducer(async (partition) => {
      partitions.push(partition);
      return {
        canvas_id: 'test',
        table_name: 'violations',
        row_count: partition.rows.length,
        source_complete: partition.output.source_complete,
        expires_at: '2026-10-25T01:00:00Z',
        pointer: 'Inspect violations.',
      };
    });
    http = network([{ path: violationPath, rows }]);
    const result = data(
      await paced(
        runToolContract(violations, {
          pwsid: 'WA1234567',
          stage: true,
          stage_max_rows: 501,
          limit: 500,
        }),
      ),
    );
    expect(result).toMatchObject({
      returned: 500,
      has_more: false,
      source_complete: true,
      truncated: true,
      phase: 'preview',
      dataset: { row_count: 501, source_complete: true },
      selection_partition: { partition: 0, final_partition: 0 },
    });
    expect(result.items).toMatchObject(rows.slice(0, 500));
    expect(partitions).toMatchObject([{ rows, output: { returned: 501, source_complete: true } }]);
    expect(result.next_cursor).toBeUndefined();
  });

  it.each([undefined, 100])(
    'returns final long membership provenance and whole rows at limit %s',
    async (limit) => {
      const ids = Array.from({ length: 50 }, (_, i) => `WA${String(i).padStart(7, '0')}`);
      const rows = Array.from({ length: 11 }, (_, i) => ({
        pwsid: ids[0],
        violation_id: String(i),
        facility_id: `![source](https://example.invalid/${'🌊'.repeat(900)})`,
      }));
      const etag = `"${'revision'.repeat(2000)}"`;
      http = network([
        { path: waterPath, rows: ids.map((pwsid) => ({ pwsid, state_code: 'WA' })) },
        {
          path: /sdwis\.violation\/pwsid\/in\//,
          response: () => Response.json(rows, { headers: { etag } }),
        },
      ]);
      const response = await paced(
        runToolContract(violations, { state: 'WA', ...(limit ? { limit } : {}) }),
      );
      expect(
        response.isError,
        JSON.stringify(
          typeof response.structuredContent === 'object' &&
            response.structuredContent !== null &&
            'error' in response.structuredContent
            ? response.structuredContent
            : {},
        ),
      ).not.toBe(true);
      const first = data(response);
      const actualUrl = `https://data.epa.gov${http.calls[1]}`;
      expect(first.provenance).toMatchObject({ url: actualUrl, etag });
      expect(actualUrl.length).toBeGreaterThan(600);
      expect(first).toMatchObject({
        items: rows.slice(0, limit ?? 10),
        returned: Math.min(limit ?? 10, rows.length),
      });
      if (first.has_more) {
        const last = data(
          await paced(
            runToolContract(violations, { state: 'WA', cursor: String(first.next_cursor) }),
          ),
        );
        expect(last).toMatchObject({
          items: rows.slice(10),
          source_complete: false,
          has_more: false,
          provenance: { url: actualUrl },
        });
      } else expect(first.source_complete).toBe(true);
    },
  );

  it.each(['violations', 'contaminant-violations', 'lcr'] as const)(
    'keeps final county provenance through %s wiring',
    async (mode) => {
      const ids = Array.from({ length: 50 }, (_, i) => `WA${String(i).padStart(7, '0')}`);
      const etag = `"${'revision'.repeat(2000)}"`;
      http = network([
        { path: waterPath, rows: ids.map((pwsid) => ({ pwsid, state_code: 'WA' })) },
        {
          path: /geographic_area\/county_served\/equals\/KING\//,
          rows: ids.map((pwsid) => ({ pwsid, county_served: 'KING' })),
        },
        ...(mode === 'lcr'
          ? [
              {
                path: /sdwis\.lcr_sample\/pwsid\/in\//,
                rows: [
                  {
                    pwsid: ids[0],
                    sample_id: 'one',
                    sampling_start_date: '2025-01-01',
                    sampling_end_date: '2025-01-31',
                  },
                ],
              },
            ]
          : []),
        {
          path:
            mode === 'lcr'
              ? /sdwis\.lcr_sample_result\/pwsid\/in\//
              : /sdwis\.violation\/pwsid\/in\//,
          response: () =>
            Response.json(
              [
                {
                  pwsid: ids[0],
                  ...(mode === 'lcr'
                    ? { sample_id: 'one', sample_measure: 0 }
                    : { violation_id: 'one' }),
                },
              ],
              { headers: { etag } },
            ),
        },
      ]);
      const input = { state: 'WA', county: 'King County' };
      const result = data(
        await paced(
          runToolContract(mode === 'violations' ? violations : contaminants, {
            ...input,
            ...(mode === 'violations' ? {} : { dataset: mode === 'lcr' ? 'lcr' : 'violations' }),
          }),
        ),
      );
      expect(result).toMatchObject({
        returned: 1,
        has_more: false,
        source_complete: true,
        effective_filters: { state: 'WA', county: 'KING' },
        provenance: { url: `https://data.epa.gov${http.calls.at(-1)}`, etag },
      });
      expect((result.provenance as { url: string }).url.length).toBeGreaterThan(600);
      if (mode === 'lcr')
        expect(result.items).toMatchObject([
          { sample_id: 'one', sample_measure: 0, period_joined: true },
        ]);
    },
  );
  it('preserves exact row order and conservative completeness for a small pending-page slice', async () => {
    const rows = [0, 1, 2].map((i) => ({
      pwsid: `WA000000${i}`,
      state_code: 'WA',
      pws_activity_code: 'A',
    }));
    http = network([{ path: waterPath, rows }]);
    const input = { state: 'WA', limit: 2 };
    const first = data(await paced(runToolContract(search, input)));
    const last = data(
      await paced(runToolContract(search, { ...input, cursor: String(first.next_cursor) })),
    );
    expect(first).toMatchObject({
      items: rows.slice(0, 2),
      returned: 2,
      has_more: true,
      source_complete: false,
    });
    expect(last).toMatchObject({
      items: rows.slice(2),
      returned: 1,
      has_more: false,
      source_complete: false,
    });
    expect(http.calls).toHaveLength(1);
  });
  it.each(['EF/', 'SF%', 'SO+', 'UNKNOWN_CODE'])(
    'retrieves and labels literal action code %s',
    async (code) => {
      const prefix = code === 'UNKNOWN_CODE' ? 'UNKNOWN_CODE' : code.slice(0, 2);
      http = network([
        {
          path: new RegExp(
            `/enforcement_action_type_code/${code === 'UNKNOWN_CODE' ? 'equals' : 'beginsWith'}/${prefix}/`,
          ),
          rows: [
            {
              pwsid: 'WA1234567',
              enforcement_id: 'other',
              enforcement_action_type_code: code === 'UNKNOWN_CODE' ? code : `${prefix}X`,
            },
            { pwsid: 'WA1234567', enforcement_id: 'wanted', enforcement_action_type_code: code },
          ],
        },
        {
          path: /\/value_type\/equals\/ENFORCEMENT_ACTION_TYPE_CODE\/sort\/value_type:asc,value_code:asc\/1:1000\/json$/,
          rows: [
            {
              value_type: 'ENFORCEMENT_ACTION_TYPE_CODE',
              value_code: code,
              value_description: 'Literal action',
            },
          ],
        },
      ]);
      const result = data(
        await paced(
          runToolContract(enforcement, { pwsid: 'WA1234567', action_type: code.toLowerCase() }),
        ),
      );
      expect(result.items).toEqual(
        (code === 'UNKNOWN_CODE' ? ['other', 'wanted'] : ['wanted']).map((enforcement_id) => ({
          pwsid: 'WA1234567',
          enforcement_id,
          enforcement_action_type_code: code,
          enforcement_action_type_label: 'Literal action',
        })),
      );
      expect(result).toMatchObject({
        effective_filters: { action_type: code },
        has_more: false,
        source_complete: true,
      });
    },
  );

  it('labels punctuated source codes without an action selector and caches the complete dictionary', async () => {
    const actions = ['EF/', 'SF%', 'SO+', 'MISSING'];
    const rows = actions.map((code, i) => ({
      pwsid: 'WA1234567',
      enforcement_id: String(i),
      enforcement_action_type_code: code,
    }));
    http = network([
      { path: /sdwis\.enforcement_action\/pwsid\/in\/WA1234567\/sort\//, rows },
      {
        path: /\/value_type\/equals\/ENFORCEMENT_ACTION_TYPE_CODE\/sort\//,
        rows: actions.slice(0, 3).map((value_code) => ({
          value_type: 'ENFORCEMENT_ACTION_TYPE_CODE',
          value_code,
          value_description: value_code,
        })),
      },
      { path: /sdwis\.enforcement_action\/pwsid\/in\/WA1234567\/sort\//, rows },
    ]);
    for (let i = 0; i < 2; i++) {
      const result = data(await paced(runToolContract(enforcement, { pwsid: 'WA1234567' })));
      expect(result.items).toEqual(
        rows.map((row, index) => ({
          ...row,
          enforcement_action_type_label: index === 3 ? null : actions[index],
        })),
      );
    }
    expect(http.calls).toHaveLength(3);
  });

  it('pages label dictionaries to exhaustion and refreshes only after the one-hour TTL', async () => {
    const row = { pwsid: 'WA1234567', enforcement_id: 'one', enforcement_action_type_code: 'SO+' };
    const dictionary = Array.from({ length: 1000 }, (_, i) => ({
      value_type: 'ENFORCEMENT_ACTION_TYPE_CODE',
      value_code: `A${String(i).padStart(4, '0')}`,
      value_description: null,
    }));
    http = network([
      { path: /sdwis\.enforcement_action\//, rows: [row] },
      {
        path: /\/value_type\/equals\/ENFORCEMENT_ACTION_TYPE_CODE\/sort\/.*\/1:1000\/json$/,
        rows: dictionary,
      },
      {
        path: /\/value_type\/equals\/ENFORCEMENT_ACTION_TYPE_CODE\/sort\/.*\/1001:2000\/json$/,
        rows: [
          {
            value_type: 'ENFORCEMENT_ACTION_TYPE_CODE',
            value_code: 'SO+',
            value_description: 'Old label',
          },
        ],
      },
      { path: /sdwis\.enforcement_action\//, rows: [row] },
      {
        path: /\/value_type\/equals\/ENFORCEMENT_ACTION_TYPE_CODE\/sort\/.*\/1:1000\/json$/,
        rows: [
          {
            value_type: 'ENFORCEMENT_ACTION_TYPE_CODE',
            value_code: 'SO+',
            value_description: 'New label',
          },
        ],
      },
    ]);
    expect(data(await paced(runToolContract(enforcement, { pwsid: 'WA1234567' })))).toMatchObject({
      items: [{ enforcement_action_type_label: 'Old label' }],
    });
    vi.setSystemTime(Date.now() + 3600001);
    expect(data(await paced(runToolContract(enforcement, { pwsid: 'WA1234567' })))).toMatchObject({
      items: [{ enforcement_action_type_label: 'New label' }],
    });
  });

  it('loads literal star contaminant labels without widening the contaminant selector grammar', async () => {
    http = network([
      {
        path: violationPath,
        rows: [
          { pwsid: 'WA1234567', violation_id: 'one', contaminant_code: '1***' },
          { pwsid: 'WA1234567', violation_id: 'two', contaminant_code: '2***' },
        ],
      },
      {
        path: /\/value_type\/equals\/CONTAMINANT_CODE\/sort\//,
        rows: [
          { value_type: 'CONTAMINANT_CODE', value_code: '1***', value_description: 'Inorganic' },
          { value_type: 'CONTAMINANT_CODE', value_code: '2***', value_description: 'Organic' },
        ],
      },
    ]);
    expect(data(await paced(runToolContract(violations, { pwsid: 'WA1234567' })))).toMatchObject({
      items: [{ contaminant_label: 'Inorganic' }, { contaminant_label: 'Organic' }],
    });
    error(
      await runToolContract(violations, { pwsid: 'WA1234567', contaminant: '1***' }),
      'unknown_contaminant',
    );
  });

  it.each(['repeated', 'changed', 'cancelled'] as const)(
    'does not cache a %s partial dictionary',
    async (mode) => {
      const action = {
        pwsid: 'WA1234567',
        enforcement_id: 'one',
        enforcement_action_type_code: 'SO+',
      };
      const firstPage = Array.from({ length: 1000 }, (_, i) => ({
        value_type: 'ENFORCEMENT_ACTION_TYPE_CODE',
        value_code: `A${i}`,
        value_description: null,
      }));
      const caller = new AbortController();
      http = network([
        { path: /sdwis\.enforcement_action\//, rows: [action] },
        {
          path: /\/value_type\/equals\/ENFORCEMENT_ACTION_TYPE_CODE\/.*\/1:1000\/json$/,
          response: () => Response.json(firstPage, { headers: { etag: 'first' } }),
        },
        {
          path: /\/value_type\/equals\/ENFORCEMENT_ACTION_TYPE_CODE\/.*\/1001:2000\/json$/,
          response: () => {
            if (mode === 'cancelled')
              caller.abort(new DOMException('dictionary cancelled', 'AbortError'));
            return Response.json(mode === 'repeated' ? firstPage : [], {
              headers: { etag: mode === 'changed' ? 'changed' : 'first' },
            });
          },
        },
      ]);
      const result = await paced(
        runToolContract(
          enforcement,
          { pwsid: 'WA1234567' },
          { context: { signal: caller.signal } },
        ),
      );
      if (mode === 'cancelled') {
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: -32011 } },
        });
        expect(JSON.stringify(result.content)).toContain('dictionary cancelled');
      } else {
        error(result, mode === 'repeated' ? 'upstream_paging_changed' : 'source_changed');
        expect(JSON.stringify(result.content)).toContain('Recovery:');
      }
      http.verify();
      http = network([
        { path: /sdwis\.enforcement_action\//, rows: [action] },
        {
          path: /\/value_type\/equals\/ENFORCEMENT_ACTION_TYPE_CODE\/.*\/1:1000\/json$/,
          rows: [
            {
              value_type: 'ENFORCEMENT_ACTION_TYPE_CODE',
              value_code: 'SO+',
              value_description: 'Complete',
            },
          ],
        },
      ]);
      expect(data(await paced(runToolContract(enforcement, { pwsid: 'WA1234567' })))).toMatchObject(
        { items: [{ enforcement_action_type_label: 'Complete' }], source_complete: true },
      );
    },
  );

  it('matches a punctuation-only action selector locally and returns empty without a dictionary fetch', async () => {
    http = network([
      {
        path: /enforcement_action\/pwsid\/in\/WA1234567\/sort\//,
        rows: [{ pwsid: 'WA1234567', enforcement_id: 'unrelated' }],
      },
    ]);
    expect(
      data(await paced(runToolContract(enforcement, { pwsid: 'WA1234567', action_type: '/#%' }))),
    ).toMatchObject({ items: [], returned: 0, has_more: false, source_complete: true });
  });

  it('exhausts broad county pages before intersecting exact membership and returns an empty match', async () => {
    http = network([
      { path: waterPath, rows: [{ pwsid: 'WA1234567', state_code: 'WA' }] },
      {
        path: /geographic_area\/county_served\/beginsWith\/ST\/.*\/1:1000\/json$/,
        rows: Array.from({ length: 1000 }, (_, i) => ({
          pwsid: `WA${String(i).padStart(7, '0')}`,
          county_served: 'STEVENS',
        })),
      },
      { path: /geographic_area\/county_served\/beginsWith\/ST\/.*\/1001:2000\/json$/, rows: [] },
    ]);
    expect(
      data(await paced(runToolContract(violations, { state: 'WA', county: 'St. Clair' }))),
    ).toMatchObject({ items: [], returned: 0, has_more: false, source_complete: true });
    expect(http.calls).toHaveLength(3);
  });

  it('rejects control characters in literal selectors with recovery before HTTP', async () => {
    for (const result of [
      await runToolContract(search, { state: 'WA', name_contains: 'A\nB' }),
      await runToolContract(search, { state: 'WA', county: 'St.\rClair' }),
      await runToolContract(enforcement, { pwsid: 'WA1234567', action_type: 'SO+\0X' }),
    ]) {
      error(result, 'invalid_selector');
      expect(JSON.stringify(result.content)).toContain('Recovery:');
    }
    expect(http.calls).toEqual([]);
  });

  it.each([
    ["DIXIE'S", 'DIXIE'],
    ['CVS #3395', '3395'],
    ['A_B', 'A'],
    ['/#%', undefined],
  ])('matches name %s literally after safe substring pushdown', async (name, run) => {
    const wanted = {
      pwsid: 'WA1234567',
      pws_activity_code: 'A',
      state_code: 'WA',
      pws_name: `The ${name} system`,
    };
    http = network([
      {
        path: run
          ? new RegExp(`/pws_name/contains/${run}/`)
          : /water_system\/state_code\/equals\/WA\/and\/pws_activity_code\/equals\/A\/sort\//,
        rows: [
          { ...wanted, pwsid: 'WA1234568', pws_name: `${run ?? 'Other'} broadly matching` },
          wanted,
        ],
      },
    ]);
    const result = data(
      await paced(runToolContract(search, { state: 'WA', name_contains: name, limit: 1 })),
    );
    expect(result).toMatchObject({
      items: [wanted],
      returned: 1,
      has_more: false,
      source_complete: true,
    });
  });

  it('advances past fully excluded name pages and preserves literal continuation identity', async () => {
    http = network([
      {
        path: /\/pws_name\/contains\/A\/.*\/1:1000\/json$/,
        rows: Array.from({ length: 1000 }, (_, i) => ({
          pwsid: `WA${String(i).padStart(7, '0')}`,
          pws_activity_code: 'A',
          state_code: 'WA',
          pws_name: 'A BROAD CANDIDATE',
        })),
      },
      {
        path: /\/pws_name\/contains\/A\/.*\/1001:2000\/json$/,
        rows: [
          { pwsid: 'WA1000000', pws_activity_code: 'A', state_code: 'WA', pws_name: 'A_B one' },
          { pwsid: 'WA1000001', pws_activity_code: 'A', state_code: 'WA', pws_name: 'A_B two' },
        ],
      },
    ]);
    const input = { state: 'WA', name_contains: 'A_B', limit: 1 };
    const first = data(await paced(runToolContract(search, input)));
    expect(first).toMatchObject({
      items: [{ pwsid: 'WA1000000' }],
      has_more: true,
      source_complete: false,
    });
    const next = { ...input, cursor: String(first.next_cursor) };
    const last = data(await paced(runToolContract(search, next)));
    expect(last).toMatchObject({
      items: [{ pwsid: 'WA1000001' }],
      has_more: false,
      source_complete: false,
    });
    expect(data(await paced(runToolContract(search, next)))).toEqual(last);
    error(
      await paced(runToolContract(search, { ...next, name_contains: 'A-B' })),
      'cursor_invalid',
    );
    expect(http.calls).toHaveLength(2);
  });

  it.each(['search', 'violations'] as const)(
    'filters exact punctuated county membership for %s before selecting rows',
    async (kind) => {
      const inventory = [
        { pwsid: 'WA1234567', state_code: 'WA', pws_activity_code: 'A' },
        { pwsid: 'WA1234568', state_code: 'WA', pws_activity_code: 'A' },
      ];
      const geography = {
        path: /geographic_area\/county_served\/beginsWith\/ST\//,
        rows: [
          { pwsid: 'WA1234568', county_served: 'STEVENS' },
          { pwsid: 'OR1234567', county_served: 'St. Clair' },
          { pwsid: 'WA1234567', county_served: 'St. Clair' },
        ],
      };
      http = network(
        kind === 'search'
          ? [geography, { path: waterPath, rows: inventory }]
          : [
              { path: waterPath, rows: inventory },
              geography,
              {
                path: /violation\/pwsid\/in\/WA1234567\//,
                rows: [{ pwsid: 'WA1234567', violation_id: 'one' }],
              },
            ],
      );
      const result = data(
        await paced(
          runToolContract(kind === 'search' ? search : violations, {
            state: 'WA',
            county: 'st. clair County',
          }),
        ),
      );
      expect(result).toMatchObject({
        items: [{ pwsid: 'WA1234567' }],
        has_more: false,
        source_complete: true,
        effective_filters: { county: 'ST. CLAIR' },
      });
      expect(result.returned).toBe(1);
    },
  );
  it('returns an LCR membership checkpoint before fact I/O', async () => {
    let stopped = false;
    http = network([
      {
        path: waterPath,
        response: (signal) =>
          new Promise<Response>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                stopped = true;
                reject(signal.reason);
              },
              { once: true },
            ),
          ),
      },
    ]);
    const result = data(
      await paced(runToolContract(contaminants, { state: 'WA', dataset: 'lcr' })),
    );
    expect(result).toMatchObject({
      phase: 'membership',
      items: [],
      returned: 0,
      has_more: true,
      source_complete: false,
    });
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(stopped).toBe(true);
  });
  it.each(['cancelled', 'intersection'])(
    'preserves %s semantics at a county membership checkpoint',
    async (mode) => {
      const caller = new AbortController();
      http = network([
        { path: waterPath, rows: [{ pwsid: 'WA1234567', state_code: 'WA' }] },
        {
          path: /geographic_area\/county_served\/equals\/KING\//,
          response: (signal) =>
            new Promise<Response>((_resolve, reject) =>
              signal.addEventListener(
                'abort',
                () => {
                  if (mode === 'cancelled')
                    caller.abort(new DOMException('caller stopped', 'AbortError'));
                  reject(signal.reason);
                },
                { once: true },
              ),
            ),
        },
      ]);
      const input = { state: 'WA', county: 'KING' };
      const result = await paced(
        runToolContract(violations, input, { context: { signal: caller.signal } }),
      );
      if (mode === 'cancelled') {
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: -32011 } },
        });
        expect(JSON.stringify(result.content)).toContain('caller stopped');
        return;
      }
      const first = data(result);
      expect(first).toMatchObject({
        phase: 'membership',
        items: [],
        has_more: true,
        source_complete: false,
      });
      http.verify();
      http = network([
        {
          path: /geographic_area\/county_served\/equals\/KING\//,
          rows: [{ pwsid: 'OR1234567', county_served: 'KING', state_served: 'WA' }],
        },
      ]);
      expect(
        data(
          await paced(runToolContract(violations, { ...input, cursor: String(first.next_cursor) })),
        ),
      ).toMatchObject({ items: [], has_more: false, source_complete: true });
    },
  );
  it.each(['cancelled', 'upstream'])(
    'preserves %s failure after committed membership instead of returning partial success',
    async (mode) => {
      const caller = new AbortController();
      http = network([
        {
          path: waterPath,
          rows: Array.from({ length: 1000 }, (_, i) => ({
            pwsid: `WA${String(i).padStart(7, '0')}`,
            state_code: 'WA',
          })),
        },
        {
          path: /\/1001:2000\/json$/,
          response: () => {
            if (mode === 'cancelled')
              caller.abort(new DOMException('caller stopped', 'AbortError'));
            return new Response(mode === 'upstream' ? 'forbidden' : '[]', {
              status: mode === 'upstream' ? 403 : 200,
            });
          },
        },
      ]);
      const result = await paced(
        runToolContract(violations, { state: 'WA' }, { context: { signal: caller.signal } }),
      );
      expect(result).toMatchObject({ isError: true });
      expect(result.structuredContent).toMatchObject({
        error:
          mode === 'cancelled' ? { code: -32011 } : { data: { status: 403, retryable: false } },
      });
      expect(JSON.stringify(result.content)).toContain(
        mode === 'cancelled' ? 'caller stopped' : '403',
      );
      expect(http.calls).toHaveLength(2);
    },
  );
  it('checkpoints slow membership at the last committed page, awaits its abort, and resumes without skipping', async () => {
    const deadlines = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('deadline', 'TimeoutError')),
        milliseconds,
      );
      return controller.signal;
    });
    let aborted = false;
    http = network([
      ...Array.from({ length: 3 }, (_, page) => ({
        path: new RegExp(
          `/sdwis\\.water_system/state_code/equals/WA/sort/pwsid/${page * 1000 + 1}:${page * 1000 + 1000}/json$`,
        ),
        response: () =>
          new Promise<Response>((resolve) =>
            setTimeout(
              () =>
                resolve(
                  Response.json(
                    Array.from({ length: 1000 }, (_, i) => ({
                      pwsid: `WA${String(page * 1000 + i).padStart(7, '0')}`,
                      state_code: 'WA',
                    })),
                  ),
                ),
              10000,
            ),
          ),
      })),
      {
        path: /\/3001:4000\/json$/,
        response: (signal) =>
          new Promise<Response>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            ),
          ),
      },
      { path: /\/sdwis\.water_system\/.*\/3001:4000\/json$/, rows: [] },
      {
        path: violationPath,
        rows: [
          { pwsid: 'WA0000000', violation_id: 'first' },
          { pwsid: 'WA0000001', violation_id: 'second' },
        ],
      },
    ]);
    try {
      const input = { state: 'WA', limit: 1 };
      const first = data(await paced(runToolContract(violations, input)));
      expect(first).toMatchObject({
        phase: 'membership',
        items: [],
        has_more: true,
        source_complete: false,
      });
      expect(aborted).toBe(true);
      expect(http.calls).toHaveLength(4);
      const next = { ...input, cursor: String(first.next_cursor) };
      error(await paced(runToolContract(violations, { ...next, state: 'OR' })), 'cursor_invalid');
      const resumed = data(await paced(runToolContract(violations, next)));
      expect(resumed).toMatchObject({
        items: [{ violation_id: 'first' }],
        has_more: true,
        source_complete: false,
      });
      expect(data(await paced(runToolContract(violations, next)))).toEqual(resumed);
      expect(http.calls).toHaveLength(6);
    } finally {
      deadlines.mockRestore();
    }
  });
  it.each(['1030', '5000', '2A01'])('passes exact violation code %s unchanged', async (code) => {
    http = network([
      {
        path: new RegExp(`/contaminant_code/equals/${code}/`),
        rows: [{ pwsid: 'WA1234567', violation_id: 'exact', contaminant_code: code }],
      },
      { path: dictionaryPath, rows: [] },
    ]);
    expect(
      data(await paced(runToolContract(violations, { pwsid: 'WA1234567', contaminant: code }))),
    ).toMatchObject({
      effective_filters: { contaminant: code },
      items: [{ contaminant_code: code }],
    });
  });
  it.each([
    ['LeAd', 'PB90'],
    ['CoPpEr', 'CU90'],
  ])('retains the LCR alias %s as %s', async (alias, code) => {
    http = network([
      { path: /\/sdwis\.lcr_sample\//, rows: [] },
      {
        path: new RegExp(`/sdwis\\.lcr_sample_result/.*contaminant_code/equals/${code}/`),
        rows: [{ pwsid: 'WA1234567', sample_id: 'S', contaminant_code: code }],
      },
      { path: dictionaryPath, rows: [] },
    ]);
    expect(
      data(
        await paced(
          runToolContract(contaminants, { pwsid: 'WA1234567', dataset: 'lcr', contaminant: alias }),
        ),
      ),
    ).toMatchObject({
      effective_filters: { contaminant: code },
      items: [{ contaminant_code: code }],
    });
  });
  it.each(['violations', 'contaminants'])(
    'uses both lead namespaces through %s without per-request validation',
    async (name) => {
      http = network([
        {
          path: /\/contaminant_code\/in\/1030%2C5000\//,
          rows: [
            { pwsid: 'WA1234567', violation_id: 'chemical', contaminant_code: '1030' },
            { pwsid: 'WA1234567', violation_id: 'rule', contaminant_code: '5000' },
          ],
        },
        {
          path: /\/value_type\/equals\/CONTAMINANT_CODE\/sort\//,
          rows: [],
        },
      ]);
      const result = data(
        await paced(
          runToolContract(name === 'violations' ? violations : contaminants, {
            pwsid: 'WA1234567',
            contaminant: 'LeAd',
            ...(name === 'contaminants' ? { dataset: 'violations' } : {}),
          }),
        ),
      );
      expect(result).toMatchObject({
        effective_filters: { contaminant: '1030,5000' },
        items: [{ contaminant_code: '1030' }, { contaminant_code: '5000' }],
      });
      expect(http.calls).toHaveLength(2);
    },
  );
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
    expect(first.selection_partition).toMatchObject({ partition: 0, final_partition: null });
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
      selection_partition: {
        selection_id: (first.selection_partition as { selection_id: string }).selection_id,
        partition: 1,
        final_partition: 1,
      },
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
      await paced(runToolContract(search, { pwsid: '01234567a', name_contains: ' ', limit: 501 })),
    );
    expect(result).toMatchObject({
      effective_filters: { pwsid: '01234567A', activity: 'active' },
      limit: 500,
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
    expect(http.calls[0]).toContain('/contaminant_code/in/1030%2C5000/');
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
    expect(first.selection_partition).toMatchObject({ partition: 0, final_partition: null });
    expect(second.selection_partition).toEqual({
      selection_id: (first.selection_partition as { selection_id: string }).selection_id,
      partition: 1,
      final_partition: 1,
    });
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

  it('keeps whole Unicode rows at the requested row boundary', async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      pwsid: `WA000000${index}`,
      pws_activity_code: 'A',
      pws_name: `${index}:${'🌊'.repeat(900)}`,
    }));
    http = network([{ path: waterPath, rows }]);
    let result = data(await paced(runToolContract(search, { pwsid_prefix: 'WA', limit: 2 })));
    const collected: unknown[] = [];
    expect(result.returned).toBe(2);
    for (let iteration = 0; iteration < 5; iteration++) {
      collected.push(...(result.items as unknown[]));
      if (!result.has_more) break;
      result = data(
        await paced(
          runToolContract(search, {
            pwsid_prefix: 'WA',
            limit: 2,
            cursor: String(result.next_cursor),
          }),
        ),
      );
    }
    expect(collected).toEqual(rows);
    expect(result.source_complete).toBe(false);
  });

  it('returns a large Unicode and markup record whole then continues at the next row', async () => {
    const row = {
      pwsid: 'WA1234567',
      pws_activity_code: 'A',
      pws_name: '🌊漢字![source](https://example.invalid)'.repeat(6000),
    };
    http = network([
      {
        path: waterPath,
        rows: [row, { pwsid: 'WA1234568', pws_activity_code: 'A', pws_name: 'next' }],
      },
    ]);
    const first = data(await paced(runToolContract(search, { pwsid_prefix: 'WA', limit: 1 })));
    expect(first).toMatchObject({
      items: [row],
      returned: 1,
      has_more: true,
      source_complete: false,
    });
    expect(first).not.toHaveProperty('text');
    const next = String(first.next_cursor);
    expect(
      data(await paced(runToolContract(search, { pwsid_prefix: 'WA', limit: 1, cursor: next }))),
    ).toMatchObject({
      items: [{ pwsid: 'WA1234568', pws_name: 'next' }],
      returned: 1,
      has_more: false,
      source_complete: false,
    });
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
