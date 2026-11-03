/**
 * @fileoverview DMAP retry, projection, abort and upstream contract boundaries.
 * @module tests/services/sdwis/sdwis-client.test
 */
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { network, paced } from './sdwis-fixtures.js';

let client: typeof import('../../../src/services/sdwis/sdwis-client.js');
let http: ReturnType<typeof network>;
const path = '/dmapservice/sdwis.water_system/pwsid/equals/WA1234567/sort/pwsid/1:1000/json';
const signal = () => new AbortController().signal;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  client = await import('../../../src/services/sdwis/sdwis-client.js');
  http = network([]);
});
afterEach(() => {
  http.verify();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function read(caller = signal()) {
  return client.readPage(
    'water_system',
    [{ column: 'pwsid', operator: 'equals', value: 'WA1234567' }],
    1,
    1000,
    caller,
  );
}

describe('DMAP network boundary', () => {
  it('preserves accepted selector normalization and rejects embedded controls', async () => {
    const { normalizeSelectors } = await import('../../../src/domain/source-inputs.js');
    expect(
      normalizeSelectors({
        pwsid: ' wa1234567 ',
        state: 'Washington',
        county: 'King County',
        name_contains: ' AB-12 ',
        action_type: 'unknown_code',
      }),
    ).toEqual({
      pwsid: 'WA1234567',
      state: 'WA',
      state_basis: 'reported_legal_entity',
      county: 'KING',
      name_contains: 'AB-12',
      action_type: 'UNKNOWN_CODE',
    });
    expect(() => normalizeSelectors({ name_contains: 'A\nB' })).toThrow(
      'Selector contains path or control characters.',
    );
  });
  it.each(['SO+', "DIXIE'S", 'ST. CLAIR', 'SF%', 'EF/', 'A_B', 'A,B', 'A\n', 'A\r\nB'])(
    'rejects grammar-unsafe contains value %j before HTTP',
    async (value) => {
      await expect(
        client.readPage(
          'water_system',
          [{ column: 'pws_name', operator: 'contains', value }],
          1,
          1,
          signal(),
        ),
      ).rejects.toMatchObject({ data: { reason: 'invalid_selector' } });
      expect(http.calls).toEqual([]);
    },
  );
  it('keeps safe exact underscores, comma-separated in values and normal substring predicates', async () => {
    const predicates = [
      { column: 'pwsid', operator: 'in' as const, value: 'WA1234567,WA1234568' },
      { column: 'pws_name', operator: 'equals' as const, value: 'A_B-12' },
    ];
    http = network([
      {
        path: '/dmapservice/sdwis.water_system/pwsid/in/WA1234567%2CWA1234568/and/pws_name/equals/A_B-12/sort/pwsid/1:1/json',
        rows: [{ pwsid: 'WA1234567', pws_name: 'A_B-12' }],
      },
    ]);
    expect(client.pushdownPredicates(predicates)).toEqual(predicates);
    expect((await paced(client.readPage('water_system', predicates, 1, 1, signal()))).rows).toEqual(
      [{ pwsid: 'WA1234567', pws_name: 'A_B-12' }],
    );
  });
  it('rechecks only a pushed superset and leaves the full literal match to the caller', async () => {
    const literal = [{ column: 'pws_name', operator: 'contains' as const, value: 'A_B' }];
    const pushed = client.pushdownPredicates(literal);
    expect(pushed).toEqual([{ column: 'pws_name', operator: 'contains', value: 'A' }]);
    http = network([
      {
        path: '/dmapservice/sdwis.water_system/pws_name/contains/A/sort/pwsid/1:1/json',
        rows: [{ pwsid: 'WA1234567', pws_name: 'MARBLE' }],
      },
    ]);
    const page = await paced(client.readPage('water_system', pushed, 1, 1, signal()));
    expect(client.matchesPredicates(page.rows[0]!, literal)).toBe(false);
    http.verify();
    http = network([
      {
        path: '/dmapservice/sdwis.water_system/pws_name/contains/A/sort/pwsid/2:2/json',
        rows: [{ pwsid: 'WA1234568', pws_name: 'OTHER' }],
      },
    ]);
    await expect(
      paced(client.readPage('water_system', pushed, 2, 1, signal())),
    ).rejects.toMatchObject({ data: { reason: 'upstream_contract_changed' } });
  });
  it('chooses a trimmed longest run and an underscore-free leading prefix without wildcard leaks', () => {
    expect(
      client.pushdownPredicates([
        { column: 'pws_name', operator: 'contains', value: '  #    AB CD   #EF  ' },
        { column: 'enforcement_action_type_code', operator: 'equals', value: 'A_B+' },
        { column: 'county_served', operator: 'equals', value: '/#%' },
        { column: 'pws_name', operator: 'contains', value: ' #\r\n/# ' },
      ]),
    ).toEqual([
      { column: 'pws_name', operator: 'contains', value: 'AB CD' },
      { column: 'enforcement_action_type_code', operator: 'beginsWith', value: 'A' },
    ]);
  });
  it('keeps unsafe selector scans below quadratic growth over a 64-fold input span', () => {
    const measurements = [5000, 10000, 20000, 40000, 80000, 160000, 320000].map((length) => {
      const values = [
        'A'.repeat(length) + '!',
        'A'.repeat(length) + '\n',
        ' \r\n'.repeat(Math.ceil(length / 3)),
        '/#%('.repeat(Math.ceil(length / 4)),
        'A_('.repeat(Math.ceil(length / 3)),
        ' '.repeat(length) + '!ABC',
      ];
      const predicates = values.flatMap((value) => [
        { column: 'pws_name', operator: 'contains' as const, value },
        { column: 'county_served', operator: 'equals' as const, value },
      ]);
      for (let i = 0; i < 5; i++) client.pushdownPredicates(predicates);
      const start = process.threadCpuUsage();
      for (let i = 0; i < 10; i++) client.pushdownPredicates(predicates);
      const cpu = process.threadCpuUsage(start);
      const used = cpu.user + cpu.system;
      expect(used).toBeLessThan(500000);
      return used;
    });
    console.info('Selector scan thread CPU microseconds:', measurements);
    expect(measurements[6]! / Math.max(measurements[0]!, 1)).toBeLessThan(256);
    expect(
      client.pushdownPredicates([
        { column: 'pws_name', operator: 'contains', value: '/#%('.repeat(20000) + 'LONGEST' },
      ]),
    ).toEqual([{ column: 'pws_name', operator: 'contains', value: 'LONGEST' }]);
  });
  it('accepts a fully read empty JSON array as an exhausted page on the first attempt', async () => {
    http = network([{ path, response: () => new Response('[]') }]);
    expect((await paced(read())).rows).toEqual([]);
    expect(http.calls).toHaveLength(1);
  });
  it('rejects a fully read empty HTTP 200 body without retry', async () => {
    http = network([{ path, response: () => new Response('') }]);
    await expect(paced(read())).rejects.toMatchObject({
      data: { reason: 'upstream_contract_changed' },
    });
    expect(http.calls).toHaveLength(1);
  });
  it('uses explicit directions for EPA composite ordering before the inclusive range', async () => {
    const expectedPath =
      '/dmapservice/sdwis.violation/pwsid/equals/WA1234567/sort/pwsid:asc,violation_id:asc/1:2/json';
    http = network([{ path: expectedPath, rows: [{ pwsid: 'WA1234567', violation_id: 'V1' }] }]);
    await paced(
      client.readPage(
        'violation',
        [{ column: 'pwsid', operator: 'equals', value: 'WA1234567' }],
        1,
        2,
        signal(),
      ),
    );
    expect(http.calls).toEqual([expectedPath]);
  });

  it('encodes a fixed projected path and strips unknown contact fields before retention', async () => {
    http = network([
      {
        path,
        response: () =>
          Response.json(
            [{ pwsid: 'WA1234567', population_served_count: null, phone: 'CONTACT-CANARY' }],
            { headers: { etag: 'revision-a', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' } },
          ),
      },
    ]);
    const page = await paced(read());
    expect(page).toMatchObject({
      rows: [{ pwsid: 'WA1234567', population_served_count: null }],
      etag: 'revision-a',
      last_modified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    expect(JSON.stringify(page)).not.toContain('CONTACT-CANARY');
  });
  it('retries a 429 and a body read failure, including the body in the retry boundary', async () => {
    http = network([
      {
        path,
        response: () => new Response(null, { status: 429, headers: { 'retry-after': '1' } }),
      },
      {
        path,
        response: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('CONTACT-CANARY'));
              },
            }),
          ),
      },
      { path, rows: [{ pwsid: 'WA1234567' }] },
    ]);
    expect((await paced(read())).rows).toEqual([{ pwsid: 'WA1234567' }]);
    expect(http.calls).toHaveLength(3);
  });
  it('retains rate limit status after the bounded attempts and does not expose a response body', async () => {
    http = network(
      Array.from({ length: 3 }, () => ({
        path,
        response: () => new Response('CONTACT-CANARY', { status: 429 }),
      })),
    );
    await expect(paced(read())).rejects.toMatchObject({ data: { status: 429, retryable: true } });
    expect(http.calls).toHaveLength(3);
  });
  it('does not retry a 403 or expose the upstream body', async () => {
    http = network([{ path, response: () => new Response('CONTACT-CANARY', { status: 403 }) }]);
    const failure = await paced(read()).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ data: { status: 403, retryable: false } });
    expect(JSON.stringify(failure)).not.toContain('CONTACT-CANARY');
  });
  it.each([
    { rows: [{ pwsid: 'WA1234567', population_served_count: '1' }] },
    { rows: [{ pwsid: 'OR1234567' }] },
    { rows: { error: 'CONTACT-CANARY' } },
  ])('rejects invalid schema or ignored predicates without retry: %j', async ({ rows }) => {
    http = network([{ path, rows }]);
    await expect(paced(read())).rejects.toMatchObject({
      data: { reason: 'upstream_contract_changed' },
    });
    expect(http.calls).toHaveLength(1);
  });
  it('rejects invalid JSON without retry', async () => {
    http = network([{ path, response: () => new Response('CONTACT-CANARY') }]);
    await expect(paced(read())).rejects.toMatchObject({
      data: { reason: 'upstream_contract_changed' },
    });
  });
  it('rethrows caller cancellation during a body read without starting another request', async () => {
    const caller = new AbortController();
    http = network([
      {
        path,
        response: () => {
          caller.abort(new DOMException('caller stopped', 'AbortError'));
          return new Response('[]');
        },
      },
    ]);
    await expect(paced(read(caller.signal))).rejects.toMatchObject({
      name: 'AbortError',
      message: 'caller stopped',
    });
    expect(http.calls).toHaveLength(1);
  });
  it('rejects path selectors before issuing a request', async () => {
    await expect(
      client.readPage(
        'water_system',
        [{ column: 'pwsid', operator: 'equals', value: 'bad/path' }],
        1,
        1,
        signal(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_selector' } });
  });
  it('bounds each hung attempt and stops after three timeouts', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('deadline', 'TimeoutError')),
        milliseconds,
      );
      return controller.signal;
    });
    const aborted: boolean[] = [];
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      const requestSignal = init?.signal;
      if (!requestSignal) throw new Error('Expected deadline signal');
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener(
          'abort',
          () => {
            aborted.push(requestSignal.aborted);
            reject(requestSignal.reason);
          },
          { once: true },
        );
      });
    });
    try {
      await expect(paced(read())).rejects.toMatchObject({
        message: 'EPA DMAP could not complete after three attempts.',
      });
      expect(aborted).toEqual([true, true, true]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
