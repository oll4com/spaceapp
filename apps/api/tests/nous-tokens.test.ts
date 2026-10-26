import { describe, expect, it, vi } from "vitest";
import { nousLowSpendSettingsSchema, nousSettingsSchema, type ClaudeUsageAccountList, type GatewayAccount, type NousSpendMode } from "@space/contracts";
import { createClaudeUsageAccountProvider } from "../src/claude-usage-services.js";
import { computeNousTokens, createNousTokenMonitor, nousTokenModel, readNousTokens, renderNousTokens } from "../src/nous/tokens.js";
import { createNousSubagents } from "../src/nous/subagents.js";

const now = Date.parse("2026-10-24T09:00:00Z");
const reset = "2026-10-24T10:00:00.000Z";
const weeklyReset = "2026-10-25T10:00:00.000Z";
const account = (id: string, used = 10, extra: Partial<GatewayAccount> = {}): GatewayAccount => ({
  id, provider: "CLAUDE", label: id, alias: null, email: `${id}@example.com`, planType: "max", status: "ACTIVE", statusReason: null,
  priority: 0, warmupEnabled: false, resetCreditsAvailable: null, lastRefreshAt: new Date(now).toISOString(), lastUsedAt: null, createdAt: new Date(now).toISOString(),
  primaryWindow: { usedPercent: used, resetAt: reset, windowMinutes: 300 }, secondaryWindow: { usedPercent: 10, resetAt: weeklyReset, windowMinutes: 10080 }, ...extra
});
const profiles = { data: [{ id: "main", label: "Main", status: "CONNECTED", email: "main@example.com", fiveHourRemainingPercent: 15, weeklyRemainingPercent: 90 }] } as ClaudeUsageAccountList;
const config = nousLowSpendSettingsSchema.parse({});
const compute = (accounts: GatewayAccount[] | null, extra: Partial<Parameters<typeof computeNousTokens>[0]> = {}) => computeNousTokens({ accounts, profiles, settings: config, now, ...extra });
const budget = (spentUsd: number) => ({ budgetUsd: 100, spentUsd });

