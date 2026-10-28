import { execFile } from "./safe-child-process.js";
import { claudeCostUsd, costUsd, geminiCostUsd } from "@space/gateway";
import type { GatewayClaudeLogKey, GatewayRepository, SystemAnalyticsModelEventRecord, SystemAnalyticsRepository } from "@space/db";
import type { GatewayRequestLog, GatewayUsageWindow } from "@space/contracts";
import { z } from "zod";

/**
 * Token usage page sources besides the CLI readers of the analytics service (operator request 2026-10-15): every
 * Space Gateway request, and every Claude Code message read from Claude's own transcripts by the
 * space-cli-token-usage helper. Each token counts once: the gateway's copy of a gateway call, the transcript's copy
 * of a direct one (`route`), so a transcript message that went through the gateway is stored but not added again.
 */

// Each new version imports the retained logs once more, so requests logged before their model had a price get one
// (v2: Gemini, v3: GPT-6.1 Sol).
export const GATEWAY_LOG_CURSOR = "gateway-log-id-v3";
// Each version reads the month again (v2: a message's last line holds its final output count; v3: gateway calls are
// matched by prompt size; v4: sessions of closed panes find their profile).
export const CLAUDE_TIME_CURSOR = "claude-message-at-v4";
/** The first Antigravity (Gemini) request through the gateway: Gemini CLI sessions from then on are counted there. */
export const GEMINI_GATEWAY_CURSOR = "gemini-gateway-since";
const HELPER = "/opt/spaceapp/bin/space-cli-token-usage";
const PAGE = 2000;

export type TokenUsageGateway = Pick<GatewayRepository, "requestLogsAfter" | "claudeLogKeys">;

/** The Space pane session a Claude Code session ran in, and its account profile. */
export interface ClaudeSessionOwner {
  profileId: string | null;
  paneSessionId: string | null;
  roomId: string | null;
  paneId: string | null;
}

export interface TokenUsageSourceOptions {
  repository: Pick<SystemAnalyticsRepository, "upsertModelEvents" | "getCursor" | "setCursor">;
  gateway: () => TokenUsageGateway | null;
  /** Gateway accounts, to put a direct Claude profile on the same account as its gateway traffic. */
  gatewayAccounts: () => Promise<({ id: string; provider: string; email: string | null; label: string }
    & Partial<Record<"primaryWindow" | "secondaryWindow", GatewayUsageWindow>>)[]>;
  /** The helper's output (`--since` when given), or null where it cannot run (dev has no sudo). */
  readClaude: (since: string | null) => Promise<unknown | null>;
  /** The helper's Codex turns of the last 35 days, from every rollout (older ones are owner-only), or null. */
  readCodexHistory: () => Promise<unknown | null>;
  claudeSessionOwner: (claudeSessionId: string, at: string) => Promise<ClaudeSessionOwner | null>;
  now: () => Date;
}

const gatewayProviderIds: Record<string, string> = {
  CLAUDE: "anthropic", ANTHROPIC_API: "anthropic", CODEX: "codex", ANTIGRAVITY: "google", GOOGLE_AI: "google", OPENAI_API: "openai-api"
};

export function gatewayLogEvent(log: GatewayRequestLog, updatedAt: string): SystemAnalyticsModelEventRecord {
  // A failed request without usage spent nothing; only a successful one without usage is "not reported".
  const none = log.status === "success" ? null : 0;
  const endedAt = log.latencyMs === null ? log.requestedAt : new Date(Date.parse(log.requestedAt) + log.latencyMs).toISOString();
  return {
    eventKey: `gateway:${log.id}`, source: "gateway", runtimeId: "space-gateway",
    providerId: gatewayProviderIds[log.provider] ?? log.provider.toLowerCase(), modelId: log.model || "unknown",
    roomId: null, paneId: null, sessionId: null, turnId: log.requestId,
    status: log.status === "success" ? "COMPLETED" : "ABORTED", coverage: "NATIVE", turnCount: 1,
    startedAt: log.requestedAt, endedAt, tokensIn: log.inputTokens ?? none, tokensOut: log.outputTokens ?? none, tokensReasoning: log.reasoningTokens,
    ttftMs: log.firstTokenMs, durationMs: log.latencyMs, updatedAt,
    route: "GATEWAY", accountKey: log.accountId,
    costUsd: log.costUsd ?? (log.provider === "ANTIGRAVITY" ? geminiCostUsd({ promptTokens: log.inputTokens, cachedTokens: log.cachedInputTokens,
      outputTokens: log.outputTokens, thoughtsTokens: log.reasoningTokens }, log.model)
      : log.provider === "CODEX" ? costUsd(log, log.model, log.serviceTier) : null),
    tokensCacheRead: log.cachedInputTokens,
    tokensCacheWrite: log.cacheCreationTokens ?? null
  };
}

