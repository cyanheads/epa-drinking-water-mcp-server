/** @fileoverview Stable classification of failures at the fixed EPA endpoints. */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';

/** Discard a response whose HTTP metadata is authoritative even if the stream has failed. */
export async function discardEpaBody(response: Response, signal: AbortSignal): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed discard does not change the HTTP response already received.
  }
  signal.throwIfAborted();
}

/** Classify an unsuccessful response without reading its body. */
export function epaHttpError(response: Response, source: 'DMAP' | 'UCMR'): Promise<McpError> {
  const { status } = response;
  const { code, reason } =
    status === 403
      ? { code: JsonRpcErrorCode.Forbidden, reason: 'upstream_forbidden' }
      : status === 408
        ? { code: JsonRpcErrorCode.Timeout, reason: 'upstream_timeout' }
        : status === 429
          ? { code: JsonRpcErrorCode.RateLimited, reason: 'upstream_rate_limited' }
          : {
              code: JsonRpcErrorCode.ServiceUnavailable,
              reason: status >= 500 ? 'upstream_unavailable' : 'upstream_contract_changed',
            };
  const retryable = [408, 429, 500, 502, 503, 504].includes(status);
  if (source === 'DMAP')
    return Promise.resolve(
      new McpError(code, `EPA DMAP request failed with HTTP ${status}.`, {
        status,
        retryable,
        reason,
      }),
    );
  return httpErrorFromResponse(response, {
    service: 'EPA UCMR',
    captureBody: false,
    codeOverride: () => code,
    data: { retryable, reason },
  });
}