describe("Nous automatic low-spend policy", () => {
  it("counts Max accounts at the 10% room boundary and recovers at reset without a new sample", () => {
    expect(compute([account("main", 90), account("other", 90)]).mode).toBe("NORMAL");
    const accounts = [account("main", 90), account("other", 90.01)];
    expect(compute(accounts)).toMatchObject({ mode: "LOW", max: { withRoom: 1, total: 2 }, servingAccountId: "main", resetAt: reset });
    expect(compute(accounts, { now: Date.parse(reset) })).toMatchObject({ mode: "NORMAL" });
    expect(compute([account("a", 100), account("b", 100)], { settings: { ...config, mode: "OFF" }, budget: budget(99) }).mode).toBe("NORMAL");
    expect(compute([account("a"), account("b")], { settings: { ...config, mode: "ON" } })).toMatchObject({ mode: "LOW", resetAt: null });
  });

  it("uses the API budget only for CRITICAL when no Max account has room", () => {
    const full = [account("a"), account("b")];
    expect(compute(full, { budget: budget(60) }).mode).toBe("NORMAL");
    expect(compute(full, { budget: budget(60.01) }).mode).toBe("NORMAL");
    expect(compute([account("a", 100)], { budget: budget(80) }).mode).toBe("LOW");
    expect(compute([account("a", 100)], { budget: budget(80.01) })).toMatchObject({ mode: "CRITICAL", resetAt: null });
    expect(compute(full, { budget: budget(99) }).mode).toBe("NORMAL");
    const recover = compute([account("a", 100), account("b", 100)], { budget: budget(20) });
    expect(recover).toMatchObject({ mode: "LOW", resetAt: reset });
    expect(compute(full, { budget: budget(80) }).resetAt).toBeNull();
  });

  it.each([
    { withRoom: 5, spentUsd: 365, mode: "NORMAL", resetAt: null },
    { withRoom: 1, spentUsd: 365, mode: "LOW", resetAt: reset },
    { withRoom: 0, spentUsd: 425, mode: "CRITICAL", resetAt: reset }
  ])("returns $mode with $withRoom/5 Max accounts with room and $spentUsd/$500 spent", ({ withRoom, spentUsd, mode, resetAt }) => {
    const accounts = Array.from({ length: 5 }, (_, index) => account(String(index), index < withRoom ? 5 : 100));
    const state = compute(accounts, { budget: { budgetUsd: 500, spentUsd } });
    expect(state).toMatchObject({ mode, max: { withRoom, total: 5 }, resetAt });
    expect(compute(accounts, { now: Date.parse(reset), budget: { budgetUsd: 500, spentUsd } })).toMatchObject({ mode: "NORMAL", resetAt: null });
  });

  it("estimates recovery at the Max reset that restores enough room, even beyond the month boundary", () => {
    const laterReset = "2026-11-01T10:00:00.000Z";
    const accounts = [account("a", 100), account("b", 100, { primaryWindow: { usedPercent: 100, resetAt: laterReset, windowMinutes: 300 } })];
    const state = compute(accounts, { budget: budget(85) });
    expect(state).toMatchObject({ mode: "CRITICAL", nextResetAt: reset, resetAt: laterReset });
    expect(renderNousTokens(state, "Asia/Bangkok", now)).toContain("normal again at about 1 Nov 2026, 17:00 Asia/Bangkok");
  });

  it("excludes paused, reauth, free, API and non-Max accounts; unknown samples never masquerade as room", () => {
    const accounts = [account("a", 100), account("paused", 0, { status: "PAUSED" }), account("reauth", 0, { status: "REAUTH_REQUIRED" }),
      account("api", 0, { planType: "api" }), account("free", 0, { planType: "free" }), account("pro", 0, { planType: "pro" }),
      account("unknown", 0, { primaryWindow: { usedPercent: null, resetAt: null, windowMinutes: 300 } })];
    expect(compute(accounts)).toMatchObject({ mode: "LOW", max: { total: 2, withRoom: 0 } });
    expect(compute(null)).toMatchObject({ mode: "NORMAL", max: null });
    expect(compute(null, { budget: budget(90) }).mode).toBe("NORMAL");
    expect(compute([], { budget: budget(90) }).mode).toBe("CRITICAL");
    expect(compute([account("a", 95), account("b", 95)], { settings: { ...config, minMaxAccountsWithRoom: 1, roomRemainingPercent: 5 } }).mode).toBe("NORMAL");
  });

  it("shows account windows, local resets, API spend/budget and last-hour cost", () => {
    const state = compute([account("main", 100), account("other", 100), account("codex", 42, { provider: "CODEX" })],
      { budget: budget(28.5), lastHour: { costUsd: 12.3, turns: 7, unpricedTurns: 1 } });
    const text = renderNousTokens(state, "Europe/Athens", now);
    expect(text).toMatch(/^Low-spend mode: LOW since/);
    expect(text).toContain("normal again at about 24 Oct 2026, 13:00 Europe/Athens");
    expect(text).toContain("Tokens: Claude Max 0/2 with room");
    expect(text).toContain("serves Nous: 5-hour: 100% used");
    expect(text).toContain("$28.50 / $100.00 spent, $71.50 left");
    expect(text).toContain("Nous last hour $12.30 API value (7 turns, 1 unpriced)");
    expect(text).toContain("CODEX codex · ACTIVE: 5-hour: 42% used");
  });

  it("selects Sonnet in LOW and Haiku in CRITICAL for automatic turns without rewriting configured models", () => {
    const settings = nousSettingsSchema.parse({});
    const models = structuredClone(settings.models);
    expect(settings.lowSpend).toMatchObject({ mode: "AUTO", maxTurnsPerHour: 6, minMaxAccountsWithRoom: 2, roomRemainingPercent: 10 });
    for (const mode of ["LOW", "CRITICAL"] as const) {
      for (const reason of ["INBOX", "STANDING", "HEARTBEAT", "REVIEW", "HELPER"] as const) expect(nousTokenModel(settings, reason, mode)).toEqual({ model: mode === "LOW" ? "claude-sonnet-5-5" : "claude-haiku-5-5", effort: "medium" });
      for (const reason of ["OPERATOR", "DECISION"] as const) expect(nousTokenModel(settings, reason, mode)).toEqual({ model: "claude-fable-5-1", effort: "high" });
    }
    expect(settings.models).toEqual(models);
    settings.models.operator.effort = "low";
    settings.lowSpend.models.helper = { model: "claude-haiku-5-5", effort: "low" };
    expect(nousTokenModel(settings, "OPERATOR", "LOW").effort).toBe("low");
    expect(nousTokenModel(settings, "HELPER", "LOW")).toEqual(settings.lowSpend.models.helper);
    expect(nousTokenModel(settings, "INBOX", "NORMAL")).toEqual(settings.models.inbox);
    expect(nousLowSpendSettingsSchema.safeParse({ lowBudgetRemainingPercent: 20, criticalBudgetRemainingPercent: 40 }).success).toBe(false);
  });

  it("honors per-kind LOW and CRITICAL choices and recovers the normal models without changing stored settings", () => {
    const settings = nousSettingsSchema.parse({ lowSpend: {
      models: { inbox: { model: "claude-haiku-5-5", effort: "low" } },
      criticalModels: { inbox: { model: "claude-sonnet-5-5", effort: "low" }, standing: { model: "claude-opus-5-5", effort: "medium" }, helper: { model: "claude-fable-5-1", effort: "low" } }
    } });
    const stored = structuredClone(settings);
    for (const reason of ["INBOX", "STANDING", "HEARTBEAT", "REVIEW", "HELPER"] as const) {
      const kind = reason === "INBOX" ? "inbox" : reason === "HELPER" ? "helper" : "standing";
      expect(nousTokenModel(settings, reason, "LOW")).toEqual(stored.lowSpend.models[kind]);
      expect(nousTokenModel(settings, reason, "CRITICAL")).toEqual(stored.lowSpend.criticalModels[kind]);
      expect(nousTokenModel(settings, reason, "NORMAL")).toEqual(stored.models[kind]);
    }
    expect(settings).toEqual(stored);
    const detail = renderNousTokens(compute([account("a", 100)], { budget: budget(90) }), "Asia/Bangkok", now, { settings, reason: "REVIEW" });
    expect(detail.split("\n")[0]).toContain("model: Opus 5.5 (medium) for REVIEW");
  });

  it("uses configured automatic models when the cheaper-model switch is off and restores every kind on recovery", () => {
    const settings = nousSettingsSchema.parse({ lowSpend: { cheaperModel: false } });
    settings.models.inbox = { model: "claude-opus-5-5", effort: "xhigh" };
    const original = structuredClone(settings.models);
    for (const mode of ["LOW", "CRITICAL", "NORMAL"] as const) {
      for (const reason of ["INBOX", "STANDING", "HEARTBEAT", "REVIEW", "HELPER"] as const) {
        const kind = reason === "INBOX" ? "inbox" : reason === "HELPER" ? "helper" : "standing";
        expect(nousTokenModel(settings, reason, mode)).toEqual(settings.models[kind]);
      }
    }
    settings.lowSpend.cheaperModel = true;
    for (const reason of ["OPERATOR", "DECISION", "INBOX", "STANDING", "HEARTBEAT", "REVIEW", "HELPER"] as const) {
      const kind = reason === "OPERATOR" ? "operator" : reason === "DECISION" ? "decision" : reason === "INBOX" ? "inbox" : reason === "HELPER" ? "helper" : "standing";
      for (const mode of ["LOW", "CRITICAL", "NORMAL"] as const) nousTokenModel(settings, reason, mode);
      expect(nousTokenModel(settings, reason, "NORMAL")).toEqual(original[kind]);
    }
    expect(settings.models).toEqual(original);
  });

  it("names the selected model for each turn and the automatic selections in token detail", () => {
    const settings = nousSettingsSchema.parse({});
    const state = compute([account("a", 100)], { budget: budget(90) });
    expect(renderNousTokens(state, "Asia/Bangkok", now, { settings, reason: "REVIEW" }).split("\n")[0]).toContain("model: Haiku 5.5 (medium) for REVIEW");
    expect(renderNousTokens({ ...state, mode: "LOW" }, "Asia/Bangkok", now, { settings, reason: "HELPER" }).split("\n")[0]).toContain("model: Sonnet 5.5 (medium) for HELPER");
    expect(renderNousTokens(state, "Asia/Bangkok", now, { settings, reason: "OPERATOR" }).split("\n")[0]).toContain("model: Fable 5.1 (high) for OPERATOR");
    expect(renderNousTokens({ ...state, mode: "NORMAL" }, "Asia/Bangkok", now, { settings, reason: "INBOX" }).split("\n")[0]).toContain("model: Fable 5.1 (high) for INBOX");
    settings.lowSpend.cheaperModel = false;
    const detail = renderNousTokens(state, "Asia/Bangkok", now, { settings, reason: "INBOX" });
    expect(detail.split("\n")[0]).toContain("model: Fable 5.1 (high) for INBOX");
    expect(detail).toContain("Cheaper model in low-spend mode: off. Automatic selections: inbox: Fable 5.1 (high)");
  });

  it("caps LOW at one concurrent helper, CRITICAL at none, and returns to normal admission after recovery", async () => {
    let mode: NousSpendMode = "LOW";
    let finish!: () => void;
    const run = vi.fn(() => new Promise<{ text: string; isError: boolean }>((resolve) => { finish = () => resolve({ text: "done", isError: false }); }));
    const helpers = createNousSubagents({ run, answerMs: 5, parent: () => ({ deadline: Date.now() + 20 * 60_000, signal: new AbortController().signal }), tokenMode: async () => mode });
    const tasks = [{ title: "check", instructions: "check" }];
    const first = helpers.run("owner", "turn", tasks);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await helpers.run("owner", "turn", tasks)).toMatchObject({ refused: expect.stringContaining("At most 1") });
    finish();
    const result = await first;
    if (!("runId" in result)) throw new Error("Expected a helper run");
    await helpers.wait("owner", result.runId);
    mode = "CRITICAL";
    expect(await helpers.run("owner", "turn", tasks)).toMatchObject({ refused: expect.stringContaining("CRITICAL") });
    expect(await helpers.wait("owner", result.runId)).toMatchObject({ done: true });
    mode = "NORMAL";
    const normal = helpers.run("owner", "turn", tasks);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2)); finish(); await normal;
  });

  it("deduplicates concurrent transition reads, preserves since, and emits recovery exactly once", async () => {
    let at = now;
    let mode: NousSpendMode = "NORMAL";
    const transition = vi.fn(async () => {});
    const monitor = createNousTokenMonitor({ read: async () => ({ ...compute(null, { now: at }), mode }), transition });
    await monitor.read("owner");
    mode = "LOW"; at += 1000;
    const low = await Promise.all([monitor.read("owner"), monitor.read("owner")]);
    expect(transition).toHaveBeenCalledTimes(1);
    at += 1000;
    expect((await monitor.read("owner")).since).toBe(low[0]!.since);
    mode = "CRITICAL"; await monitor.read("owner");
    mode = "NORMAL"; await monitor.read("owner"); await monitor.read("owner");
    expect(transition.mock.calls.map((call) => [call[1], call[2].mode])).toEqual([["NORMAL", "LOW"], ["LOW", "CRITICAL"], ["CRITICAL", "NORMAL"]]);
  });

  it("reads existing local samples and peeks profiles without probing, even when stale", async () => {
    const readUsage = vi.fn(async () => ({ status: "CONNECTED" as const, email: "main@example.com", plan: "max", fiveHourUsedPercent: 85,
      fiveHourResetAt: reset, weeklyUsedPercent: 10, weeklyResetAt: weeklyReset, weeklyScope: null }));
    const provider = createClaudeUsageAccountProvider({ listProfiles: async () => [{ profileId: "main", displayName: "Main" }], readUsage, now: () => new Date(now) });
    expect(provider.peek()).toBeNull(); await provider();
    const listAccounts = vi.fn(async () => ({ data: [account("main", 100)] }));
    const state = await readNousTokens({ admin: { listAccounts }, profiles: provider.peek(), settings: config, now: now + 20 * 60_000 });
    expect(state.mode).toBe("LOW");
    expect(readUsage).toHaveBeenCalledTimes(1);
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect((await readNousTokens({ settings: config, now })).accounts).toBeNull();
  });
});
