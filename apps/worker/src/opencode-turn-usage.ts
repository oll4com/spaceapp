import type { CodexTokenTotals } from "@space/codex-app-server";

/**
 * Tokens OpenCode reported for one assistant message (`POST /session/:id/message`
 * returns its `info`). OpenCode counts uncached input, cache reads, cache writes,
 * output and reasoning separately; the run ledger uses the Codex meaning, where
 * cached input is part of input and reasoning is part of output. Only an
 * assistant message with valid counters and a non-zero total counts as measured.
 */
export interface OpenCodeTurnUsage {
  totals: CodexTokenTotals;
  /** `providerID/modelID` as OpenCode reported it, or null. */
  model: string | null;
}

export const openCodeTurnUsageSource = "opencode:session/message";

const modelPart = /^[A-Za-z0-9._:@+-][A-Za-z0-9._:@+/-]{0,99}$/;

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function openCodeTurnUsage(info: unknown): OpenCodeTurnUsage | null {
  const message = record(info);
  if (!message || message.role !== "assistant") return null;
  const tokens = record(message.tokens);
  if (!tokens) return null;
  const cache = record(tokens.cache);
  const input = counter(tokens.input);
  const output = counter(tokens.output);
  const reasoning = counter(tokens.reasoning ?? 0);
  const cacheRead = counter(cache?.read ?? 0);
  const cacheWrite = counter(cache?.write ?? 0);
  if (input === null || output === null || reasoning === null || cacheRead === null || cacheWrite === null) return null;
  const inputTokens = input + cacheRead + cacheWrite;
  const outputTokens = output + reasoning;
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens <= 0) return null;
  const providerId = typeof message.providerID === "string" && modelPart.test(message.providerID) ? message.providerID : null;
  const modelId = typeof message.modelID === "string" && modelPart.test(message.modelID) ? message.modelID : null;
  return {
    totals: { inputTokens, cachedInputTokens: cacheRead, outputTokens, reasoningOutputTokens: reasoning, totalTokens },
    model: providerId && modelId ? `${providerId}/${modelId}` : null
  };
}