/** Imports gateway requests logged after the stored cursor, a few pages per call. */
export async function ingestGatewayLogs(options: TokenUsageSourceOptions): Promise<number> {
  const gateway = options.gateway();
  if (!gateway) return 0;
  let cursor = await options.repository.getCursor(GATEWAY_LOG_CURSOR);
  let geminiSince = await options.repository.getCursor(GEMINI_GATEWAY_CURSOR);
  let imported = 0;
  for (let page = 0; page < 25; page += 1) {
    const logs = await gateway.requestLogsAfter(cursor, PAGE);
    if (logs.length === 0) break;
    const updatedAt = options.now().toISOString();
    await options.repository.upsertModelEvents(logs.map((log) => gatewayLogEvent(log, updatedAt)));
    const gemini = geminiSince ? undefined : logs.find((log) => log.provider === "ANTIGRAVITY");
    if (gemini) await options.repository.setCursor(GEMINI_GATEWAY_CURSOR, geminiSince = gemini.requestedAt);
    cursor = logs.at(-1)!.id;
    await options.repository.setCursor(GATEWAY_LOG_CURSOR, cursor);
    imported += logs.length;
    if (logs.length < PAGE) break;
  }
  return imported;
}

const count = z.number().int().min(0);

const codexHistorySchema = z.object({
  schema: z.literal(2),
  codexTurns: z.array(z.object({
    turnId: z.string().max(120), provider: z.string().max(160), model: z.string().max(160),
    startedAt: z.string().datetime(), endedAt: z.string().datetime(), status: z.enum(["COMPLETED", "ABORTED"]),
    tokensIn: count, tokensOut: count, tokensReasoning: count, tokensCacheRead: count
  })).max(200_000)
});
export type CodexHistoryTurn = z.infer<typeof codexHistorySchema>["codexTurns"][number];

export function parseCodexHistory(raw: unknown): CodexHistoryTurn[] {
  return codexHistorySchema.parse(raw).codexTurns;
}
const claudeUsageSchema = z.object({
  schema: z.literal(2),
  generatedAt: z.string().datetime(),
  profiles: z.array(z.object({ profileId: z.string().max(80), email: z.string().max(200).nullable(),
    lastSessionIds: z.array(z.string().max(120)).max(500).optional() })).max(200),
  messages: z.array(z.object({
    id: z.string().max(120), at: z.string().datetime(), sessionId: z.string().max(120).nullable(), model: z.string().max(160),
    requestId: z.string().max(120).nullable(), inputTokens: count, cacheReadInputTokens: count, cacheCreationInputTokens: count,
    cacheCreation1hInputTokens: count, outputTokens: count, thinkingTokens: count, speed: z.string().max(20).nullable()
  })).max(500_000)
});
type ClaudeMessage = z.infer<typeof claudeUsageSchema>["messages"][number];

/**
 * Gateway calls among transcript messages: by Anthropic request id, else (logs from before the id was kept) model and
 * prompt size, which a transcript reports exactly (its output count can lag the gateway's final one).
 */
function gatewayMatcher(keys: GatewayClaudeLogKey[]) {
  const upstream = new Set(keys.flatMap((key) => (key.upstreamRequestId ? [key.upstreamRequestId] : [])));
  const unmatched = new Map<string, number[]>();
  for (const key of keys) {
    if (key.upstreamRequestId || key.inputTokens === null) continue;
    const bucket = `${key.model}\u0000${key.inputTokens}`;
    unmatched.set(bucket, [...(unmatched.get(bucket) ?? []), Date.parse(key.requestedAt)]);
  }
  return (message: ClaudeMessage): boolean => {
    if (message.requestId && upstream.has(message.requestId)) return true;
    const prompt = message.inputTokens + message.cacheReadInputTokens + message.cacheCreationInputTokens;
    const times = unmatched.get(`${message.model}\u0000${prompt}`);
    const at = Date.parse(message.at);
    // The transcript line is written when the answer ends; the gateway logs when the request starts.
    const index = times?.findIndex((time) => time >= at - 15 * 60_000 && time <= at + 60_000) ?? -1;
    if (index < 0) return false;
    times!.splice(index, 1);
    return true;
  };
}

