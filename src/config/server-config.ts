/**
 * @fileoverview Eagerly validated server-specific runtime configuration.
 * @module config/server-config
 */
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const schema = z.object({ dataframeDropEnabled: z.stringbool().default(false) });
let config: z.infer<typeof schema> | undefined;
/** Parse during setup, before transport startup. */
export function getServerConfig(): z.infer<typeof schema> {
  config ??= parseEnvConfig(schema, { dataframeDropEnabled: 'SDWIS_DATAFRAME_DROP_ENABLED' });
  return config;
}
