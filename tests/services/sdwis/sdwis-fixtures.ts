/**
 * @fileoverview Strict DMAP network fixtures with assertion failures retained outside retries.
 * @module tests/services/sdwis/sdwis-fixtures
 */
import MarkdownIt from 'markdown-it';
import { expect, vi } from 'vitest';

const commonmark = new MarkdownIt('commonmark');
const blockTypes = new Set(['paragraph_open', 'inline', 'paragraph_close']);
const inlineTypes = new Set(['text', 'softbreak', 'hardbreak', 'link_open', 'link_close']);

/** Read visible CommonMark text independently of the production Markdown encoder. */
export function renderedText(text: string): string {
  const parts: string[] = [];
  for (const block of commonmark.parse(text, {})) {
    if (!blockTypes.has(block.type)) throw new Error(`Unexpected Markdown block: ${block.type}`);
    for (const token of block.children ?? []) {
      if (!inlineTypes.has(token.type))
        throw new Error(`Unexpected inline Markdown: ${token.type}`);
      if (token.type === 'text') parts.push(token.content);
      if (token.type === 'softbreak' || token.type === 'hardbreak') parts.push('\n');
    }
  }
  return parts.join('');
}

/** One expected request, including its full production URL path. */
export interface Exchange {
  path: string | RegExp;
  response?: (signal: AbortSignal) => Response | Promise<Response>;
  rows?: unknown;
}
/** Install a sequential network boundary; unexpected fetches always fail final verification. */
export function network(exchanges: Exchange[]) {
  const pending = [...exchanges];
  const failures: string[] = [];
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    const expected = pending.shift();
    if (
      url.origin !== 'https://data.epa.gov' ||
      init?.redirect !== 'manual' ||
      !init.signal ||
      !expected ||
      !(typeof expected.path === 'string'
        ? url.pathname === expected.path
        : expected.path.test(url.pathname))
    ) {
      failures.push(`Unexpected DMAP request: ${url.href}`);
      return new Response(null, { status: 403 });
    }
    try {
      return expected.response
        ? await expected.response(init.signal)
        : Response.json(expected.rows ?? []);
    } catch (error) {
      if (error instanceof Error && error.name === 'AssertionError') failures.push(error.message);
      throw error;
    }
  });
  return {
    calls,
    verify() {
      expect(failures).toEqual([]);
      expect(pending.map((entry) => String(entry.path))).toEqual([]);
    },
  };
}

/** Advance only the production pacing/backoff timers, never real elapsed time. */
export async function paced<T>(operation: Promise<T>): Promise<T> {
  const outcome = operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}

/** Verify each primitive on the reversible text surface against its structured counterpart. */
export function expectParity(result: { structuredContent?: unknown; content: unknown[] }) {
  const lines = new Set<string>();
  for (const block of result.content)
    if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string')
      for (const line of renderedText(block.text).split('\n')) lines.add(line);
  const requireLine = (line: string) => {
    if (!lines.has(line)) throw new Error(`Missing rendered line: ${line}`);
  };
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      if (!value.length) requireLine(`${path} = []`);
      for (const [index, child] of value.entries()) visit(child, `${path}[${index}]`);
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) requireLine(`${path} = {}`);
      for (const [key, child] of entries)
        visit(child, path ? `${path}.${JSON.stringify(key)}` : JSON.stringify(key));
    } else if (value !== undefined) requireLine(`${path} = ${JSON.stringify(value)}`);
  };
  visit(result.structuredContent, '');
}
