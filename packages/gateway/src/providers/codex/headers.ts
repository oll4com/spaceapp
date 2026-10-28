/**
 * Upstream headers for ChatGPT Codex requests, after codex-lb `_build_upstream_headers` (MIT, Soju06/codex-lb).
 * The client's own identity headers (user-agent, originator, version, session ids, turn state) are forwarded
 * unchanged. Unlike codex-lb, Space Gateway never rewrites a client into a different client's fingerprint.
 */
const ignoredInbound = new Set([
  "authorization", "chatgpt-account-id", "content-length", "host", "forwarded", "x-real-ip", "true-client-ip",
  "x-codex-installation-id", "x-codex-routing-hint", "x-codex-lb-required-capability", "x-openai-internal-codex-responses-lite",
  "x-api-key", "cookie", "x-space-project", "x-headroom-project"
]);
const hopByHop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
  "accept-encoding"
]);

export function shouldDropInboundHeader(name: string): boolean {
  const lowered = name.toLowerCase();
  return ignoredInbound.has(lowered) || hopByHop.has(lowered) || lowered.startsWith("x-forwarded-") || lowered.startsWith("cf-")
    || lowered.startsWith("x-space-gateway-") || lowered.startsWith("sec-websocket-");
}

export function buildCodexUpstreamHeaders(inbound: Record<string, string | string[] | undefined>, accessToken: string, accountId: string | null,
  accept = "text/event-stream"): Record<string, string> {
  const connectionScoped = new Set(
    String(inbound.connection ?? "").split(",").map((token) => token.trim().toLowerCase()).filter(Boolean)
  );
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(inbound)) {
    if (raw === undefined) continue;
    const lowered = key.toLowerCase();
    if (shouldDropInboundHeader(lowered) || connectionScoped.has(lowered) || lowered === "accept" || lowered === "content-type") continue;
    headers[lowered] = Array.isArray(raw) ? raw.join(", ") : raw;
  }
  headers.authorization = `Bearer ${accessToken}`;
  headers.accept = accept;
  headers["content-type"] = "application/json";
  if (accountId && !accountId.startsWith("email_") && !accountId.startsWith("local_")) headers["chatgpt-account-id"] = accountId;
  return headers;
}
