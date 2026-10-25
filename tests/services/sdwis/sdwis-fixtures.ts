/**
 * @fileoverview Strict DMAP network fixtures with assertion failures retained outside retries.
 * @module tests/services/sdwis/sdwis-fixtures
 */
import MarkdownIt from 'markdown-it';
import { expect, vi } from 'vitest';

const commonmark = new MarkdownIt('commonmark');

/** Read visible CommonMark text independently of the production Markdown encoder. */
export function renderedText(text: string): string {
  return commonmark
    .parse(text, {})
    .flatMap((block) => {
      expect(['paragraph_open', 'inline', 'paragraph_close']).toContain(block.type);
      return (block.children ?? []).map((token) => {
        expect(['text', 'softbreak', 'hardbreak', 'link_open', 'link_close']).toContain(token.type);
        return token.type === 'softbreak' || token.type === 'hardbreak'
          ? '\n'
          : token.type === 'text'
            ? token.content
            : '';
      });
    })
    .join('');
}

/** One expected request, including its full production URL path. */
export interface Exchange {
  path: string | RegExp;
  response?: () => Response | Promise<Response>;
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
    return expected.response ? expected.response() : Response.json(expected.rows ?? []);
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
  const lines = result.content.flatMap((block) => {
    if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string')
      return renderedText(block.text).split('\n');
    return [];
  });
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      if (!value.length) expect(lines).toContain(`${path} = []`);
      for (const [index, child] of value.entries()) visit(child, `${path}[${index}]`);
    } else if (value !== null && typeof value === 'object') {
      if (!Object.keys(value).length) expect(lines).toContain(`${path} = {}`);
      for (const [key, child] of Object.entries(value))
        visit(child, path ? `${path}.${JSON.stringify(key)}` : JSON.stringify(key));
    } else if (value !== undefined) expect(lines).toContain(`${path} = ${JSON.stringify(value)}`);
  };
  visit(result.structuredContent, '');
}
