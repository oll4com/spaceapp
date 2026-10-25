import { randomUUID } from "node:crypto";
import type { GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord, GatewayRepository, GatewayUsageHistoryPoint } from "@space/db";
import type { AccountPool } from "../accounts/account-pool.js";
import { priceForModel } from "../pricing/pricing.js";
import { buildCodexUpstreamHeaders } from "../providers/codex/headers.js";
import type { CodexModelPlans } from "../providers/codex/model-plans.js";
import { ResponseStreamInspector } from "../providers/codex/stream.js";
import { CODEX_UPSTREAM_BASE_URL } from "../providers/codex/usage.js";
import type { RequestLogWriter } from "../request-log-writer.js";

/**
 * Limit warm-up, after codex-lb's limit warm-up (MIT, Soju06/codex-lb). A Codex usage window starts counting at the
 * first request after it resets; one tiny request right after a confirmed reset starts the next window at once, so it
 * also resets sooner. A window qualifies when an earlier sample showed it used up, a later sample shows enough of it
 * free again, and the later sample carries a newer reset time. Each account, window and reset gets one attempt, and an
 * account waits out the cooldown between attempts. Warm-up requests are logged with source `limit_warmup` and left out
 * of every statistic.
 */
export interface WarmupCandidate { account: GatewayAccountRecord; window: "PRIMARY" | "SECONDARY"; resetAt: string }

const SAME_PERIOD_MS = 5 * 60_000;

/** The newest qualifying window of an account, or null. Weekly-only accounts have no 5h window to warm. */
export function warmupWindow(points: GatewayUsageHistoryPoint[], account: GatewayAccountRecord, settings: Pick<GatewaySettings, "warmupWindows" | "warmupMinAvailablePercent">): WarmupCandidate | null {
  const windows: ("PRIMARY" | "SECONDARY")[] = settings.warmupWindows === "PRIMARY" ? ["PRIMARY"] : settings.warmupWindows === "SECONDARY" ? ["SECONDARY"] : ["PRIMARY", "SECONDARY"];
  for (const window of windows) {
    if (window === "PRIMARY" && (account.primaryWindow.windowMinutes ?? 300) >= 7 * 24 * 60) continue;
    const samples = points.filter((point) => point.window === window && point.quotaKey === "" && point.resetAt);
    const after = samples.at(-1);
    if (!after) continue;
    const afterReset = Date.parse(after.resetAt!);
    // Reset times read from response headers drift by seconds; a new period moves the reset forward by much more.
    const before = [...samples].reverse().find((point) => Date.parse(point.resetAt!) < afterReset - SAME_PERIOD_MS);
    if (!before) continue;
    if (before.usedPercent >= 100 && 100 - after.usedPercent >= settings.warmupMinAvailablePercent) {
      return { account, window, resetAt: new Date(Math.round(afterReset / 60_000) * 60_000).toISOString() };
    }
  }
  return null;
}

/** The cheapest priced text model the account's plan offers, or a fixed default. */
export function warmupModel(setting: string, planModels: string[]): string | null {
  if (setting.trim().toLowerCase() !== "auto") return setting.trim();
  const priced = planModels.map((model) => ({ model, price: priceForModel(model)?.price }))
    .filter((entry): entry is { model: string; price: NonNullable<typeof entry.price> } => Boolean(entry.price))
    .sort((a, b) => (a.price.input_per_1m + a.price.output_per_1m) - (b.price.input_per_1m + b.price.output_per_1m) || a.model.localeCompare(b.model));
  return priced[0]?.model ?? null;
}

