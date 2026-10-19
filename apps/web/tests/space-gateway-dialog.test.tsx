import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GatewayAccount, GatewayApiKey, GatewayDashboard, GatewayRequestLog, GatewaySettings, GatewayStatus } from "@space/contracts";
import { SpaceGatewayDialog, type SpaceGatewayClient } from "../src/features/space-gateway/SpaceGatewayDialog.js";

const clipboard = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock("../src/features/clipboard-dock/clipboard-events.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  writeClipboardText: async (text: string) => { clipboard.writes.push(text); return "live"; }
}));

const settings: GatewaySettings = {
  routingStrategy: "CAPACITY_WEIGHTED", stickyThreadsEnabled: true, preferEarlierReset: false, planPriority: ["plus", "prolite", "pro"],
  stickyReallocationBudgetThresholdPercent: 95, exhaustionFloorPercent: 3, compressionMode: "OFF", compressionProfile: "TOKEN", compressionCodeText: "OFF",
  compressionTimeBudgetMs: 250, compressionProviders: { CLAUDE: { mode: "OFF", outputPolicy: "LEAN" } }, requestLogRetentionDays: 30, displayTimeFormat: "24H",
  displayAccountWindows: "BOTH", displayBurnProjection: true,
  upstreamStreamTransport: "DEFAULT", promptCacheTtlSeconds: 1800, importWithoutOverwrite: true, warmupEnabled: false, warmupWindows: "BOTH",
  warmupModel: "auto", warmupPrompt: "Say OK.", warmupCooldownSeconds: 3600, warmupMinAvailablePercent: 100, claudeApiKeyFallback: false, lanMode: "ENV", lanHost: null, lanPort: null,
  lanAllowedSources: [], updatedAt: "2026-10-11T10:00:00.000Z"
};

const status: GatewayStatus = {
  service: { state: "RUNNING", version: "0.2.5", startedAt: "2026-10-11T10:00:00.000Z", inFlightRequests: 3, listen: "127.0.0.1:4920", error: null },
  accounts: { total: 2, active: 1, byProvider: [{ provider: "CODEX", total: 2, active: 1 }] },
  apiKeys: { total: 1, active: 1 },
  last24h: { requests: 1200, errors: 4, inputTokens: 2_500_000, outputTokens: 40_000, costUsd: 12.5, compressionTokensSaved: 0 },
  settings,
  checkedAt: "2026-10-11T10:00:00.000Z"
};

const account: GatewayAccount = {
  id: `gw_account:${"1".repeat(32)}`, provider: "CODEX", label: "Team A", alias: null, email: "team-a@example.test", planType: "plus", status: "ACTIVE",
  statusReason: null, priority: 100, warmupEnabled: false, resetCreditsAvailable: 2, primaryWindow: { usedPercent: 30, resetAt: null, windowMinutes: 300 },
  secondaryWindow: { usedPercent: 60, resetAt: null, windowMinutes: 10080 }, lastRefreshAt: null, lastUsedAt: null, createdAt: "2026-10-11T10:00:00.000Z"
};

const key: GatewayApiKey = {
  id: `gw_key:${"a".repeat(32)}`, name: "Codex CLI", keyPrefix: "sk-sgw-abcdefgh", isActive: true, trafficClass: "INTERACTIVE",
  allowedModels: [], enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountScopeEnabled: false, accountIds: [],
  compressionOverride: null, outputPolicyOverride: null, limits: [], expiresAt: null, lastUsedAt: null, createdAt: "2026-10-11T10:00:00.000Z"
};

const timing = { samples: 2, averageMs: 900, p50Ms: 800, p95Ms: 1400 };
const aggregate = { key: "total", requests: 1200, errors: 4, rateLimited: 1, inputTokens: 2_500_000, cachedInputTokens: 1_000_000, cacheCreationTokens: 0,
  outputTokens: 40_000, reasoningTokens: 0, costUsd: 12.5, compressionTokensSaved: 0, latency: timing, ttft: timing, lastAt: "2026-10-11T10:00:00.000Z" };

const log: GatewayRequestLog = {
  id: "41", requestId: "req_abc", requestedAt: "2026-10-11T09:59:00.000Z", provider: "CODEX", accountId: account.id, apiKeyId: key.id, model: "gpt-5.5",
  reasoningEffort: "high", serviceTier: "priority", transport: "http", status: "error", errorCode: "rate_limit_exceeded", latencyMs: 812, firstTokenMs: 210,
  inputTokens: 1200, cachedInputTokens: 300, outputTokens: 40, reasoningTokens: null, costUsd: 0.0123, compressionTokensSaved: null, stickyKind: "STICKY_THREAD",
  stickyKeyHash: "abcdef0123456789", planType: "plus", requestedServiceTier: "fast", upstreamTransport: "http", errorMessage: "Slow down", stickyKeySource: "prompt_cache_key",
  cacheCreationTokens: null, clientName: "Codex CLI", project: "space", compressionTokensBefore: 900, compressionTokensAfter: 400, source: null,
  cacheBust: null, compressionDetail: { strategies: ["smart_crusher"], waste: { json_bloat: 700 } }
};

