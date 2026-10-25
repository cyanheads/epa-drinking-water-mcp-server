/**
 * @fileoverview Network-to-domain UCMR archive, index, and reader lifecycle tests.
 * @module tests/services/ucmr5/ucmr5-service.test
 */
import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveRequest,
  downloadArchive,
  parseArchive,
  UCMR5_ARCHIVE_URL,
} from '../../../src/services/ucmr5/ucmr5-archive.js';
import { Ucmr5Service } from '../../../src/services/ucmr5/ucmr5-service.js';
import { archive, occurrence, relations } from './ucmr5-fixtures.js';

const signal = () => new AbortController().signal;
const services: Ucmr5Service[] = [];
function service(fetcher: typeof fetch): Ucmr5Service {
  const instance = new Ucmr5Service({ fetch: fetcher });
  services.push(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((instance) => instance.close()));
  vi.useRealTimers();
});

describe('UCMR shared acquisition and revision leases', () => {
  it('downloads without validators and reuses an identical hash while a reader remains held', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
    const fetcher = vi.fn<typeof fetch>(async () => new Response(archive()));
    const instance = service(fetcher);
    const first = await instance.acquire(signal());
    vi.setSystemTime(new Date('2026-10-25T06:00:00Z'));
    const second = await instance.acquire(signal());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['GET', 'GET']);
    expect(second.revision.archive_sha256).toBe(first.revision.archive_sha256);
    expect(second.revision.retrieved_at).toBe('2026-10-25T06:00:00.000Z');
    first.release();
    second.release();
  });
  it('retries a transient HTTP failure through the same network seam', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
    const attempted = Promise.withResolvers<void>();
    let calls = 0;
    const instance = service(async (_url, init) => {
      if (init?.method !== 'HEAD') return new Response(archive(), { headers: { etag: 'a' } });
      calls++;
      if (calls === 1) {
        attempted.resolve();
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 304 });
    });
    (await instance.acquire(signal())).release();
    vi.setSystemTime(new Date('2026-10-25T06:00:00Z'));
    const pending = instance.acquire(signal());
    await attempted.promise;
    await vi.advanceTimersByTimeAsync(10000);
    const lease = await pending;
    expect(calls).toBe(2);
    expect(lease.measurements().occurrenceRows).toBe(1);
    lease.release();
  });

  it('preserves Forbidden and does not retry an ordinary 403', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
    await expect(service(fetcher).acquire(signal())).rejects.toMatchObject({
      data: { status: 403 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung acquisition and aborts its request at the shared deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const entered = Promise.withResolvers<AbortSignal>();
    const instance = service(async (_url, init) => {
      const requestSignal = init?.signal;
      if (!requestSignal) throw new Error('Missing acquisition signal');
      entered.resolve(requestSignal);
      return new Promise<Response>((_resolve, reject) =>
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }),
      );
    });
    const pending = instance.acquire(signal());
    const outcome = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    const networkSignal = await entered.promise;
    await vi.advanceTimersByTimeAsync(180000);
    await outcome;
    expect(networkSignal.aborted).toBe(true);
  });

  it('uses freshness and conditional HEAD without replacing a held revision', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
    const requests: RequestInit[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      requests.push(init ?? {});
      return init?.method === 'HEAD'
        ? new Response(null, { status: 304 })
        : new Response(archive(), { headers: { etag: 'revision-a' } });
    };
    const instance = service(fetcher);
    const original = await instance.acquire(signal());
    const fresh = await instance.acquire(signal());
    expect(requests).toHaveLength(1);
    fresh.release();
    vi.setSystemTime(new Date('2026-10-25T06:00:00Z'));
    const validated = await instance.acquire(signal());
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      method: 'HEAD',
      headers: { 'If-None-Match': 'revision-a' },
    });
    expect(validated.revision.archive_sha256).toBe(original.revision.archive_sha256);
    expect((await original.search({}, 0, 1, signal())).items[0]?.sample_id).toBe('S1');
    validated.release();
    original.release();
  });

  it('waits for old readers before installing changed bytes and exposes the new hash', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
    let downloads = 0;
    const secondDownload = Promise.withResolvers<void>();
    const instance = service(async (_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { headers: { etag: 'b' } });
      downloads++;
      const bytes = archive(relations([occurrence({ SampleID: downloads === 1 ? 'old' : 'new' })]));
      if (downloads === 2) secondDownload.resolve();
      return new Response(bytes, { headers: { etag: downloads === 1 ? 'a' : 'b' } });
    });
    const original = await instance.acquire(signal());
    vi.setSystemTime(new Date('2026-10-25T06:00:00Z'));
    let acquired = false;
    const replacement = instance.acquire(signal()).then((lease) => {
      acquired = true;
      return lease;
    });
    await secondDownload.promise;
    expect(acquired).toBe(false);
    expect((await original.search({}, 0, 1, signal())).items[0]?.sample_id).toBe('old');
    const oldHash = original.revision.archive_sha256;
    original.release();
    const updated = await replacement;
    expect(updated.revision.archive_sha256).not.toBe(oldHash);
    expect((await updated.search({}, 0, 1, signal())).items[0]?.sample_id).toBe('new');
    updated.release();
  });

  it('detaches one cancelled waiter while another caller completes the shared download', async () => {
    const response = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<AbortSignal>();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      entered.resolve(init?.signal as AbortSignal);
      return response.promise;
    });
    const instance = service(fetcher);
    const cancelled = new AbortController();
    const first = instance.acquire(cancelled.signal);
    const firstResult = expect(first).rejects.toThrow('caller stopped');
    const second = instance.acquire(signal());
    const sharedSignal = await entered.promise;
    cancelled.abort(new DOMException('caller stopped', 'AbortError'));
    await firstResult;
    expect(sharedSignal.aborted).toBe(false);
    response.resolve(new Response(archive()));
    const lease = await second;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(lease.measurements().occurrenceRows).toBe(1);
    lease.release();
  });

  it('aborts the network when the last waiter cancels and permits a new acquisition', async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    let calls = 0;
    const instance = service(async (_url, init) => {
      calls++;
      if (calls > 1) return new Response(archive());
      const requestSignal = init?.signal;
      if (!requestSignal) throw new Error('Missing acquisition signal');
      entered.resolve(requestSignal);
      return new Promise<Response>((_resolve, reject) =>
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }),
      );
    });
    const caller = new AbortController();
    const pending = instance.acquire(caller.signal);
    const outcome = expect(pending).rejects.toThrow('stop');
    const networkSignal = await entered.promise;
    caller.abort(new DOMException('stop', 'AbortError'));
    await outcome;
    expect(networkSignal.aborted).toBe(true);
    const lease = await instance.acquire(signal());
    expect(calls).toBe(2);
    lease.release();
  });

  it('shutdown aborts and awaits a pending network operation', async () => {
    const entered = Promise.withResolvers<void>();
    let networkAborted = false;
    const instance = service(async (_url, init) => {
      const requestSignal = init?.signal;
      if (!requestSignal) throw new Error('Missing acquisition signal');
      entered.resolve();
      return new Promise<Response>((_resolve, reject) =>
        requestSignal.addEventListener(
          'abort',
          () => {
            networkAborted = true;
            reject(requestSignal.reason);
          },
          { once: true },
        ),
      );
    });
    const pending = instance.acquire(signal());
    const outcome = expect(pending).rejects.toThrow('shutting down');
    await entered.promise;
    await instance.close();
    await outcome;
    expect(networkAborted).toBe(true);
    await expect(instance.acquire(signal())).rejects.toThrow('closed');
  });
});

