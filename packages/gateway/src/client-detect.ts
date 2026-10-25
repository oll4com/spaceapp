import type { FastifyRequest } from "fastify";

/**
 * Which program sent a request, after Headroom 0.37's client detection (Apache-2.0, Headroom Contributors): an
 * explicit `x-client` header wins, otherwise the user agent is matched against known agents. Space's own callers are
 * named too. Only the program name is kept, never the full user agent.
 */
const userAgentClients: [RegExp, string][] = [
  [/claude-code\/|claude-cli\//i, "Claude Code"],
  [/claude-vscode\//i, "Claude Code (VS Code)"],
  [/anthropic-cli\//i, "Anthropic CLI"],
  [/codex_cli_rs|codex-cli\/|codex_exec|codex_vscode|codex-tui/i, "Codex CLI"],
  [/cursor\//i, "Cursor"],
  [/grok\//i, "Grok Build"],
  [/\bzed\//i, "Zed"],
  [/aider\//i, "Aider"],
  [/droid\//i, "Droid"],
  [/opencode\//i, "OpenCode"],
  [/github-copilot\/|copilot-cli/i, "Copilot"],
  [/antigravity\//i, "Antigravity"],
  [/strands-agents\//i, "Strands"],
  [/hermes/i, "Hermes"],
  [/reasonix/i, "Reasonix"],
  [/oh-my-pi|\bomp\//i, "Oh My Pi"],
  [/kilo/i, "Kilo Code"],
  [/space-api|space-worker|space-gateway/i, "Space"],
  [/openai\/[\d.]+|OpenAI\/JS|openai-python/i, "OpenAI SDK"],
  [/anthropic-sdk|Anthropic\/JS|anthropic-python/i, "Anthropic SDK"]
];

const clean = (value: string) => value.replace(/[^\x20-\x7e]/g, "").trim();

export function detectClient(headers: FastifyRequest["headers"]): string | null {
  const explicit = headers["x-client"] ?? headers["x-space-client"];
  const named = Array.isArray(explicit) ? explicit[0] : explicit;
  if (named && clean(named)) return clean(named).slice(0, 80);
  const agent = headers["user-agent"];
  if (!agent) return null;
  for (const [pattern, name] of userAgentClients) if (pattern.test(agent)) return name;
  return "Other";
}

/** The project a request belongs to: `x-space-project`, or Headroom's `x-headroom-project`. */
export function detectProject(headers: FastifyRequest["headers"]): string | null {
  const raw = headers["x-space-project"] ?? headers["x-headroom-project"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* keep the raw value */ }
  const text = clean(decoded);
  return text ? text.slice(0, 128) : null;
}

/** The log fields every provider route adds. */
export function requestOrigin(request: FastifyRequest): { clientName: string | null; project: string | null } {
  return { clientName: detectClient(request.headers), project: detectProject(request.headers) };
}
