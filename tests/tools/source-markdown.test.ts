/** @fileoverview CommonMark round-trip coverage at source HTTP and real SQL boundaries. */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSource, wireBytes } from '@/domain/source-output.js';
import { getEnforcementActionsTool } from '@/mcp-server/tools/definitions/get-enforcement-actions.tool.js';
import { fixture, output } from '../services/dataframe/canvas-fixtures.js';
import { expectParity, network, paced, renderedText } from '../services/sdwis/sdwis-fixtures.js';

const markup =
  '![external](https://example.invalid/pixel) **text** <img src=https://example.invalid/html> &copy; `code` \\* 💧\nnext';
const md = new MarkdownIt('commonmark');
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('literal source Markdown', () => {
  it('preserves enforcement comments through the real handler and fake EPA HTTP', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const http = network([
      {
        path: /^\/dmapservice\/sdwis\.enforcement_action\//,
        rows: [{ pwsid: 'WA1234567', enforcement_id: 'E1', enforcement_comment_text: markup }],
      },
    ]);
    const response = await paced(
      runToolContract(getEnforcementActionsTool, { pwsid: 'WA1234567' }),
    );
    http.verify();
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      items: [{ enforcement_comment_text: markup }],
    });
    expectParity(response);
    expect(
      renderedText(
        response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
      ),
    ).toContain(
      '"items"[0]."enforcement_comment_text" = "![external](https://example.invalid/pixel) **text** <img src=https://example.invalid/html> &copy; `code` \\\\* 💧\\nnext"',
    );
  });

  it('preserves nested keys, empty containers and JSON text while linking only whole web URL values', () => {
    const result = {
      '![key](https://example.invalid/key) **alias** <b>x</b> &amp; \\ `💧`\n': [
        { nested: { text: markup, empty: [], object: {}, null: null, boolean: false, number: 0 } },
      ],
      url: 'https://www.epa.gov/a?x=1&copy;=2',
      http: 'http://example.invalid/a(b)',
      unsafe: 'javascript:alert(1)',
      text: '{"a":"\\n💧"}',
    };
    const content = formatSource(result);
    expectParity({ structuredContent: result, content });
    const text = content[0]?.text ?? '';
    const tokens = md.parse(text, {}).flatMap((t) => t.children ?? []);
    expect(tokens.filter((t) => t.type === 'link_open').map((t) => t.attrGet('href'))).toEqual([
      'https://www.epa.gov/a?x=1&copy;=2',
      'http://example.invalid/a(b)',
    ]);
    expect(renderedText(text)).toContain('"text" = "{\\"a\\":\\"\\\\n💧\\"}"');
  });

  it('reconstructs oversized markup from rendered JSON chunks within the complete wire budget', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const row = {
      pwsid: 'WA1234567',
      enforcement_id: 'large',
      enforcement_comment_text: `${markup}${'\\'.repeat(2500)}`,
    };
    const next = { pwsid: 'WA1234567', enforcement_id: 'next', enforcement_comment_text: 'last' };
    const http = network([
      { path: /^\/dmapservice\/sdwis\.enforcement_action\//, rows: [row, next] },
    ]);
    const first = await paced(runToolContract(getEnforcementActionsTool, { pwsid: 'WA1234567' }));
    expect(first.isError).toBe(true);
    const failure = first.structuredContent as {
      error: { data: { reason: string; record_cursor: string } };
    };
    expect(failure.error.data.reason).toBe('item_too_large');
    let cursor = failure.error.data.record_cursor;
    let serialized = '';
    let completed = false;
    for (let i = 0; i < 30; i++) {
      const response = await paced(
        runToolContract(getEnforcementActionsTool, {
          pwsid: 'WA1234567',
          view: 'text',
          record_cursor: cursor,
        }),
      );
      expect(response.isError).not.toBe(true);
      expectParity(response);
      expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThan(24000);
      const value = response.structuredContent as Record<string, unknown>;
      expect(value.offset).toBe(Array.from(serialized).length);
      const visible = renderedText(
        response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
      );
      const line = visible.split('\n').find((entry) => entry.startsWith('"text" = '));
      expect(line).toBeDefined();
      serialized += JSON.parse(line?.slice('"text" = '.length) ?? 'null');
      cursor = String(value.next_cursor);
      if (JSON.stringify(value.notices).includes('Record text complete.')) {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    expect(JSON.parse(serialized)).toEqual({ ...row, enforcement_action_type_label: null });
    const last = await paced(
      runToolContract(getEnforcementActionsTool, { pwsid: 'WA1234567', cursor }),
    );
    expectParity(last);
    expect(last.structuredContent).toMatchObject({ items: [next], has_more: false });
    http.verify();
  });

  it('preserves real SQL aliases as literal field paths', async () => {
    const f = fixture();
    try {
      const h = await f.service.stageRelations(
        {},
        output(),
        [
          {
            relation: 'seed',
            rows: [{ n: 1 }],
            schema: [{ name: 'n', type: 'INTEGER', nullable: false }],
          },
        ],
        f.ctx,
      );
      const alias = '![alias](https://example.invalid/image) **bold** <i>x</i> &copy; `x`';
      const result = await f.service.query(
        { canvas_id: h.canvas_id, sql: `SELECT 7 AS "${alias}"`, view: 'records', limit: 10 },
        f.ctx,
      );
      expect(result.items).toEqual([{ [alias]: 7 }]);
      expectParity({ structuredContent: result, content: formatSource(result) });
      expect(wireBytes(result)).toBeLessThan(24000);
    } finally {
      await f.canvas.shutdown(f.ctx);
    }
  });
});
