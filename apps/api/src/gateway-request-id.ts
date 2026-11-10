/**
 * The header that makes Space Gateway's request log row carry a Space id (a request id, a Council run id): the gateway
 * keeps a caller's x-request-id as its log id only when it is 1-120 visible ASCII characters, else it makes its own
 * (packages/gateway/src/proxy-util.ts clientRequestId, OBS-006). Anything else sends no header. The worker socket's
 * callers (nous/mcp.ts postToWorker, chess/chess-cli.ts) send it the same way.
 */
export function gatewayRequestIdHeader(traceId: string | null | undefined): Record<string, string> {
  return traceId && /^[\x21-\x7e]{1,120}$/.test(traceId) ? { "x-request-id": traceId } : {};
}
