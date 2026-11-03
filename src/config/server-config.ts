/**
 * @fileoverview Eagerly validated server-specific runtime configuration.
 * @module config/server-config
 */
import { z } from '@cyanheads/mcp-ts-core';
import { config as coreConfig, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const schema = z.object({
  dataframeDropEnabled: z.stringbool().default(false),
  clampLimits: z.stringbool().default(true),
});
let config: z.infer<typeof schema> | undefined;
/** Parse during setup, before transport startup. */
export function getServerConfig(): z.infer<typeof schema> {
  // The framework loads Node's .env lazily; parseEnvConfig alone only reads process.env.
  if (!config) {
    void coreConfig.openTelemetry;
    config = parseEnvConfig(schema, {
      dataframeDropEnabled: 'SDWIS_DATAFRAME_DROP_ENABLED',
      clampLimits: 'SDWIS_CLAMP_LIMITS',
    });
  }
  return config;
}