describe('UCMR network-to-domain seam', () => {
  it('accepts header-only occurrence data and returns empty companions and catalogs', async () => {
    const lease = await service(async () => new Response(archive(relations([])))).acquire(signal());
    expect(await lease.search({}, 0, 1, signal())).toEqual({
      items: [],
      nextOffset: 0,
      exhausted: true,
    });
    expect(await lease.companions([], signal())).toEqual({ additional: [], zipMemberships: [] });
    expect(lease.contaminants()).toEqual([]);
    lease.release();
  });
  it('rejects missing minimum reporting levels instead of inventing zero', async () => {
    await expect(
      service(async () => new Response(archive(relations([occurrence({ MRL: '' })])))).acquire(
        signal(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'dataset_changed' } });
  });
  it('classifies a non-ZIP response as a changed dataset without retrying parser failures', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('not a zip archive'));
    await expect(service(fetcher).acquire(signal())).rejects.toMatchObject({
      data: { reason: 'dataset_changed' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves every occurrence field, CP1252, quoted cells, replicates and composite companions', async () => {
    const row = occurrence({ SamplePointName: 'Quoted\tname\nsecond line' });
    const bytes = archive(relations([row, row]));
    const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes));
    const instance = service(fetcher);
    const lease = await instance.acquire(signal());
    const page = await lease.search({}, 0, 10, signal());
    expect(page).toEqual({
      items: [
        {
          pwsid: 'WA1234567',
          pws_name: 'Water "District"',
          size: 'L',
          facility_id: 'F1',
          facility_name: 'Plant',
          facility_water_type: 'SW',
          sample_point_id: 'SP1',
          sample_point_name: 'Quoted\tname\nsecond line',
          sample_point_type: 'EP',
          associated_facility_id: 'AF1',
          associated_sample_point_id: 'ASP1',
          collection_date: '2024-02-29',
          sample_id: 'S1',
          contaminant: 'PFOA',
          mrl: 0.004,
          units: 'µg/L',
          method_id: '533',
          analytical_results_sign: '<',
          analytical_result_value: null,
          sample_event_code: 'SE1',
          monitoring_requirement: 'AM',
          region: '10',
          state: 'WA',
          ucmr1_sample_type: 'SS',
          censored: true,
        },
        expect.objectContaining({ sample_id: 'S1', analytical_result_value: null }),
      ],
      nextOffset: 2,
      exhausted: true,
    });
    expect(await lease.companions(page.items, signal())).toEqual({
      additional: [
        {
          pwsid: 'WA1234567',
          facility_id: 'F1',
          sample_point_id: 'SP1',
          sample_event_code: 'SE1',
          additional_data_element: 'Treatment',
          response: 'A',
          if_other_text: '',
        },
        {
          pwsid: 'WA1234567',
          facility_id: 'F1',
          sample_point_id: 'SP1',
          sample_event_code: 'SE1',
          additional_data_element: 'Treatment',
          response: 'B',
          if_other_text: 'Other\ttext\nnext line',
        },
      ],
      zipMemberships: [
        { pwsid: 'WA1234567', zip_code: '98101' },
        { pwsid: 'WA1234567', zip_code: '98102' },
      ],
    });
    expect([...lease.zipPwsids('98101')]).toEqual(['WA1234567', 'OR1234567']);
    expect(lease.revision.archive_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(UCMR5_ARCHIVE_URL);
    lease.release();
    lease.release();
    expect(() => lease.contaminants()).toThrow('released');
  });

  it('advances source offsets across censored and filtered rows and keeps numeric zero detected', async () => {
    const rows = [
      occurrence(),
      occurrence({
        Contaminant: 'Lithium',
        AnalyticalResultsSign: '=',
        AnalyticalResultValue: '1',
      }),
      occurrence({ AnalyticalResultsSign: '=', AnalyticalResultValue: '0', SampleID: 'zero' }),
      occurrence({
        AnalyticalResultsSign: '=',
        AnalyticalResultValue: '2e-3',
        SampleID: 'later',
        CollectionDate: '1/1/2025',
      }),
    ];
    const lease = await service(async () => new Response(archive(relations(rows)))).acquire(
      signal(),
    );
    const first = await lease.search(
      { contaminant: 'pfas', detectedOnly: true, pwsids: new Set(['WA1234567']) },
      0,
      1,
      signal(),
    );
    expect(first).toMatchObject({
      items: [{ sample_id: 'zero', analytical_result_value: 0, censored: false }],
      nextOffset: 3,
      exhausted: false,
    });
    expect(
      await lease.search(
        { dateFrom: '2025-01-01', dateTo: '2025-01-01', contaminant: 'pfoa' },
        first.nextOffset,
        1,
        signal(),
      ),
    ).toMatchObject({
      items: [{ sample_id: 'later', analytical_result_value: 0.002 }],
      nextOffset: 4,
      exhausted: true,
    });
    expect(await lease.search({}, 4, 10, signal())).toEqual({
      items: [],
      nextOffset: 4,
      exhausted: true,
    });
    expect(await lease.search({ pwsids: new Set() }, 0, 10, signal())).toEqual({
      items: [],
      nextOffset: 4,
      exhausted: true,
    });
    await expect(lease.search({}, 5, 1, signal())).rejects.toThrow('bounds');
    expect(lease.contaminants()).toEqual(['PFOA', 'Lithium']);
    lease.release();
  });

  it.each(['2/30/2024', '2/29/2023', '2024-02-29'])(
    'rejects invalid source calendar date %s',
    async (CollectionDate) => {
      const instance = service(
        async () => new Response(archive(relations([occurrence({ CollectionDate })]))),
      );
      await expect(instance.acquire(signal())).rejects.toMatchObject({
        data: { reason: 'dataset_changed' },
      });
    },
  );
  it.each(['NaN', 'Infinity', '1e999', '0x10', ' '])(
    'rejects nondecimal/nonfinite measurement %s',
    async (AnalyticalResultValue) => {
      await expect(
        service(
          async () => new Response(archive(relations([occurrence({ AnalyticalResultValue })]))),
        ).acquire(signal()),
      ).rejects.toMatchObject({ data: { reason: 'dataset_changed' } });
    },
  );

  it('creates private scratch and removes it after successful parsing', async () => {
    const downloaded = await downloadArchive(async () => new Response(archive()), signal());
    try {
      expect((await stat(downloaded.path)).mode & 0o777).toBe(0o600);
      expect((await parseArchive(downloaded.path, signal())).measurements()).toMatchObject({
        occurrenceRows: 1,
        additionalRows: 6,
        zipMembershipRows: 3,
      });
    } finally {
      await downloaded.cleanup();
    }
    await expect(access(downloaded.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['missing', 'unknown', 'duplicate', 'header', 'crc', 'expanded'] as const)(
    'fails closed on %s archive contract',
    async (kind) => {
      let entries = relations();
      if (kind === 'missing') entries = entries.slice(0, 2);
      if (kind === 'unknown') entries.push(['../unexpected.txt', Buffer.from('hostile')]);
      if (kind === 'duplicate') entries.push(entries[0]!);
      if (kind === 'header') entries[0] = ['UCMR5_All.txt', Buffer.from('wrong\theader\n')];
      const bytes = archive(entries);
      const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      if (kind === 'crc') bytes.writeUInt32LE(0, directory + 16);
      if (kind === 'expanded') bytes.writeUInt32LE(401 * 1024 * 1024, directory + 24);
      await expect(
        service(async () => new Response(bytes)).acquire(signal()),
      ).rejects.toMatchObject({ data: { reason: 'dataset_changed' } });
    },
  );

  it('refuses compressed size and foreign redirects before another fetch', async () => {
    const oversized = vi.fn<typeof fetch>(
      async () => new Response('x', { headers: { 'content-length': String(33 * 1024 * 1024) } }),
    );
    await expect(downloadArchive(oversized, signal())).rejects.toMatchObject({
      data: { reason: 'dataset_changed' },
    });
    const redirect = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/archive.zip' },
        }),
    );
    await expect(archiveRequest(redirect, 'GET', signal())).rejects.toMatchObject({
      data: { reason: 'dataset_changed' },
    });
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});
