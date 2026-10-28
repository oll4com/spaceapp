import type { GatewayAccountRecord } from "@space/db";
import { CLAUDE_API_BASE_URL } from "./headers.js";

/**
 * A Claude API key as a gateway account (operator request 2026-10-13). It bills per token, so routing never picks
 * it beside the subscription accounts: with the `claudeApiKeyFallback` setting on, it serves only while every
 * pooled Claude account is out of quota, and the accounts take over again at their next reset.
 */
export const CLAUDE_API_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
export const CLAUDE_API_KEY_PLAN = "api";

export const isClaudeApiKeyAccount = (account: Pick<GatewayAccountRecord, "provider" | "source">): boolean =>
  account.provider === "CLAUDE" && account.source === "API_KEY";

/**
 * Operator rule 2026-10-27: the API key's credits serve only clients outside Claude Code (OpenCode, Oh My Pi, Hermes, Droid,
 * Qoder, T3 Code, ...); Claude Code (Nous, its helpers, panes, pane board) runs on the Max subscriptions alone. Read from the
 * user agent, not `x-client` or the session header: Oh My Pi sends Claude Code's session header too.
 */
export const isClaudeCodeRequest = (headers: Record<string, string | string[] | undefined>): boolean =>
  /claude-code\/|claude-cli\/|claude-vscode\//i.test(String(headers["user-agent"] ?? ""));

/** Whether a key works: the model list costs nothing and answers 401 to a bad key. */
export async function checkClaudeApiKey(apiKey: string, fetchImpl: typeof fetch = fetch, baseUrl = CLAUDE_API_BASE_URL): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/models?limit=1`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15_000)
    });
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Anthropic's answer when the organization's prepaid credits are used up: a 400 that names the credit balance. */
export const claudeCreditsExhausted = (status: number, message: string): boolean => status === 400 && /credit balance/i.test(message);
