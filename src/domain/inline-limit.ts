/**
 * @fileoverview Shared inline row-count validation and observable clamping.
 * @module domain/inline-limit
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '../config/server-config.js';

let clampCounter: ReturnType<typeof createCounter> | undefined;

/** Positive exact row count; strict mode advertises and enforces the 500-row cap. */
export const inlineLimit = z
  .number()
  .positive()
  .refine(Number.isInteger, 'Limit must be an integer.')
  .refine((value) => getServerConfig().clampLimits || value <= 500, 'Limit must be at most 500.')
  .default(10)
  .meta({
    multipleOf: 1,
    get maximum() {
      return getServerConfig().clampLimits ? undefined : 500;
    },
  })
  .describe('Inline rows requested; defaults to 10, with an effective maximum of 500.');

/** Resolve a schema-validated count, returning a notice and recording each clamp once. */
export function resolveInlineLimit(
  requested: number,
  ctx: Context,
): { limit: number; notices: string[] } {
  if (requested <= 500) return { limit: requested, notices: [] };
  const notice = `Requested limit ${requested} exceeds the maximum 500; clamped to 500.`;
  ctx.log.notice(notice, { requestedLimit: requested, effectiveLimit: 500 });
  clampCounter ??= createCounter('sdwis.inline_limit.clamps', 'Inline row limits clamped to 500');
  clampCounter.add(1);
  return { limit: 500, notices: [notice] };
}
