/**
 * @fileoverview Inline paging limits and server runtime configuration.
 * @module tests/domain/inline-limit.test
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { counterAdd } = vi.hoisted(() => ({ counterAdd: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: vi.fn(() => ({ add: counterAdd })),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('paging configuration', () => {
  it('defaults to clamping and preserves the independent drop flag', async () => {
    vi.stubEnv('SDWIS_CLAMP_LIMITS', '');
    vi.stubEnv('SDWIS_DATAFRAME_DROP_ENABLED', 'true');
    const { getServerConfig } = await import('../../src/config/server-config.js');
    expect(getServerConfig()).toEqual({ clampLimits: true, dataframeDropEnabled: true });
  });

  it('defers invalid configuration until configuration is read', async () => {
    vi.stubEnv('SDWIS_CLAMP_LIMITS', 'typo');
    const { getServerConfig } = await import('../../src/config/server-config.js');
    await import('../../src/domain/inline-limit.js');
    expect(getServerConfig).toThrow('SDWIS_CLAMP_LIMITS');
  });

  it('records exactly one log and counter increment for each clamp', async () => {
    vi.stubEnv('SDWIS_CLAMP_LIMITS', 'true');
    const { createMockContext } = await import('@cyanheads/mcp-ts-core/testing');
    const { inlineLimit, resolveInlineLimit } = await import('../../src/domain/inline-limit.js');
    const ctx = createMockContext();
    const log = vi.spyOn(ctx.log, 'notice');
    expect(resolveInlineLimit(inlineLimit.parse(500), ctx)).toEqual({ limit: 500, notices: [] });
    expect(log).not.toHaveBeenCalled();
    expect(counterAdd).not.toHaveBeenCalled();
    for (const requested of [501, 1000]) {
      const notice = `Requested limit ${requested} exceeds the maximum 500; clamped to 500.`;
      expect(resolveInlineLimit(inlineLimit.parse(requested), ctx)).toEqual({
        limit: 500,
        notices: [notice],
      });
      expect(log).toHaveBeenLastCalledWith(notice, {
        requestedLimit: requested,
        effectiveLimit: 500,
      });
    }
    expect(log).toHaveBeenCalledTimes(2);
    expect(counterAdd.mock.calls).toEqual([[1], [1]]);
  });
  it.each(['true', 'false'])(
    'uses clamp mode %s for validation and advertised cap',
    async (mode) => {
      vi.stubEnv('SDWIS_CLAMP_LIMITS', mode);
      const { z } = await import('@cyanheads/mcp-ts-core');
      const { inlineLimit } = await import('../../src/domain/inline-limit.js');
      expect(inlineLimit.parse(undefined)).toBe(10);
      expect(inlineLimit.parse(500)).toBe(500);
      expect(inlineLimit.safeParse(501).success).toBe(mode === 'true');
      expect(z.toJSONSchema(inlineLimit).maximum).toBe(mode === 'false' ? 500 : undefined);
      for (const value of [0, -1, 1.5, 500.00000000000006, Infinity, NaN, '10'])
        expect(inlineLimit.safeParse(value).success).toBe(false);
    },
  );
  it('preserves the default page size and disabled table removal', async () => {
    vi.stubEnv('SDWIS_DATAFRAME_DROP_ENABLED', 'false');
    const { getServerConfig } = await import('../../src/config/server-config.js');
    const { pagingFields } = await import('../../src/domain/source-inputs.js');
    expect(getServerConfig().dataframeDropEnabled).toBe(false);
    expect(pagingFields.limit.parse(undefined)).toBe(10);
  });
});