const nullTiming = { averageMs: 2, p50Ms: 2, p95Ms: 4, minMs: 1, maxMs: 7, samples: 3 };
const headroomSession = {
  since: "2026-10-11T08:00:00.000Z", generatedAt: "2026-10-11T10:00:00.000Z", compressionMode: "ON" as const, sampled: false,
  requests: { total: 10, completed: 9, failed: 1, rateLimited: 1, cached: 6 }, live: { activeRequests: 2, activeWebSockets: 0, relayTasks: 0, compressionQueue: 1 },
  tokens: { input: 9000, output: 400, cachedInput: 5000, cacheWrites: 300, compressedBefore: 1500, compressedAfter: 500, saved: 1000, shadowSaved: 0, savingsPercent: 10, activeSavingsPercent: 66.67 },
  performance: { overhead: nullTiming, ttfb: nullTiming, latency: nullTiming, throughput: { forwardP50: 1200, forwardP95: 3000, generationP50: 80, generationP95: 140 },
    stages: [{ name: "compressor:smart_crusher", runs: 3, averageMs: 1.5, maxMs: 4 }, { name: "pipeline_total", runs: 3, averageMs: 2.5, maxMs: 7 }] },
  waste: [{ name: "json_bloat", tokens: 700 }, { name: "reread", tokens: 120 }],
  savingsOverTime: [{ t: "2026-10-11T09:00:00.000Z", saved: 400, shadowSaved: 0, requests: 4 }, { t: "2026-10-11T10:00:00.000Z", saved: 600, shadowSaved: 0, requests: 6 }],
  prefixCache: { requests: 6, hitRequests: 6, readTokens: 5000, writeTokens: 300, uncachedTokens: 3700, hitRatePercent: 55.56, busts: 1, bustTokens: 300, savedUsd: 0.01,
    writePremiumUsd: 0.0001, netUsd: 0.0099, byProvider: [{ provider: "CLAUDE", requests: 6, readTokens: 5000, writeTokens: 300, readDiscountPercent: 90, writePremiumPercent: 25, busts: 1, netUsd: 0.0099 }],
    misses: { ttlExpiry: 2, accountSwitch: 1, prefixChange: 0 } },
  compressionVsCache: { savedTokens: 1000, lostToBustTokens: 300, netTokens: 700 },
  agents: [{ key: "Codex CLI", requests: 10, beforeTokens: 10000, afterTokens: 9000, savedTokens: 1000, outputTokens: 400, savingsPercent: 10, shareOfSavedPercent: 100, shareOfRequestsPercent: 100 }],
  providers: [{ provider: "CODEX", requests: 10 }], models: [{ model: "gpt-5.5", requests: 10, savedTokens: 1000, sentTokens: 9000, reductionPercent: 10 }],
  recent: [log], rateLimits: [{ accountId: `gw_account:${"1".repeat(32)}`, label: "Team A", planType: "plus", primary: { usedPercent: 30, resetAt: null, windowMinutes: 300 },
    secondary: { usedPercent: 60, resetAt: null, windowMinutes: 10080 }, resetCredits: 2 }],
  poolWeekly: { remainingPercent: 40, remainingCredits: 0.4, capacityCredits: 1, resetAt: null }
};
const historyBucket = (key: string, saved: number) => ({ key, savedTokens: saved, savedUsd: saved / 1e6, inputTokens: 10 * saved, apiCostUsd: 1, requests: 5,
  cumulativeSavedTokens: saved, cumulativeSavedUsd: saved / 1e6, cumulativeApiCostUsd: 1, byModel: [] });

const dashboard: GatewayDashboard = {
  range: "24h", from: "2026-10-10T10:00:00.000Z", to: "2026-10-11T10:00:00.000Z", bucketSeconds: 3600, generatedAt: "2026-10-11T10:00:00.000Z", totals: aggregate,
  perPeriod: { unit: "hour", requests: 50, costUsd: 0.52, tokens: 105_833 },
  errorRate: { minutes: 1440, requests: 1200, errors: 4, errorRate: 0.0033, topError: { code: "rate_limit_exceeded", count: 3 } },
  errorRate7d: { minutes: 10080, requests: 5000, errors: 10, errorRate: 0.002, topError: null },
  errorRate5m: { minutes: 5, requests: 10, errors: 0, errorRate: 0, topError: null },
  trend: [{ t: "2026-10-11T09:00:00.000Z", requests: 600, errors: 1, tokens: 1000, costUsd: 6 }, { t: "2026-10-11T10:00:00.000Z", requests: 600, errors: 3, tokens: 1000, costUsd: 6.5 }],
  topKeys: [{ apiKeyId: key.id, name: "Codex CLI", requests: 1200, costUsd: 12.5 }],
  topModels: [{ model: "gpt-5.5", requests: 1200, costUsd: 12.5 }],
  latencyByModel: [{ key: "gpt-5.5", label: "gpt-5.5", provider: null, model: "gpt-5.5", serviceTier: null, apiKeyId: null, samples: 1200, errors: 4, errorRate: 0.0033,
    averageMs: 900, p50Ms: 800, p95Ms: 1400, ttftP50Ms: 200, ttftP95Ms: 9100, status: "DEGRADED", detail: "TTFT p95 9.1s ≥ 8s; errors 0.3%" }],
  routes: [],
  pools: [{ provider: "CODEX", accounts: 1,
    primary: { capacityCredits: 1, remainingCredits: 0.7, remainingPercent: 70, resetAt: null, burnAccounts: 0.6,
      accounts: [{ accountId: account.id, label: "Team A", planType: "plus", status: "ACTIVE", capacityCredits: 1, remainingCredits: 0.7, remainingPercent: 70, resetAt: null }] },
    secondary: { capacityCredits: 1, remainingCredits: 0.4, remainingPercent: 40, resetAt: null, burnAccounts: 0.9,
      accounts: [{ accountId: account.id, label: "Team A", planType: "plus", status: "ACTIVE", capacityCredits: 1, remainingCredits: 0.4, remainingPercent: 40, resetAt: null }] } }],
  live: [{ accountId: account.id, label: "Team A", planType: "plus", provider: "CODEX", activeRequests: 2, requests: 3, tokens: 4000, lastAt: "2026-10-11T09:59:50.000Z",
    model: "gpt-5.5", transport: "http", state: "LIVE" }],
  recent: [log]
};

const noAnthropicKey = { configured: false, keyHint: null, savedAt: null, lastSyncAt: null, lastError: null, upstream: [] };

