import { shouldDropInboundHeader } from "../codex/headers.js";
import { CLAUDE_OAUTH_BETA } from "./oauth.js";

export const CLAUDE_API_BASE_URL = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export type ClaudeUpstreamAuth = "bearer" | "api-key";

/**
 * Upstream headers for Anthropic Messages requests with a subscription token. The client's own headers
 * (user agent, `x-app`, betas, session id) go through unchanged; only the credential is swapped and the OAuth
 * beta that subscription tokens require is added to the client's betas. An API-key account sends its key as
 * `x-api-key` instead, without that beta: Anthropic refuses it on a key.
 */
export function buildClaudeUpstreamHeaders(inbound: Record<string, string | string[] | undefined>, accessToken: string,
  accept = "application/json", auth: ClaudeUpstreamAuth = "bearer", extraBetas: string[] = []): Record<string, string> {
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
  const betas = (headers["anthropic-beta"] ?? "").split(",").map((beta) => beta.trim()).filter(Boolean).filter((beta) => beta !== CLAUDE_OAUTH_BETA);
  if (auth === "bearer") betas.push(CLAUDE_OAUTH_BETA);
  for (const beta of extraBetas) if (!betas.includes(beta)) betas.push(beta);
  if (betas.length > 0) headers["anthropic-beta"] = betas.join(","); else delete headers["anthropic-beta"];
  headers["anthropic-version"] ??= DEFAULT_ANTHROPIC_VERSION;
  if (auth === "bearer") headers.authorization = `Bearer ${accessToken}`; else headers["x-api-key"] = accessToken;
  headers.accept = accept;
  headers["content-type"] = "application/json";
  return headers;
}