export interface WarmupRunnerOptions {
  repository: GatewayRepository;
  pool: AccountPool;
  modelPlans: CodexModelPlans;
  logs: RequestLogWriter;
  settings: () => Promise<GatewaySettings>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export async function runWarmupCycle(options: WarmupRunnerOptions): Promise<number> {
  const settings = await options.settings();
  if (!settings.warmupEnabled) return 0;
  const now = (options.now ?? Date.now)();
  const latest = new Map((await options.repository.latestWarmups()).map((row) => [row.accountId, row]));
  const accounts = (await options.pool.accounts()).filter((account) => account.provider === "CODEX" && account.warmupEnabled && account.status === "ACTIVE");
  let sent = 0;
  for (const account of accounts) {
    const last = latest.get(account.id);
    if (last && now - Date.parse(last.attemptedAt) < settings.warmupCooldownSeconds * 1000) continue;
    const history = await options.repository.usageHistory(account.id, new Date(now - 8 * 86_400_000).toISOString());
    const candidate = warmupWindow(history, account, settings);
    if (!candidate) continue;
    if (last && last.window === candidate.window && Math.abs(Date.parse(last.resetAt) - Date.parse(candidate.resetAt)) < 15 * 60_000) continue;
    const model = warmupModel(settings.warmupModel, options.modelPlans.modelsFor(account.planType));
    const attemptId = await options.repository.claimWarmup({ accountId: account.id, window: candidate.window, resetAt: candidate.resetAt, model,
      attemptedAt: new Date(now).toISOString() });
    if (attemptId === null) continue;
    if (!model) {
      await options.repository.finishWarmup(attemptId, { status: "SKIPPED", errorCode: "model_unavailable", errorMessage: "No priced model is known for this plan yet." });
      continue;
    }
    await sendWarmup(options, account, model, settings.warmupPrompt).then(
      (result) => options.repository.finishWarmup(attemptId, result.ok ? { status: "SUCCEEDED" } : { status: "FAILED", errorCode: result.errorCode, errorMessage: result.errorMessage }),
      (error: unknown) => options.repository.finishWarmup(attemptId, { status: "FAILED", errorCode: "warmup_failed", errorMessage: error instanceof Error ? error.message : "The warm-up request failed." })
    );
    sent += 1;
  }
  return sent;
}

async function sendWarmup(options: WarmupRunnerOptions, account: GatewayAccountRecord, model: string, prompt: string) {
  const startedAt = (options.now ?? Date.now)();
  const credentials = await options.pool.credentials(account);
  const response = await (options.fetchImpl ?? fetch)(`${CODEX_UPSTREAM_BASE_URL}/codex/responses`, {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { ...buildCodexUpstreamHeaders({ "user-agent": "space-gateway-limit-warmup" }, credentials.accessToken, credentials.upstreamAccountId), "x-space-gateway-limit-warmup": "1" },
    body: JSON.stringify({ model, instructions: "Reply with OK only.", stream: true, store: false, tools: [], parallel_tool_calls: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }] })
  });
  const inspector = new ResponseStreamInspector();
  if (response.ok && response.body) {
    const reader = response.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; inspector.push(value); }
  }
  const outcome = inspector.outcome;
  const ok = response.ok && outcome.status === "success";
  const errorCode = ok ? null : response.ok ? outcome.errorCode ?? outcome.status : `http_${response.status}`;
  options.logs.add({
    requestId: `warmup_${randomUUID().replace(/-/g, "")}`, requestedAt: new Date(startedAt).toISOString(), provider: "CODEX", accountId: account.id, apiKeyId: null,
    model: outcome.model ?? model, planType: account.planType, reasoningEffort: null, serviceTier: null, transport: "http", upstreamTransport: "http",
    status: ok ? "success" : "error", errorCode, errorMessage: ok ? null : outcome.errorMessage ?? null, latencyMs: (options.now ?? Date.now)() - startedAt,
    firstTokenMs: null, inputTokens: outcome.usage?.inputTokens ?? null, cachedInputTokens: outcome.usage?.cachedInputTokens ?? null,
    outputTokens: outcome.usage?.outputTokens ?? null, reasoningTokens: outcome.usage?.reasoningTokens ?? null, costUsd: null, compressionTokensSaved: null,
    stickyKind: null, stickyKeyHash: null, clientName: "Space Gateway", source: "limit_warmup"
  });
  if (ok) void options.pool.markSuccess(account.id).catch(() => undefined);
  return { ok, errorCode, errorMessage: ok ? null : outcome.errorMessage ?? (response.ok ? null : `HTTP ${response.status}`) };
}

export function startWarmupRunner(options: WarmupRunnerOptions) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runWarmupCycle(options).catch((error: unknown) => options.onError?.(error)).finally(() => { running = false; });
  }, options.intervalMs ?? 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
