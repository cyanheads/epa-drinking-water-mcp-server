/** @fileoverview Real native canvas fixtures with synthetic public source partitions. */
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import type { SourceOutput } from '@/domain/source-output.js';
import { CanvasService } from '@/services/dataframe/canvas-service.js';

/** Build a real engine with no background sweeper or persistent user storage. */
export function fixture() {
  const provider = new DuckdbProvider({
    memoryLimitMb: 512,
    exportRootPath: '/tmp/epa-drinking-water-test-canvas',
    defaultRowLimit: 25000,
    schemaSniffRows: 100,
  });
  const canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, {
      ttlMs: 3600000,
      absoluteCapMs: 7200000,
      maxCanvasesPerTenant: 100,
      sweeperIntervalMs: 0,
    }),
  );
  return { canvas, service: new CanvasService(canvas), ctx: createMockContext() };
}
/** Source lineage intentionally remains partial after any SQL aggregation. */
export function output(complete = false): SourceOutput {
  return {
    effective_filters: { state: 'WA' },
    items: [],
    returned: 0,
    limit: 10,
    has_more: !complete,
    phase: 'source',
    source_complete: complete,
    notices: [],
    provenance: {
      source: 'Synthetic EPA fixture',
      url: 'https://www.epa.gov/',
      retrieved_at: '2026-10-25T00:00:00Z',
      consistency: 'Fixture snapshot',
      caveats: ['Not household tap samples.'],
    },
    ...(!complete ? { next_cursor: 'source-next' } : {}),
  };
}
