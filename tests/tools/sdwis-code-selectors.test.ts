/** @fileoverview Exact SDWIS code selectors through the EPA fetch boundary and MCP output. */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixture } from '../services/dataframe/canvas-fixtures.js';
import { expectParity, network, paced } from '../services/sdwis/sdwis-fixtures.js';

let violations: typeof import('@/mcp-server/tools/definitions/get-violations.tool.js').getViolationsTool;
let enforcement: typeof import('@/mcp-server/tools/definitions/get-enforcement-actions.tool.js').getEnforcementActionsTool;
let http: ReturnType<typeof network>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  ({ getViolationsTool: violations } = await import(
    '@/mcp-server/tools/definitions/get-violations.tool.js'
  ));
  ({ getEnforcementActionsTool: enforcement } = await import(
    '@/mcp-server/tools/definitions/get-enforcement-actions.tool.js'
  ));
  http = network([]);
});

afterEach(() => {
  http.verify();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const scope = { pwsid: 'WA1234567' };
const dictionary = (type: string, rows: readonly (readonly [string, string | null])[]) => ({
  path: new RegExp(`/sdwis\\.ref_code_value/value_type/equals/${type}/sort/`),
  rows: rows.map(([value_code, value_description]) => ({
    value_type: type,
    value_code,
    value_description,
  })),
});

function response(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  expectParity(result);
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

it('passes a lowercase exact category through as its upstream code', async () => {
  http = network([
    {
      path: /sdwis\.violation\/pwsid\/in\/WA1234567\/and\/violation_category_code\/equals\/MR\//,
      rows: [{ ...scope, violation_id: 'V1', violation_category_code: 'MR' }],
    },
    dictionary('VIOLATION_CATEGORY_CODE', [['MR', 'Monitoring and Reporting']]),
  ]);

  expect(
    response(await paced(runToolContract(violations, { ...scope, category: 'mr' }))),
  ).toMatchObject({
    effective_filters: { category: 'MR' },
    items: [
      { violation_category_code: 'MR', violation_category_label: 'Monitoring and Reporting' },
    ],
  });
});

it('labels compliance status and rules without losing unknown raw codes', async () => {
  http = network([
    {
      path: /sdwis\.violation\//,
      rows: [
        { ...scope, violation_id: 'V1', compliance_status_code: 'R', rule_code: '310' },
        { ...scope, violation_id: 'V2', compliance_status_code: 'X', rule_code: '999' },
      ],
    },
    dictionary('COMPLIANCE_STATUS_CODE', [['R', 'Returned to Compliance']]),
    dictionary('RULE_CODE', [
      ['310', 'VOC'],
      ['999', null],
    ]),
  ]);

  expect(response(await paced(runToolContract(violations, scope)))).toMatchObject({
    items: [
      {
        compliance_status_code: 'R',
        compliance_status_label: 'Returned to Compliance',
        rule_code: '310',
        rule_label: 'VOC',
      },
      {
        compliance_status_code: 'X',
        compliance_status_label: null,
        rule_code: '999',
        rule_label: null,
      },
    ],
  });
});

it('preserves the verbatim enforcement originator description', async () => {
  http = network([
    {
      path: /sdwis\.enforcement_action\/.+\/originator_code\/equals\/H\//,
      rows: [{ ...scope, enforcement_id: 'E1', originator_code: 'H' }],
    },
    dictionary('ORIGINATOR_CODE', [['H', 'Headquater']]),
  ]);

  expect(
    response(await paced(runToolContract(enforcement, { ...scope, originator: 'h' }))),
  ).toMatchObject({
    effective_filters: { originator: 'H' },
    items: [{ originator_code: 'H', originator_label: 'Headquater' }],
  });
});

it('checks every supplied selector after a confirmed empty violation selection', async () => {
  http = network([
    { path: /sdwis\.violation\/.+\/compliance_status_code\/equals\/OPEN\// },
    dictionary('CONTAMINANT_CODE', [['1030', 'Lead']]),
    dictionary('VIOLATION_CATEGORY_CODE', [['MR', 'Monitoring and Reporting']]),
    dictionary('COMPLIANCE_STATUS_CODE', [['R', 'Returned to Compliance']]),
  ]);

  expect(
    response(
      await paced(
        runToolContract(violations, {
          ...scope,
          category: 'monitoring',
          compliance_status: 'open',
          contaminant: 'pfoa',
        }),
      ),
    ),
  ).toMatchObject({
    items: [],
    has_more: false,
    source_complete: true,
    notices: expect.arrayContaining([
      expect.stringMatching(/category.*MONITORING.*VIOLATION_CATEGORY_CODE/),
      expect.stringMatching(/compliance_status.*OPEN.*COMPLIANCE_STATUS_CODE/),
      expect.stringMatching(/contaminant.*PFOA.*CONTAMINANT_CODE/),
      expect.stringMatching(/PFOA.*sdwis_search_contaminants.*dataset.*ucmr5/),
    ]),
  });
});

it('reuses the complete dictionary and leaves a valid empty code with generic guidance', async () => {
  const empty = { path: /sdwis\.enforcement_action\/.+\/originator_code\/equals\/F\// };
  http = network([empty, dictionary('ORIGINATOR_CODE', [['f', null]]), empty]);

  for (const originator of ['f', 'F']) {
    expect(
      response(await paced(runToolContract(enforcement, { ...scope, originator }))),
    ).toMatchObject({
      items: [],
      source_complete: true,
      notices: [
        expect.stringContaining('quarterly publication'),
        expect.stringContaining('No matching records'),
      ],
    });
  }
});

it('keeps a confirmed empty selection successful when a later dictionary page fails', async () => {
  const first = dictionary(
    'VIOLATION_CATEGORY_CODE',
    Array.from({ length: 1000 }, (_, index) => [String(index), null] as const),
  );
  http = network([
    { path: /sdwis\.violation\// },
    { ...first, path: /VIOLATION_CATEGORY_CODE\/.+\/1:1000\/json$/ },
    {
      path: /VIOLATION_CATEGORY_CODE\/.+\/1001:2000\/json$/,
      response: () => new Response(null, { status: 403 }),
    },
  ]);

  expect(
    response(await paced(runToolContract(violations, { ...scope, category: 'monitoring' }))),
  ).toMatchObject({
    items: [],
    source_complete: true,
    notices: [
      expect.stringContaining('quarterly publication'),
      'Could not complete the EPA VIOLATION_CATEGORY_CODE dictionary lookup for category.',
      expect.stringContaining('No matching records'),
    ],
  });
  expect(http.calls).toHaveLength(3);
  const retry = { path: /sdwis\.violation\// };
  http.verify();
  http = network([retry, dictionary('VIOLATION_CATEGORY_CODE', [['OTHER', null]])]);
  expect(
    response(await paced(runToolContract(violations, { ...scope, category: 'monitoring' }))),
  ).toMatchObject({
    notices: expect.arrayContaining([
      expect.stringMatching(/category.*MONITORING.*VIOLATION_CATEGORY_CODE/),
    ]),
  });
});

it('propagates caller cancellation during optional dictionary acquisition', async () => {
  const abort = new AbortController();
  http = network([
    { path: /sdwis\.violation\// },
    {
      path: /VIOLATION_CATEGORY_CODE\//,
      response: (signal) => {
        abort.abort();
        expect(signal.aborted).toBe(true);
        signal.throwIfAborted();
        throw new Error('Expected the dictionary read to be cancelled.');
      },
    },
  ]);
  const result = await paced(
    runToolContract(
      violations,
      { ...scope, category: 'monitoring' },
      { context: { signal: abort.signal } },
    ),
  );
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code: JsonRpcErrorCode.RequestCancelled } },
  });
  expect(JSON.stringify(result.content)).toMatch(/abort|cancel/i);
});

it('does not diagnose an empty terminal continuation after delivering matching rows', async () => {
  const { setStageProducer } = await import('@/services/sdwis/drinking-water-service.js');
  const f = fixture();
  setStageProducer((partition, ctx) => f.service.stage(partition, ctx));
  http = network([
    {
      path: /sdwis\.violation\/.+\/1:1000\/json$/,
      rows: Array.from({ length: 1000 }, (_, i) => ({
        ...scope,
        violation_id: `v${String(i).padStart(4, '0')}`,
        violation_category_code: 'NEW',
        compl_per_begin_date: i === 0 ? '2025-01-01' : '2024-01-01',
        compl_per_end_date: i === 0 ? '2025-01-01' : '2024-01-01',
      })),
    },
    dictionary('VIOLATION_CATEGORY_CODE', [['MR', 'Monitoring and Reporting']]),
    { path: /sdwis\.violation\/.+\/1001:2000\/json$/ },
  ]);
  try {
    const input = {
      ...scope,
      category: 'new',
      date_from: '2025-01-01',
      stage: true,
      stage_max_rows: 1,
    };
    const first = response(await paced(runToolContract(violations, input)));
    expect(first).toMatchObject({
      items: [{ violation_id: 'v0000', violation_category_label: null }],
      source_complete: false,
      has_more: true,
      next_cursor: expect.any(String),
      notices: [
        expect.stringContaining('quarterly publication'),
        expect.stringContaining('incomplete'),
      ],
    });
    const last = response(
      await paced(
        runToolContract(violations, {
          ...input,
          cursor: z.string().parse(first.next_cursor),
        }),
      ),
    );
    expect(last).toMatchObject({
      items: [],
      source_complete: false,
      has_more: false,
      notices: [
        expect.stringContaining('quarterly publication'),
        expect.stringContaining('No matching records'),
        expect.stringContaining('earlier rows were delivered'),
      ],
    });
  } finally {
    await f.canvas.shutdown(f.ctx);
  }
});

it('defers diagnostics until an initially empty checkpoint is exhausted', async () => {
  const pages = Array.from({ length: 17 }, (_, page) => ({
    path: new RegExp(`/sdwis\\.violation/.+/${page * 1000 + 1}:${(page + 1) * 1000}/json$`),
    rows: Array.from({ length: 1000 }, (_, row) => ({
      ...scope,
      violation_id: `v${String(page * 1000 + row).padStart(5, '0')}`,
    })),
  }));
  http = network([
    ...pages,
    { path: /sdwis\.violation\/.+\/17001:18000\/json$/ },
    dictionary('VIOLATION_CATEGORY_CODE', [['MR', 'Monitoring and Reporting']]),
  ]);
  const input = { ...scope, category: '+++' };
  const first = response(await paced(runToolContract(violations, input)));
  expect(first).toMatchObject({
    items: [],
    has_more: true,
    source_complete: false,
  });
  expect(http.calls).toHaveLength(17);
  const last = response(
    await paced(
      runToolContract(violations, { ...input, cursor: z.string().parse(first.next_cursor) }),
    ),
  );
  expect(last).toMatchObject({
    items: [],
    has_more: false,
    source_complete: true,
    notices: expect.arrayContaining([expect.stringContaining('is absent from EPA')]),
  });
});

it('stages the new label columns in an empty first table and in rows with labels', async () => {
  const f = fixture();
  const { setStageProducer } = await import('@/services/sdwis/drinking-water-service.js');
  const canvasService = await import('@/services/dataframe/canvas-service.js');
  const { dataframeQueryTool } = await import(
    '@/mcp-server/tools/definitions/dataframe-query.tool.js'
  );
  canvasService.initCanvasService(f.canvas, 25000);
  setStageProducer((partition, ctx) => canvasService.getCanvasService().stage(partition, ctx));
  http = network([
    { path: /sdwis\.violation\// },
    {
      path: /VIOLATION_CATEGORY_CODE\//,
      response: () => new Response(null, { status: 403 }),
    },
    {
      path: /sdwis\.violation\//,
      rows: [{ ...scope, violation_id: 'V1', compliance_status_code: 'R', rule_code: '310' }],
    },
    dictionary('COMPLIANCE_STATUS_CODE', [['R', 'Returned to Compliance']]),
    dictionary('RULE_CODE', [['310', 'VOC']]),
    {
      path: /sdwis\.enforcement_action\//,
      rows: [{ ...scope, enforcement_id: 'E1', originator_code: 'H' }],
    },
    dictionary('ORIGINATOR_CODE', [['H', 'Headquater']]),
  ]);
  try {
    const input = { ...scope, stage: true };
    const dataset = z.object({ canvas_id: z.string(), table_name: z.string() });
    const first = response(
      await paced(runToolContract(violations, { ...input, category: 'monitoring' })),
    );
    expect(first).toMatchObject({
      items: [],
      dataset: { row_count: 0 },
      notices: expect.arrayContaining([
        'Could not complete the EPA VIOLATION_CATEGORY_CODE dictionary lookup for category.',
      ]),
    });
    const empty = dataset.parse(first.dataset);
    const next = { ...input, canvas_id: empty.canvas_id };
    const full = dataset.parse(response(await paced(runToolContract(violations, next))).dataset);
    const actions = dataset.parse(
      response(await paced(runToolContract(enforcement, next))).dataset,
    );
    const labels = 'compliance_status_label, rule_label';
    const queries = [
      [
        `SELECT ${labels} FROM ${empty.table_name} UNION ALL SELECT ${labels} FROM ${full.table_name}`,
        [{ compliance_status_label: 'Returned to Compliance', rule_label: 'VOC' }],
      ],
      [`SELECT originator_label FROM ${actions.table_name}`, [{ originator_label: 'Headquater' }]],
    ] as const;
    for (const [sql, items] of queries) {
      expect(
        response(
          await paced(runToolContract(dataframeQueryTool, { canvas_id: empty.canvas_id, sql })),
        ),
      ).toMatchObject({ items });
    }
  } finally {
    await f.canvas.shutdown(f.ctx);
  }
});
