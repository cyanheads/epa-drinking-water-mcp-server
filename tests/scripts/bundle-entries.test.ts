/** @fileoverview Preserve dependency runtime skills while pruning package-root agent docs. */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

const agentDocs = [
  'node_modules/example/skills/review/SKILL.md',
  'node_modules/@scope/example/framework-skills/review/reference.md',
  'node_modules/example/.claude/settings.json',
  'node_modules/example/.agents/config.json',
  'node_modules/example/node_modules/child/skills/review/reference.md',
  'node_modules/@scope/example/node_modules/@nested/child/skills/review/data.json',
  'node_modules/example/documentation/SKILL.md',
];
const runtimeEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/example/dist/skills/runtime.js',
  'node_modules/example/lib/deeper/skills/runtime.js',
  'node_modules/example/node_modules/@scope/child/dist/ext/skills/runtime.js',
  'skills/published/SKILL.md',
  'dist/index.js',
];

describe('bundle agent-document classification', () => {
  it('removes package-root agent docs from scoped, unscoped and nested dependencies', () => {
    expect(filterAgentDocEntries(agentDocs)).toEqual(agentDocs);
  });

  it('preserves SDK extensions and deeper runtime directories named skills', () => {
    expect(filterAgentDocEntries(runtimeEntries)).toEqual([]);
  });

  it('applies the same boundaries in the standalone packaging linter', () => {
    // The linter also has a framework-repository-only source import; run its public script boundary.
    const result = execFileSync(
      'bun',
      [
        '-e',
        'const linter = await import(process.argv[1]); const groups = JSON.parse(process.argv[2]); console.log(JSON.stringify(groups.map(entries => entries.filter(entry => linter.AGENT_DOC_ENTRY.test(entry)))));',
        new URL('../../scripts/lint-packaging.ts', import.meta.url).href,
        JSON.stringify([agentDocs, runtimeEntries]),
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    const classifications: unknown = JSON.parse(result);
    expect(classifications).toEqual([agentDocs, []]);
  });
});