/** Imports Claude Code messages newer than the stored cursor (minus an overlap; message ids make it idempotent). */
export async function ingestClaudeTranscripts(options: TokenUsageSourceOptions): Promise<number> {
  const cursor = await options.repository.getCursor(CLAUDE_TIME_CURSOR);
  const since = cursor ? new Date(Date.parse(cursor) - 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  const raw = await options.readClaude(since);
  if (raw === null) return 0;
  const usage = claudeUsageSchema.parse(raw);
  const messages = usage.messages;
  if (messages.length === 0) {
    if (!cursor) await options.repository.setCursor(CLAUDE_TIME_CURSOR, usage.generatedAt);
    return 0;
  }
  // The helper sorts messages by time.
  const [first, last] = [Date.parse(messages[0]!.at), Date.parse(messages.at(-1)!.at)];
  const gateway = options.gateway();
  const viaGateway = gatewayMatcher(gateway
    ? await gateway.claudeLogKeys(new Date(first - 15 * 60_000).toISOString(), new Date(last + 60_000).toISOString())
    : []);
  const emails = new Map(usage.profiles.map((profile) => [profile.profileId, profile.email?.toLowerCase() ?? null]));
  // A session outside Space panes: the profile that lists it as a project's last session, when one does.
  const lastSessionProfile = new Map(usage.profiles.flatMap((profile) => (profile.lastSessionIds ?? []).map((id) => [id, profile.profileId] as const)));
  const accountByEmail = new Map((await options.gatewayAccounts().catch(() => []))
    .filter((account) => account.provider === "CLAUDE")
    .map((account) => [(account.email ?? account.label).trim().toLowerCase(), account.id]));
  const owners = new Map<string, ClaudeSessionOwner | null>();
  const updatedAt = options.now().toISOString();
  const events: SystemAnalyticsModelEventRecord[] = [];
  for (const message of messages) {
    const key = message.sessionId ?? "";
    if (!owners.has(key)) owners.set(key, message.sessionId ? await options.claudeSessionOwner(message.sessionId, message.at) : null);
    const owner = owners.get(key) ?? null;
    // A session can move between accounts, so only the call itself says whether it went through the gateway.
    const gatewayCall = viaGateway(message);
    const profileId = owner?.profileId ?? lastSessionProfile.get(message.sessionId ?? "") ?? null;
    const email = profileId ? emails.get(profileId) ?? null : null;
    events.push({
      eventKey: `claude:${message.id}`, source: "claude", runtimeId: "cli:claude", providerId: "anthropic", modelId: message.model,
      roomId: owner?.roomId ?? null, paneId: owner?.paneId ?? null, sessionId: owner?.paneSessionId ?? null, turnId: message.id,
      status: "COMPLETED", coverage: "NATIVE", turnCount: 1, startedAt: message.at, endedAt: message.at,
      // Stored like the gateway stores Claude input: fresh input plus cache reads and writes.
      tokensIn: message.inputTokens + message.cacheReadInputTokens + message.cacheCreationInputTokens,
      tokensOut: message.outputTokens, tokensReasoning: message.thinkingTokens || null, ttftMs: null, durationMs: null, updatedAt,
      route: gatewayCall ? "GATEWAY" : "DIRECT",
      accountKey: gatewayCall ? null : (email ? accountByEmail.get(email) : undefined) ?? `cli:claude/${profileId ?? "unattributed"}`,
      costUsd: claudeCostUsd(message, message.model), tokensCacheRead: message.cacheReadInputTokens,
      tokensCacheWrite: message.cacheCreationInputTokens
    });
  }
  await options.repository.upsertModelEvents(events);
  await options.repository.setCursor(CLAUDE_TIME_CURSOR, messages.at(-1)!.at);
  return events.length;
}

/** The analytics service's token sources: the gateway's database, and the helper where it may run. */
export function tokenUsageSourcesFor(gateway: () => GatewayRepository, claudeHelper: boolean) {
  return {
    gateway, gatewayAccounts: () => gateway().listAccounts(),
    // The helper needs sudo: stable only (instance job token-usage-claude), never under tests.
    ...(claudeHelper && process.env.VITEST !== "true" ? {} : { readClaude: async () => null, readCodexHistory: async () => null })
  };
}


/** Runs the root-owned helper as spaceapp-user; null when it is missing or sudo refuses (dev, or before its deploy). */
export function readClaudeTokenUsage(since: string | null): Promise<unknown | null> {
  return runHelper(since ? ["--since", since] : []);
}

export function readCodexHistory(): Promise<unknown | null> {
  return runHelper(["--codex-history"]);
}

function runHelper(args: string[]): Promise<unknown | null> {
  return new Promise((resolve) => {
    execFile("sudo", ["-n", "-u", "spaceapp-user", HELPER, ...args],
      { timeout: 180_000, maxBuffer: 128 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
        if (error) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
  });
}