function client(overrides: Partial<SpaceGatewayClient> = {}): SpaceGatewayClient {
  return {
    status: vi.fn(async () => status),
    dashboard: vi.fn(async () => dashboard),
    health: vi.fn(async () => ({ generatedAt: "2026-10-11T10:00:00.000Z", signals: [{ key: "database" as const, label: "Database", status: "OK" as const, nowMs: 2, p50Ms: 2,
      p95Ms: 4, samples: 3, sparkline: [1, 2, 4], warnMs: 50, criticalMs: 250, detail: "SELECT 1", updatedAt: "2026-10-11T10:00:00.000Z" }] })),
    accountDetail: vi.fn(async () => ({
      account, lifetime: { requests: 900, inputTokens: 2_000_000, cachedInputTokens: 500_000, outputTokens: 30_000, costUsd: 9.25 }, last7d: { ...aggregate, requests: 300 },
      trend: { primary: [{ t: "2026-10-11T09:00:00.000Z", value: 80 }, { t: "2026-10-11T10:00:00.000Z", value: 70 }],
        secondary: [{ t: "2026-10-11T09:00:00.000Z", value: 45 }, { t: "2026-10-11T10:00:00.000Z", value: 40 }],
        secondaryScheduled: [{ t: "2026-10-11T09:00:00.000Z", value: 50 }, { t: "2026-10-11T10:00:00.000Z", value: 49.4 }] },
      tokenStatus: { accessExpiresAt: "2099-01-01T00:00:00.000Z", refreshStored: true, idTokenParsed: true, lastRefreshAt: null, source: "oauth" }, lastWarmup: null
    })),
    updateAccount: vi.fn(async (_id: string, patch) => ({ ...account, ...(patch.alias !== undefined ? { alias: patch.alias || null } : {}),
      ...(patch.warmupEnabled !== undefined ? { warmupEnabled: patch.warmupEnabled } : {}) })),
    exportAccount: vi.fn(async () => ({ accountId: account.id, email: account.email, planType: "plus", status: "ACTIVE", authJson: "{\n  \"auth_mode\": \"chatgpt\"\n}" })),
    keyDetail: vi.fn(async () => ({ key, lifetime: { requests: 10, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, costUsd: 0.5 }, last7d: aggregate,
      costByAccount: [{ accountId: account.id, label: "Team A", requests: 10, costUsd: 0.5, deleted: false }],
      trend: [{ t: "2026-10-11T09:00:00.000Z", tokens: 50, costUsd: 0.2, requests: 4 }, { t: "2026-10-11T10:00:00.000Z", tokens: 60, costUsd: 0.3, requests: 6 }],
      pooled: { primaryRemainingPercent: 70, secondaryRemainingPercent: 40, accounts: 1 } })),
    regenerateKey: vi.fn(async () => ({ key: { ...key, keyPrefix: "sk-sgw-zzzzzzzz" }, plainKey: `sk-sgw-${"z".repeat(43)}` })),
    logDetail: vi.fn(async () => log),
    compressionSession: vi.fn(async () => headroomSession),
    compressionLifetime: vi.fn(async () => ({
      since: "2026-10-01", generatedAt: "2026-10-11T10:00:00.000Z", requests: { total: 100, completed: 95, failed: 5, rateLimited: 2, cached: 40 },
      tokens: { input: 90000, output: 4000, attemptedInput: 100000, saved: 10000, shadowSaved: 0, savingsPercent: 10 },
      cost: { apiCostUsd: 12, compressionSavedUsd: 0.5, cacheSavedUsd: 2.25, unpricedRequests: 3 },
      prefixCache: { requests: 100, cachedRequests: 40, hitRatePercent: 40, readTokens: 40000, writeTokens: 900, busts: 2, bustTokens: 600, ttlMinutes: 5 },
      misses: { ttlExpiry: 3, accountSwitch: 1, prefixChange: 2 }, waste: [{ name: "html_noise", tokens: 3200 }],
      providers: [{ provider: "CODEX", requests: 100, inputTokens: 90000, outputTokens: 4000, savedTokens: 10000 }], clients: headroomSession.agents,
      models: [{ model: "gpt-5.5", requests: 100, inputTokens: 90000, outputTokens: 4000, savedTokens: 10000 }],
      projects: [{ project: "space", requests: 30, savedTokens: 3000, savedUsd: 0.15, inputTokens: 27000, inputCostUsd: 3, lastDay: "2026-10-11", savingsPercent: 10 }]
    })),
    compressionHistory: vi.fn(async () => ({
      generatedAt: "2026-10-11T10:00:00.000Z", lifetime: { savedTokens: 3000, savedUsd: 0.003, activeDays: 2, averagePerDay: 1500, averagePerWeek: 3000, averagePerMonth: 3000 },
      series: { daily: [historyBucket("2026-10-10", 1000), historyBucket("2026-10-11", 2000)], weekly: [historyBucket("2026-10-06", 3000)], monthly: [historyBucket("2026-10", 3000)] },
      models: [{ model: "gpt-5.5", savedTokens: 3000, apiCostUsd: 2, savedUsd: 0.003, costWithoutUsd: 2.003 }], retention: { requestLogDays: 30, rollups: "kept" as const }
    })),
    logFacets: vi.fn(async () => ({ models: [{ value: "gpt-5.5", count: 3 }], providers: [{ value: "CODEX", count: 3 }], statuses: [{ value: "SUCCESS", count: 2 }, { value: "RATE_LIMITED", count: 1 }],
      accounts: [{ value: account.id, count: 3 }], apiKeys: [{ value: key.id, count: 3 }], clients: [{ value: "Codex CLI", count: 3 }] })),
    accounts: vi.fn(async () => ({ data: [account] })),
    setAccountPaused: vi.fn(async (_id: string, paused: boolean) => ({ ...account, status: paused ? "PAUSED" as const : "ACTIVE" as const })),
    keys: vi.fn(async () => ({ data: [key] })),
    createKey: vi.fn(async () => ({ key, plainKey: `sk-sgw-${"x".repeat(43)}` })),
    updateKey: vi.fn(async () => ({ ...key, isActive: false })),
    deleteKey: vi.fn(async () => ({ id: key.id, deleted: true as const })),
    logs: vi.fn(async () => ({ data: [], nextCursor: null })),
    updateSettings: vi.fn(async (patch) => ({ ...settings, ...patch, updatedAt: "2026-10-11T11:00:00.000Z" })),
    reload: vi.fn(async () => ({ status: "RELOADING" })),
    startDeviceSignIn: vi.fn(async () => ({ flowId: "f".repeat(32), verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", intervalSeconds: 3, expiresInSeconds: 600 })),
    pollDeviceSignIn: vi.fn(async () => ({ status: "CONNECTED" as const, account: { id: account.id, label: "Team B" } })),
    startBrowserSignIn: vi.fn(async () => ({ flowId: "e".repeat(32), authorizationUrl: "https://auth.openai.com/oauth/authorize?state=s" })),
    completeBrowserSignIn: vi.fn(async () => ({ status: "CONNECTED" as const, account: { id: account.id, label: "Team C" } })),
    importAuthJson: vi.fn(async () => ({ status: "CONNECTED" as const, account: { id: account.id, label: "Team D" } })),
    startClaudeSignIn: vi.fn(async () => ({ flowId: "c".repeat(32), authorizationUrl: "https://claude.com/cai/oauth/authorize?state=s" })),
    completeClaudeSignIn: vi.fn(async () => ({ status: "CONNECTED" as const, account: { id: account.id, label: "Claude Max" } })),
    antigravityProfiles: vi.fn(async () => ({ data: [{ profileId: "main", email: "main@example.com", inGateway: true }, { profileId: "google-4", email: "four@example.com", inGateway: false }] })),
    importAntigravityProfile: vi.fn(async () => ({ status: "CONNECTED" as const, account: { id: account.id, label: "four@example.com" } })),
    addOpenAiApiKey: vi.fn(async () => ({ status: "CONNECTED" as const, account: { id: account.id, label: "OpenAI API key …ssss" } })),
    refreshUsage: vi.fn(async () => ({ status: "REFRESHED" })),
    testAccount: vi.fn(async () => ({ ok: true, model: "gpt-5.5", status: 200, latencyMs: 812, error: null })),
    deleteAccount: vi.fn(async () => ({ id: account.id, deleted: true as const })),
    useResetCredit: vi.fn(async () => ({ outcome: "RESET", windowsReset: 1 })),
    compressionStats: vi.fn(async (hours: number) => {
      const totals = (requests: number, saved: number) => ({ requests, modifiedRequests: requests, blocks: requests, rejectedBlocks: 0, errorBlocks: 0, timedOut: 0,
        originalTokens: saved * 2, compressedTokens: saved, tokensSaved: saved, savingsPercent: 50, averageOverheadMs: 2.5, maxOverheadMs: 7 });
      return { hours, applied: totals(3, 1200), shadow: totals(0, 0),
        byProvider: [{ provider: "CODEX", requests: 3, modifiedRequests: 3, originalTokens: 2400, compressedTokens: 1200, tokensSaved: 1200, savingsPercent: 50 }],
        byStrategy: [{ mode: "ON" as const, strategy: "smart_crusher", blocks: 3, rejectedBlocks: 0, errorBlocks: 0, tokensSaved: 1200, savingsPercent: 50 }],
        history: [{ hour: "2026-10-11T10:00:00.000Z", appliedSaved: 1200, shadowSaved: 0, requests: 3 }] };
    }),
    anthropicAdmin: vi.fn(async () => noAnthropicKey),
    saveAnthropicAdminKey: vi.fn(async () => ({ ...noAnthropicKey, configured: true, keyHint: "…aaaa", savedAt: "2026-10-18T09:00:00.000Z",
      lastSyncAt: "2026-10-18T09:00:02.000Z", upstream: [{ accountId: account.id, apiKeyId: "apikey_gateway", keyName: "Space Gateway", workspaceId: "" }] })),
    removeAnthropicAdminKey: vi.fn(async () => ({ removed: true })),
    syncAnthropicBilling: vi.fn(async () => noAnthropicKey),
    report: vi.fn(async (from: string, to: string) => {
      const row = (key: string, requests: number) => ({ key, requests, errors: 1, inputTokens: 5000, cachedInputTokens: 1000, outputTokens: 300, reasoningTokens: 50, reasoningReported: 2, costUsd: 0.25, compressionTokensSaved: 0 });
      return { from, to, days: [row("2026-10-10", 4), row("2026-10-11", 6)], models: [row("gpt-5.5", 10)], accounts: [row(account.id, 10)], totals: row("total", 10) };
    }),
    ...overrides
  };
}

afterEach(() => cleanup());

describe("SpaceGatewayDialog", () => {
  it("shows the dashboard: service, key figures, cost leaders, capacity, live accounts and latency", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} onClose={() => undefined} />);
    expect(await screen.findByText("Running")).toBeTruthy();
    expect(screen.getByText(/127\.0\.0\.1:4920 · 3 in flight/)).toBeTruthy();
    expect((await screen.findAllByText("1,200")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("$12.50").length).toBeGreaterThan(0);
    expect(screen.getByText(/Top: rate_limit_exceeded/)).toBeTruthy();
    expect(screen.getByText("0.6 / 0.9")).toBeTruthy();
    expect(screen.getByRole("figure", { name: "Cost by API key" }).textContent).toContain("Codex CLI");
    expect(screen.getByRole("figure", { name: "Codex 5h remaining by account" }).textContent).toContain("Team A");
    expect(screen.getByText(/2 in flight · 3 requests/)).toBeTruthy();
    expect(screen.getByRole("table", { name: "Latency by model" }).textContent).toContain("Degraded");
    expect(await screen.findByText("SELECT 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    await waitFor(() => expect(api.dashboard).toHaveBeenLastCalledWith("7d"));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByRole("region", { name: "Team A details" })).toBeTruthy();
  });

  it("explains a stopped service instead of failing", async () => {
    const stopped = { ...status, service: { ...status.service, state: "NOT_INSTALLED" as const, version: null, listen: null, inFlightRequests: null, error: "Space Gateway is not running." } };
    render(<SpaceGatewayDialog client={client({ status: vi.fn(async () => stopped) })} onClose={() => undefined} />);
    expect(await screen.findByText("Not running")).toBeTruthy();
    expect(screen.getByText("Space Gateway is not running.")).toBeTruthy();
  });

  it("hides account emails by default and pauses an account", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
    expect((await screen.findAllByText("Team A")).length).toBeGreaterThan(0);
    expect(screen.queryByText("team-a@example.test")).toBeNull();
    expect(screen.getAllByText("70%").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.setAccountPaused).toHaveBeenCalledWith(account.id, true));
  });

  it("shows account details, saves an alias, opts into warm-up and exports auth.json only after confirming", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
    expect(await screen.findByText("Valid, expires in", { exact: false })).toBeTruthy();
    expect(screen.getByText("Stored")).toBeTruthy();
    expect(screen.getByRole("figure", { name: "Team A remaining quota over 7 days" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Alias"), { target: { value: "Main" } });
    fireEvent.click(screen.getByRole("button", { name: "Save alias" }));
    await waitFor(() => expect(api.updateAccount).toHaveBeenCalledWith(account.id, { alias: "Main" }));
    fireEvent.click(screen.getByRole("switch", { name: /Limit warm-up/ }));
    await waitFor(() => expect(api.updateAccount).toHaveBeenCalledWith(account.id, { warmupEnabled: true }));
    fireEvent.click(screen.getByRole("button", { name: "Export auth.json" }));
    expect(api.exportAccount).not.toHaveBeenCalled();
    expect(screen.getByText(/The export contains a working sign-in/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm export" }));
    expect(((await screen.findByLabelText("Exported auth.json")) as HTMLTextAreaElement).value).toContain("chatgpt");
  });

  it("searches and filters accounts by status, provider, plan and availability", async () => {
    const second = { ...account, id: `gw_account:${"2".repeat(32)}`, label: "Team B", status: "PAUSED" as const, planType: "pro" };
    // A Claude Max account at 100% of its 5-hour window, back in 40 minutes.
    const resetAt = new Date(Date.now() + 40 * 60_000).toISOString();
    const claude = { ...account, id: `gw_account:${"3".repeat(32)}`, label: "crew", provider: "CLAUDE" as const, planType: "max5x", status: "RATE_LIMITED" as const,
      primaryWindow: { usedPercent: 100, resetAt, windowMinutes: 300 }, secondaryWindow: { usedPercent: 29, resetAt: null, windowMinutes: 10080 } };
    render(<SpaceGatewayDialog client={client({ accounts: vi.fn(async () => ({ data: [account, second, claude] })) })} initialTab="accounts" onClose={() => undefined} />);
    const list = await screen.findByRole("list", { name: "Accounts" });
    expect(list.textContent).toContain("Team B");
    expect(screen.getByRole("button", { name: "All (3)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Available (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back soon (1)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back soon (1)" }));
    expect(screen.getByRole("list", { name: "Accounts" }).textContent).toContain("crew");
    expect(screen.getByRole("list", { name: "Accounts" }).textContent).not.toContain("Team A");
    fireEvent.click(screen.getByRole("button", { name: "All (3)" }));
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "CLAUDE" } });
    expect(screen.getByRole("list", { name: "Accounts" }).textContent).not.toContain("Team A");
    expect(screen.getByRole("button", { name: "All (1)" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "ALL" } });
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "pro" } });
    expect(screen.getByRole("list", { name: "Accounts" }).textContent).not.toContain("Team A");
    expect(screen.getByRole("list", { name: "Accounts" }).textContent).toContain("Team B");
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "ALL" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "PAUSED" } });
    expect(screen.getByRole("list", { name: "Accounts" }).textContent).not.toContain("Team A");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "ALL" } });
    fireEvent.change(screen.getByLabelText("Search accounts"), { target: { value: "pro" } });
    expect(screen.getByRole("list", { name: "Accounts" }).textContent).not.toContain("Team A");
  });

  it("says whether the Claude API key account was ever used", async () => {
    const keyAccount = { ...account, id: `gw_account:${"4".repeat(32)}`, label: "Claude API key …kkkk", provider: "CLAUDE" as const, planType: "api", email: null,
      lastUsedAt: null, primaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null }, secondaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null } };
    const baseDetail = await client().accountDetail(keyAccount.id);
    const api = client({ accounts: vi.fn(async () => ({ data: [keyAccount] })),
      accountDetail: vi.fn(async () => ({ ...baseDetail, account: keyAccount, lifetime: { ...baseDetail.lifetime, requests: 0 } })) });
    render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
    const role = await screen.findByTestId("claude-api-key-role");
    expect(role.textContent).toContain("Claude API key fallback is off");
    await waitFor(() => expect(api.accountDetail).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("claude-api-key-role").textContent).toContain("Never used."));
    cleanup();
    const used = { ...keyAccount, lastUsedAt: new Date(Date.now() - 5 * 60_000).toISOString() };
    const usedApi = client({ accounts: vi.fn(async () => ({ data: [used] })),
      accountDetail: vi.fn(async () => ({ ...baseDetail, account: used, lifetime: { ...baseDetail.lifetime, requests: 4 } })) });
    render(<SpaceGatewayDialog client={usedApi} initialTab="accounts" onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("claude-api-key-role").textContent).toMatch(/Served 4 requests · last used 5 min ago\./));
  });

  it("jumps from Routing to the Claude API key form in Accounts", async () => {
    render(<SpaceGatewayDialog client={client()} initialTab="routing" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Claude API key" }));
    expect(await screen.findByRole("heading", { name: "Add a Claude API key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this server's Claude key" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Accounts" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens as a full-screen page that Escape and the close button leave", () => {
    const onClose = vi.fn();
    const { container } = render(<SpaceGatewayDialog client={client()} fullscreen onClose={onClose} />);
    expect(container.querySelector(".space-gateway-backdrop.fullscreen")).toBeTruthy();
    const page = screen.getByRole("region", { name: "Space Gateway" });
    expect(page.getAttribute("aria-modal")).toBeNull();
    fireEvent.keyDown(page, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close Space Gateway" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("creates a key with limits and shows the plain key once", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="keys" onClose={() => undefined} />);
    await screen.findAllByText("Codex CLI");
    fireEvent.click(screen.getByRole("button", { name: "New key" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Worker" } });
    fireEvent.click(screen.getByRole("button", { name: "Add limit" }));
    fireEvent.change(screen.getByLabelText("Limit 1 maximum"), { target: { value: "500000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add limit" }));
    fireEvent.change(screen.getByLabelText("Limit 2 type"), { target: { value: "COST_USD" } });
    fireEvent.change(screen.getByLabelText("Limit 2 window"), { target: { value: "MONTHLY" } });
    fireEvent.change(screen.getByLabelText("Limit 2 maximum"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() => expect(api.createKey).toHaveBeenCalledWith(expect.objectContaining({
      name: "Worker", trafficClass: "INTERACTIVE",
      limits: [{ limitType: "TOTAL_TOKENS", limitWindow: "DAILY", maxValue: 500000, modelFilter: null },
        { limitType: "COST_USD", limitWindow: "MONTHLY", maxValue: 2_500_000, modelFilter: null }]
    })));
    expect(await screen.findByText("Copy this key now. It is shown only once.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(`sk-sgw-${"x".repeat(43)}`)).toBeNull();
  });

  it("edits a key, rejects a contradictory policy and regenerates its secret", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="keys" onClose={() => undefined} />);
    expect(await screen.findByRole("figure", { name: "Cost by account over 7 days" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Allowed models"), { target: { value: "gpt-5.5, gpt-6-sol" } });
    fireEvent.change(screen.getByLabelText("Enforced model"), { target: { value: "gpt-4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("The enforced model must be one of the allowed models.")).toBeTruthy();
    expect(api.updateKey).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Enforced model"), { target: { value: "gpt-6-sol" } });
    fireEvent.click(screen.getByLabelText("Team A"));
    fireEvent.change(screen.getByLabelText("Compression"), { target: { value: "ON" } });
    fireEvent.change(screen.getByLabelText("Output policy"), { target: { value: "OFF" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(api.updateKey).toHaveBeenCalledWith(key.id, expect.objectContaining({
      allowedModels: ["gpt-5.5", "gpt-6-sol"], enforcedModel: "gpt-6-sol", accountIds: [account.id], compressionOverride: "ON", outputPolicyOverride: "OFF", limits: []
    })));
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    expect(api.regenerateKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm regenerate" }));
    expect(await screen.findByText(`sk-sgw-${"z".repeat(43)}`)).toBeTruthy();
  });

  it("asks for confirmation before deleting a key", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="keys" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(api.deleteKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(api.deleteKey).toHaveBeenCalledWith(key.id));
  });

  it("saves the routing strategy and the compression mode", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="routing" onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText(/Routing strategy/), { target: { value: "FILL_FIRST" } });
    fireEvent.click(screen.getByRole("switch", { name: "Claude API key fallback" }));
    fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ routingStrategy: "FILL_FIRST", planPriority: ["plus", "prolite", "pro"],
      claudeApiKeyFallback: true })));
    fireEvent.click(screen.getByRole("tab", { name: "Compression" }));
    fireEvent.click(await screen.findByLabelText("On"));
    // Shadow (measure without sending) is no longer offered anywhere.
    expect(screen.queryByLabelText("Shadow")).toBeNull();
    expect(screen.queryByRole("option", { name: "Shadow" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Code and prose/), { target: { value: "ON" } });
    expect(screen.getByText(/File reads keep their exact text/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save compression" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ compressionMode: "ON", compressionProfile: "TOKEN", compressionCodeText: "ON", compressionTimeBudgetMs: 250 }));
  });

  it("saves compression and the output policy by provider, inheriting the global settings where unset", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="compression" onClose={() => undefined} />);
    const table = await screen.findByRole("table", { name: "Compression settings by provider" });
    expect(table.querySelector("input[type='checkbox']")).toBeNull();
    const claudeMode = screen.getByLabelText("Claude: Context compression") as HTMLSelectElement;
    expect(claudeMode.value).toBe("OFF");
    expect((screen.getByLabelText("Claude: Output policy") as HTMLSelectElement).value).toBe("LEAN");
    expect((screen.getByLabelText("Codex: Context compression") as HTMLSelectElement).value).toBe("");
    expect(screen.getAllByRole("option", { name: "Global (Off)" }).length).toBeGreaterThan(0);
    expect((screen.getByLabelText("Codex: Time budget") as HTMLInputElement).placeholder).toBe("Global (250)");
    fireEvent.change(claudeMode, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Antigravity: Output policy"), { target: { value: "CONCISE" } });
    fireEvent.change(screen.getByLabelText("Codex: Profile"), { target: { value: "CACHE" } });
    fireEvent.change(screen.getByLabelText("Codex: Time budget"), { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "Save provider settings" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ compressionProviders: {
      CLAUDE: { outputPolicy: "LEAN" }, ANTIGRAVITY: { outputPolicy: "CONCISE" }, CODEX: { profile: "CACHE", timeBudgetMs: 400 } } }));
    fireEvent.change(screen.getByLabelText("Claude: Output policy"), { target: { value: "OFF" } });
    fireEvent.click(screen.getByRole("button", { name: "Save provider settings" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ compressionProviders: {
      ANTIGRAVITY: { outputPolicy: "CONCISE" }, CODEX: { profile: "CACHE", timeBudgetMs: 400 } } }));
  });

  it("orders plan priority and saves display, warm-up and LAN settings (LAN with a reload)", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="routing" onClose={() => undefined} />);
    expect((await screen.findByRole("button", { name: "Move Pro down" })).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move Pro up" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Pro up" }));
    expect(screen.getByRole("button", { name: "Move Pro up" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Plan to add"), { target: { value: "team" } });
    fireEvent.click(screen.getByRole("button", { name: "Add plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Pro Lite" }));
    fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ planPriority: ["pro", "plus", "team"] })));

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    fireEvent.click(await screen.findByLabelText("12-hour"));
    fireEvent.click(screen.getAllByLabelText("Weekly")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Save display" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ displayTimeFormat: "12H", displayAccountWindows: "SECONDARY", displayBurnProjection: true }));

    fireEvent.click(screen.getByRole("switch", { name: "Limit warm-up" }));
    fireEvent.change(screen.getByLabelText("Cooldown per account (minutes)"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save warm-up" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ warmupEnabled: true, warmupCooldownSeconds: 1800, warmupModel: "auto" })));
    fireEvent.click(await screen.findByRole("switch", { name: /Team A/ }));
    await waitFor(() => expect(api.updateAccount).toHaveBeenCalledWith(account.id, { warmupEnabled: true }));

    fireEvent.change(screen.getByLabelText(/^Codex upstream transport/), { target: { value: "WEBSOCKET" } });
    expect(screen.getByText(/After a failed WebSocket open, HTTP is used for 60 seconds/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ promptCacheTtlSeconds: 1800, importWithoutOverwrite: true,
      upstreamStreamTransport: "WEBSOCKET" }));

    fireEvent.click(screen.getByLabelText("On"));
    fireEvent.change(screen.getByLabelText("LAN address"), { target: { value: "10.20.0.207" } });
    fireEvent.change(screen.getByLabelText(/Allowed ranges/), { target: { value: "10.20.0.0/24, 10.20.1.0/24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and reload" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ lanMode: "ON", lanHost: "10.20.0.207", lanPort: 4925, lanAllowedSources: ["10.20.0.0/24", "10.20.1.0/24"] }));
    await waitFor(() => expect(api.reload).toHaveBeenCalled());
    expect(await screen.findByText(/A new gateway worker is taking over/)).toBeTruthy();
    expect(screen.getByText(/Space sign-in replaces a separate dashboard password/)).toBeTruthy();
  });

  it("saves the Anthropic admin key write-only, shows its hint and matched key, and removes it only after confirmation", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="settings" onClose={() => undefined} />);
    const card = await screen.findByRole("form", { name: "Anthropic billing" });
    const input = within(card).getByLabelText("Admin API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect((within(card).getByRole("button", { name: "Save and check" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: `  sk-ant-admin01-${"a".repeat(40)} ` } });
    fireEvent.click(within(card).getByRole("button", { name: "Save and check" }));
    await waitFor(() => expect(api.saveAnthropicAdminKey).toHaveBeenCalledWith(`sk-ant-admin01-${"a".repeat(40)}`));
    expect(await within(card).findByText("Space Gateway")).toBeTruthy();
    expect(within(card).getByText("Admin key …aaaa")).toBeTruthy();
    expect((within(card).getByLabelText("Replace admin key") as HTMLInputElement).value).toBe("");
    fireEvent.click(within(card).getByRole("button", { name: "Remove key" }));
    expect(api.removeAnthropicAdminKey).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(api.removeAnthropicAdminKey).toHaveBeenCalled());
    expect(await within(card).findByText("No admin key")).toBeTruthy();
  });

  it("shows an empty request log", async () => {
    render(<SpaceGatewayDialog client={client()} initialTab="logs" onClose={() => undefined} />);
    expect(await screen.findByText(/No requests yet/)).toBeTruthy();
  });

  it("filters request logs, opens one with every field and exports the filtered list", async () => {
    const api = client({ logs: vi.fn(async () => ({ data: [log], nextCursor: null })) });
    render(<SpaceGatewayDialog client={api} initialTab="logs" onClose={() => undefined} />);
    const row = await screen.findByRole("row", { name: "Request req_abc" });
    expect(row.textContent).toContain("Rate limited");
    await waitFor(() => expect(screen.getByRole("row", { name: "Request req_abc" }).textContent).toContain("Team A"));
    fireEvent.click(screen.getByText("Status", { selector: "summary" }));
    fireEvent.click(await screen.findByLabelText(/Rate limited/));
    await waitFor(() => expect(api.logs).toHaveBeenLastCalledWith(expect.objectContaining({ filter: expect.objectContaining({ statuses: ["RATE_LIMITED"] }) })));
    fireEvent.change(screen.getByLabelText("Search request logs"), { target: { value: "req_abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.logs).toHaveBeenLastCalledWith(expect.objectContaining({ filter: expect.objectContaining({ q: "req_abc" }) })));
    const csv = screen.getByRole("link", { name: "Export CSV" }).getAttribute("href")!;
    expect(csv).toMatch(/^\/api\/admin\/gateway\/logs\/export\.csv\?/);
    expect(csv).toContain("status=RATE_LIMITED");
    expect(csv).toContain("q=req_abc");
    fireEvent.click(screen.getByRole("row", { name: "Request req_abc" }));
    const drawer = screen.getByRole("complementary", { name: "Request details" });
    expect(drawer.textContent).toContain("Slow down");
    expect(drawer.textContent).toContain("900 → 400 tokens of tool output");
    expect(drawer.textContent).toContain("sticky thread from prompt_cache_key");
    expect(drawer.textContent).toContain("asked for fast");
  });

  it("adds a Codex account with a device code and polls until connected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = client();
      render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
      fireEvent.click(await screen.findByRole("button", { name: "Get a sign-in code" }));
      expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
      await waitFor(() => expect(clipboard.writes).toEqual(["ABCD-EFGH", "https://auth.openai.com/codex/device"]));
      await vi.advanceTimersByTimeAsync(3100);
      await waitFor(() => expect(api.pollDeviceSignIn).toHaveBeenCalledWith("f".repeat(32)));
      expect(await screen.findByText("Connected Team B.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs an account in again from its 'Sign in again' label and the detail button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const signedOut = { ...account, status: "REAUTH_REQUIRED" as const, statusReason: "Authentication token invalidated - re-login required" };
      const api = client({ accounts: vi.fn(async () => ({ data: [signedOut] })) });
      render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
      expect(await screen.findByText("Space Gateway no longer sends requests to this account. Sign it in again to bring it back.")).toBeTruthy();
      // The label in the list opens the sign-in, the detail button closes and reopens it.
      fireEvent.click((await screen.findAllByTitle("Sign this account in again"))[0]!);
      expect(await screen.findByRole("heading", { name: "Sign Team A in again" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close sign-in" }));
      expect(screen.queryByRole("heading", { name: "Sign Team A in again" })).toBeNull();
      // The status chip in the detail header and the button next to the explanation both open it.
      expect(screen.getAllByRole("button", { name: "Sign in again" })).toHaveLength(2);
      fireEvent.click(screen.getAllByRole("button", { name: "Sign in again" }).at(-1)!);
      fireEvent.click(await screen.findByRole("button", { name: "Get a sign-in code" }));
      expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3100);
      expect(await screen.findByText("Team A is signed in again.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes browser sign-in with the pasted address and imports auth.json", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Sign in with the browser" }));
    fireEvent.click(screen.getByRole("button", { name: "Start browser sign-in" }));
    fireEvent.change(await screen.findByLabelText("Address after sign-in"), { target: { value: "http://localhost:1455/auth/callback?code=c&state=s" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    await waitFor(() => expect(api.completeBrowserSignIn).toHaveBeenCalledWith("e".repeat(32), "http://localhost:1455/auth/callback?code=c&state=s"));
    fireEvent.click(screen.getByRole("tab", { name: "Import auth.json" }));
    fireEvent.change(screen.getByLabelText(/Contents of a Codex auth.json/), { target: { value: "{\"tokens\":{}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Imported Team D.")).toBeTruthy();
  });

  it("adds a Claude account with the pasted authorization code", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Claude sign-in" }));
    expect((await screen.findByRole("link", { name: "Open the Claude sign-in page" })).getAttribute("href")).toBe("https://claude.com/cai/oauth/authorize?state=s");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(clipboard.writes).toContain("https://claude.com/cai/oauth/authorize?state=s"));
    fireEvent.change(screen.getByLabelText(/Authorization code/), { target: { value: " abcdefgh1234#state " } });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    await waitFor(() => expect(api.completeClaudeSignIn).toHaveBeenCalledWith("c".repeat(32), "abcdefgh1234#state"));
    expect(await screen.findByText("Connected Claude Max.")).toBeTruthy();
  });

  it("adds an Antigravity account from a signed-in profile and shows its quota groups", async () => {
    const antigravity = { ...account, id: `gw_account:${"9".repeat(32)}`, provider: "ANTIGRAVITY" as const, label: "Pro Google",
      quotaGroups: [{ key: "claude", primaryWindow: { usedPercent: 100, resetAt: null, windowMinutes: 300 }, secondaryWindow: { usedPercent: 20, resetAt: null, windowMinutes: 10080 } },
        { key: "gemini", primaryWindow: { usedPercent: 25, resetAt: null, windowMinutes: 300 }, secondaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null } }] };
    const api = client({ accounts: vi.fn(async () => ({ data: [antigravity] })) });
    render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
    expect((await screen.findAllByText("Claude and GPT")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Gemini").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    fireEvent.click(screen.getByRole("tab", { name: "Antigravity" }));
    expect(await screen.findByText("In Space Gateway")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to Space Gateway" }));
    await waitFor(() => expect(api.importAntigravityProfile).toHaveBeenCalledWith("google-4"));
    expect(await screen.findByText("Connected four@example.com.")).toBeTruthy();
  });

  it("adds an OpenAI API key, pasted or the server's own", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    fireEvent.click(await screen.findByRole("tab", { name: "OpenAI API" }));
    fireEvent.click(screen.getByRole("button", { name: "Use this server's OpenAI key" }));
    await waitFor(() => expect(api.addOpenAiApiKey).toHaveBeenCalledWith({ provider: "OPENAI_API", useSpaceKey: true }));
    expect(await screen.findByText("Connected OpenAI API key …ssss.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: ` sk-proj-${"x".repeat(30)} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    await waitFor(() => expect(api.addOpenAiApiKey).toHaveBeenLastCalledWith({ provider: "OPENAI_API", apiKey: `sk-proj-${"x".repeat(30)}` }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");

    // Key pools: OpenRouter keys have no server key to reuse.
    fireEvent.click(screen.getByRole("tab", { name: "OpenRouter" }));
    expect(await screen.findByText(/key pool at \/pools\/openrouter\/v1/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this server's OpenAI key" })).toBeNull();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: `sk-or-v1-${"y".repeat(40)}` } });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    await waitFor(() => expect(api.addOpenAiApiKey).toHaveBeenLastCalledWith({ provider: "OPENROUTER", apiKey: `sk-or-v1-${"y".repeat(40)}` }));
  });

  it("tests, refreshes and removes accounts", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    expect(await screen.findByText("Team A answered with gpt-5.5 in 812 ms.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
    await waitFor(() => expect(api.refreshUsage).toHaveBeenCalledWith(account.id));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(api.deleteAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(api.deleteAccount).toHaveBeenCalledWith(account.id));
  });

  it("shows reports by day, model and account and switches range", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="reports" onClose={() => undefined} />);
    expect(await screen.findByRole("table", { name: "Day" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Account" }).textContent).toContain("Team A");
    expect(screen.getByRole("table", { name: "Model" }).textContent).toContain("gpt-5.5");
    const [from, to] = (api.report as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(6);
    fireEvent.click(screen.getByRole("tab", { name: "28 days" }));
    await waitFor(() => expect(api.report).toHaveBeenCalledTimes(2));
  });

  it("spends a reset credit only after confirmation", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="accounts" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use reset credit (2)" }));
    expect(api.useResetCredit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
    await waitFor(() => expect(api.useResetCredit).toHaveBeenCalledWith(account.id, expect.stringMatching(/^[0-9a-f-]{36}$/)));
    expect(await screen.findByText("Team A: Weekly limit reset.")).toBeTruthy();
  });

  it("shows compression statistics by strategy", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="compression" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("tab", { name: "By strategy" }));
    expect(await screen.findByRole("table", { name: "Savings by strategy" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Savings by provider" }).textContent).toContain("Codex");
    expect(screen.getByText("JSON (SmartCrusher)")).toBeTruthy();
    expect(screen.getAllByText("1,200").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    await waitFor(() => expect(api.compressionStats).toHaveBeenLastCalledWith(168));
  });

  it("shows Headroom's session, lifetime and historical views", async () => {
    const api = client();
    render(<SpaceGatewayDialog client={api} initialTab="compression" onClose={() => undefined} />);
    expect(await screen.findByRole("region", { name: "Request health" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Live activity" }).textContent).toContain("Compression queue1");
    expect(screen.getByRole("list", { name: "Waste signals" }).textContent).toContain("JSON bloat");
    expect(screen.getByRole("list", { name: "Waste signals" }).textContent).toContain("Re-reads");
    expect(screen.getByRole("table", { name: "Pipeline breakdown" }).textContent).toContain("JSON (SmartCrusher)");
    expect(screen.getByText(/2 after the cache expired · 1 after an account switch/)).toBeTruthy();
    expect(screen.getByRole("table", { name: "Agent usage" }).textContent).toContain("Codex CLI");
    expect(screen.getByText(/Pool weekly remaining 40%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("row", { expanded: false }));
    expect(screen.getByText("JSON bloat 700")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Lifetime" }));
    expect(await screen.findByRole("table", { name: "Projects" })).toBeTruthy();
    expect(screen.getByText(/3 requests on unpriced models/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Historical" }));
    expect(await screen.findByRole("table", { name: "History by model" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Export CSV" }).getAttribute("href")).toBe("/api/admin/gateway/compression/export?format=csv&series=daily");
    fireEvent.click(screen.getByRole("tab", { name: "Weekly" }));
    expect(screen.getByRole("link", { name: "Export CSV" }).getAttribute("href")).toContain("series=weekly");
    fireEvent.click(screen.getByRole("tab", { name: "Cost" }));
    expect(screen.getByRole("figure", { name: "API cost with and without compression (cumulative)" })).toBeTruthy();
  });
});
