import { describe, expect, it, vi } from "vitest";
import { NOUS_TURN_KINDS, gatewayWeekPace, type ApiProviderAccount, nousLowSpendSettingsSchema, nousSettingsSchema, type ClaudeUsageAccountList, type GatewayAccount, type NousSpendMode } from "@space/contracts";
import { createClaudeUsageAccountProvider } from "../src/claude-usage-services.js";
import { createApiProviderAccountProvider } from "../src/api-provider-balance-services.js";
import { computeNousTokens, createNousTokenMonitor, NOUS_MODE_HOLD_MS, type NousHeldMode, nousProviderAdvice, nousProviderRooms, nousProviderRoomText, nousTokenModel, readNousTokens, renderNousTokens, renderNousTokenSummary } from "../src/nous/tokens.js";
import { createNousSubagents } from "../src/nous/subagents.js";

const claudeSettings = (value: Record<string, unknown> = {}) => nousSettingsSchema.parse({ provider: "claude",
  models: Object.fromEntries(NOUS_TURN_KINDS.map((kind) => [kind, { model: "claude-fable-5-1", effort: ["operator", "decision", "goal"].includes(kind) ? "max" : "high" }])), ...value });
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
// 88% of the week used 25 hours before its reset: at that pace it runs out first, so no room of it would reset unused.
const spentWeek = { secondaryWindow: { usedPercent: 88, resetAt: weeklyReset, windowMinutes: 10080 } };

describe("Nous automatic low-spend policy", () => {
  it("uses the selected provider's quota and honors weekly-only Codex accounts", () => {
    const accounts = [account("claude", 100), account("codex-a", 5, { provider: "CODEX", planType: "pro" }),
      account("codex-b", 10, { provider: "CODEX", planType: "prolite", primaryWindow: { usedPercent: null, resetAt: null, windowMinutes: 300 } })];
    expect(compute(accounts, { provider: "codex" })).toMatchObject({ mode: "NORMAL", max: { withRoom: 2, total: 2 } });
    expect(compute(accounts, { provider: "claude" }).mode).toBe("CRITICAL");
    accounts[1]!.secondaryWindow.usedPercent = 100;
    accounts[2]!.secondaryWindow.usedPercent = 100;
    expect(compute(accounts, { provider: "codex" }).mode).toBe("CRITICAL");
  });

  it("keeps low-spend turns on Codex and restores the exact saved normal selection", () => {
    const settings = nousSettingsSchema.parse({ provider: "codex", models: { operator: { model: "gpt-6.1-terra", effort: "xhigh" } } });
    const stored = structuredClone(settings);
    expect(nousTokenModel(settings, "INBOX", "LOW")).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
    expect(nousTokenModel(settings, "INBOX", "CRITICAL")).toEqual({ model: "gpt-6-luna", effort: "medium" });
    expect(nousTokenModel(settings, "OPERATOR", "LOW")).toEqual({ model: "gpt-6.1-terra", effort: "high" });
    expect(nousTokenModel(settings, "OPERATOR", "NORMAL")).toEqual(stored.models.operator);
    expect(settings).toEqual(stored);
  });

  // Operator 8/11 (ops 100%→24%, Nous 43% of it on Opus xhigh): a goal turn's "auto" runs the balanced class; an explicit model and other kinds stay.
  it("runs a goal turn's auto on the balanced class without changing stored settings", () => {
    const settings = nousSettingsSchema.parse({ provider: "space", models: Object.fromEntries(NOUS_TURN_KINDS.map((kind) => [kind, { model: "auto", effort: "auto" }])) });
    const stored = structuredClone(settings);
    for (const mode of ["NORMAL", "LOW"] as const) expect(nousTokenModel(settings, "GOAL", mode)).toEqual({ model: "auto-balanced", effort: "auto" });
    expect(nousTokenModel(settings, "OPERATOR", "NORMAL")).toEqual({ model: "auto", effort: "auto" });
    expect(settings).toEqual(stored);
    settings.models.goal = { model: "claude:claude-opus-5-5", effort: "xhigh" };
    expect(nousTokenModel(settings, "GOAL", "NORMAL")).toEqual(settings.models.goal);
  });

  it("counts Max accounts at the 10% room boundary and recovers at reset without a new sample", () => {
    expect(compute([account("main", 90), account("other", 90)]).mode).toBe("NORMAL");
    // main, the one with room, runs its week out by the reset (88% with 25 hours left): nothing of it resets unused, so one account with room is
    // LOW. At the 5-hour reset other has room with a week it would not use up: NORMAL (operator 5/11).
    const accounts = [account("main", 90, spentWeek), account("other", 90.01)];
    expect(compute(accounts)).toMatchObject({ mode: "LOW", max: { withRoom: 1, total: 2 }, servingAccountId: "main", resetAt: reset });
    expect(compute(accounts, { now: Date.parse(reset) })).toMatchObject({ mode: "NORMAL" });
    expect(compute([account("a", 100), account("b", 100)], { settings: { ...config, mode: "OFF" }, budget: budget(99) }).mode).toBe("NORMAL");
    expect(compute([account("a"), account("b")], { settings: { ...config, mode: "ON" } })).toMatchObject({ mode: "LOW", resetAt: null });
  });

  // Operator rule 2026-10-27: the API key never serves Claude Code, so CRITICAL is no Max account with room, whatever the budget.
  it("is CRITICAL when no Max account has room, whatever the API budget", () => {
    const full = [account("a"), account("b")];
    expect(compute(full, { budget: budget(99) }).mode).toBe("NORMAL");
    // At the 5-hour reset a has room and a week it would not use up: NORMAL again then (operator 5/11).
    expect(compute([account("a", 100)], { budget: budget(0) })).toMatchObject({ mode: "CRITICAL", resetAt: reset });
    // With a week it runs out, the 5-hour reset leaves it short (LOW); its fresh week at the weekly reset is NORMAL (6/11: the count needs a shortfall).
    expect(compute([account("a", 100, spentWeek)], { budget: budget(0) })).toMatchObject({ mode: "CRITICAL", resetAt: weeklyReset });
    expect(compute([account("a", 100)]).mode).toBe("CRITICAL");
    const recover = compute([account("a", 100), account("b", 100)], { budget: budget(20) });
    expect(recover).toMatchObject({ mode: "CRITICAL", resetAt: reset });
    expect(compute(full, { budget: budget(80) }).resetAt).toBeNull();
    // A used-up week leaves no room even when the 5-hour window has some; an unknown week does not take it away.
    const week = (usedPercent: number | null) => ({ secondaryWindow: { usedPercent, resetAt: weeklyReset, windowMinutes: 10080 } });
    expect(compute([account("a", 10, week(95)), account("b", 10, week(100))]).mode).toBe("CRITICAL");
    // (b's week is under pace: 90% used with 85% of it passed would run out before its reset, which is LOW since goal d844e0cc.)
    expect(compute([account("a", 10, week(null)), account("b", 10, week(80))]).mode).toBe("NORMAL");
  });

  it.each([
    { withRoom: 5, spentUsd: 365, mode: "NORMAL", resetAt: null },
    { withRoom: 1, spentUsd: 365, mode: "LOW", resetAt: reset },
    { withRoom: 0, spentUsd: 100, mode: "CRITICAL", resetAt: reset }
  ])("returns $mode with $withRoom/5 Max accounts with room and $spentUsd/$500 spent", ({ withRoom, spentUsd, mode, resetAt }) => {
    // The accounts with room run their weeks out by the reset (88% with 25 hours left), so their count decides; with all five the weeks have room.
    const accounts = Array.from({ length: 5 }, (_, index) => account(String(index), index < withRoom ? 5 : 100, index < withRoom && withRoom < 5 ? spentWeek : {}));
    const state = compute(accounts, { budget: { budgetUsd: 500, spentUsd } });
    expect(state).toMatchObject({ mode, max: { withRoom, total: 5 }, resetAt });
    expect(compute(accounts, { now: Date.parse(reset), budget: { budgetUsd: 500, spentUsd } })).toMatchObject({ mode: "NORMAL", resetAt: null });
  });

  it("estimates recovery at the Max reset that restores enough room, even beyond the month boundary", () => {
    const laterReset = "2026-11-01T10:00:00.000Z";
    const accounts = [account("a", 100, spentWeek), account("b", 100, { ...spentWeek, primaryWindow: { usedPercent: 100, resetAt: laterReset, windowMinutes: 300 } })];
    const state = compute(accounts, { budget: budget(85) });
    expect(state).toMatchObject({ mode: "CRITICAL", nextResetAt: reset, resetAt: laterReset });
    expect(renderNousTokens(state, "Asia/Bangkok", now)).toContain("normal again at about 1 Nov 2026, 17:00 Asia/Bangkok");
  });

  it("excludes paused, reauth, free, API and non-Max accounts; unknown samples never masquerade as room", () => {
    const accounts = [account("a", 100), account("paused", 0, { status: "PAUSED" }), account("reauth", 0, { status: "REAUTH_REQUIRED" }),
      account("api", 0, { planType: "api" }), account("free", 0, { planType: "free" }), account("pro", 0, { planType: "pro" }),
      account("unknown", 0, { primaryWindow: { usedPercent: null, resetAt: null, windowMinutes: 300 } })];
    expect(compute(accounts)).toMatchObject({ mode: "CRITICAL", max: { total: 2, withRoom: 0 } });
    expect(compute(null)).toMatchObject({ mode: "NORMAL", max: null });
    expect(compute(null, { budget: budget(90) }).mode).toBe("NORMAL");
    expect(compute([], { budget: budget(90) }).mode).toBe("CRITICAL");
    expect(compute([account("a", 95), account("b", 95)], { settings: { ...config, minMaxAccountsWithRoom: 1, roomRemainingPercent: 5 } }).mode).toBe("NORMAL");
  });

  // Operator goal 2026-10-27 (plan clipboard:nUloPOH3blDT step 2): every account's tokens used without running out before the weekly reset.
  it("shows each Max and Codex account's weekly pace, and a Codex week reported first as its 7-day window, never as its 5-hour", () => {
    const inTwoDays = new Date(now + 2 * 86_400_000).toISOString();
    const week = (usedPercent: number | null) => ({ secondaryWindow: { usedPercent, resetAt: inTwoDays, windowMinutes: 10080 } });
    // 2 of 7 days left: 71% of the week passed.
    expect(gatewayWeekPace(account("a", 10, week(54)), now)).toEqual({ usedPercent: 54, passedPercent: 71, points: -17, resetAt: inTwoDays, pace: "UNDER" });
    expect(gatewayWeekPace(account("a", 10, week(75)), now)).toMatchObject({ points: 4, pace: "ON" });
    expect(gatewayWeekPace(account("a", 10, week(80)), now)).toMatchObject({ points: 9, pace: "AHEAD" });
    expect(gatewayWeekPace(account("a", 10, week(null)), now)).toMatchObject({ points: null, pace: null });
    expect(gatewayWeekPace(account("a", 10, { secondaryWindow: { usedPercent: 50, resetAt: new Date(now - 1).toISOString(), windowMinutes: 10080 } }), now)).toBeNull();
    // niggmopai (prolite): Gateway reports only the weekly window, as the primary one.
    const prolite = account("niggmopai", 8, { provider: "CODEX", planType: "prolite", primaryWindow: { usedPercent: 8, resetAt: inTwoDays, windowMinutes: 10080 },
      secondaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null } });
    const plus = account("ntheogr", 49, { provider: "CODEX", planType: "plus", ...week(80) });
    const paused = account("free", 0, { provider: "CODEX", planType: "free", status: "PAUSED" });
    const state = compute([account("ntheo", 10, week(54)), prolite, plus, paused]);
    const text = renderNousTokens(state, "Asia/Bangkok", now);
    expect(text).toContain("Codex 5-hour niggmopai none, ntheogr 49%;");
    expect(text).toContain("weekly pace (7-day used/week passed, points, reset in Asia/Bangkok; today used/allowance, background work HELD at it): Claude ntheo 54%/71% -17 UNDER 26 Oct, 16:00; Codex niggmopai 8%/71% -63 UNDER 26 Oct, 16:00, ntheogr 80%/71% +9 AHEAD 26 Oct, 16:00;");
    expect(text).toContain("- CODEX niggmopai · ACTIVE: 7-day: 8% used; reset 26 Oct 2026, 16:00 Asia/Bangkok; week passed 71%, pace -63 UNDER");
    expect(text).not.toContain("niggmopai · ACTIVE: 5-hour");
    expect(text).toContain("- CLAUDE ntheo · ACTIVE: 5-hour: 10% used; reset 24 Oct 2026, 17:00 Asia/Bangkok; 7-day: 54% used; reset 26 Oct 2026, 16:00 Asia/Bangkok; week passed 71%, pace -17 UNDER");
    // After Gateway moved niggmopai's week to the weekly slot, PostgreSQL keeps the blanked 5-hour slot's length: it is no window.
    const moved = account("niggmopai", 8, { provider: "CODEX", planType: "prolite", primaryWindow: { usedPercent: null, resetAt: null, windowMinutes: 10080 },
      secondaryWindow: { usedPercent: 8, resetAt: inTwoDays, windowMinutes: 10080 } });
    expect(gatewayWeekPace(moved, now)).toMatchObject({ usedPercent: 8, points: -63 });
    expect(renderNousTokens(compute([moved]), "Asia/Bangkok", now)).toContain("- CODEX niggmopai · ACTIVE: 7-day: 8% used; reset 26 Oct 2026, 16:00 Asia/Bangkok; week passed 71%, pace -63 UNDER");
    expect(text).not.toMatch(/free · PAUSED[^\n]*pace/);
  });

  // Plan clipboard:DotwYXVD2N3n: today's allowance = (100 - used % when the day began) / days left; 2 days left, so the day began now.
  it("shows each account's use today against today's allowance, HELD once it is used", () => {
    const inTwoDays = new Date(now + 2 * 86_400_000).toISOString();
    const week = (usedPercent: number, startedAt: number) => ({ secondaryWindow: { usedPercent, resetAt: inTwoDays, windowMinutes: 10080 }, paceDayStart: { at: now, usedPercent: startedAt } });
    const text = renderNousTokens(compute([account("ntheo", 10, week(54, 50)), account("ntheogr", 49, { provider: "CODEX", planType: "plus", ...week(80, 40) })]), "Asia/Bangkok", now);
    expect(text).toContain("Claude ntheo 54%/71% -17 UNDER 26 Oct, 16:00 today 4%/25%; Codex ntheogr 80%/71% +9 AHEAD 26 Oct, 16:00 today 40%/30% HELD;");
    expect(text).toContain("week passed 71%, pace +9 AHEAD; today used/allowance 40%/30% HELD");
  });

  it("shows account windows, local resets, API spend/budget and last-hour cost", () => {
    const state = compute([account("main", 100), account("other", 100), account("codex", 42, { provider: "CODEX" })],
      { budget: budget(28.5), lastHour: { costUsd: 12.3, turns: 7, unpricedTurns: 1 } });
    const text = renderNousTokens(state, "Europe/Athens", now);
    expect(text).toMatch(/^Low-spend mode: CRITICAL since/);
    expect(text).toContain("normal again at about 24 Oct 2026, 13:00 Europe/Athens");
    expect(text).toContain("Tokens: Claude Max 0/2 with room");
    expect(text).toContain("serves Nous: 5-hour: 100% used");
    expect(text).toContain("$28.50 / $100.00 spent, $71.50 left");
    expect(text).toContain("Nous last hour $12.30 API value (7 turns, 1 unpriced)");
    expect(text).toContain("CODEX codex · ACTIVE: 5-hour: 42% used");
  });

  it("selects Sonnet in LOW and Haiku in CRITICAL for automatic turns without rewriting configured models", () => {
    const settings = claudeSettings({});
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
    const settings = claudeSettings({ lowSpend: {
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
    const settings = claudeSettings({ lowSpend: { cheaperModel: false } });
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
    const settings = claudeSettings({});
    const state = compute([account("a", 100)], { budget: budget(90) });
    expect(renderNousTokens(state, "Asia/Bangkok", now, { settings, reason: "REVIEW" }).split("\n")[0]).toContain("model: Haiku 5.5 (medium) for REVIEW");
    expect(renderNousTokens({ ...state, mode: "LOW" }, "Asia/Bangkok", now, { settings, reason: "HELPER" }).split("\n")[0]).toContain("model: Sonnet 5.5 (medium) for HELPER");
    expect(renderNousTokens(state, "Asia/Bangkok", now, { settings, reason: "OPERATOR" }).split("\n")[0]).toContain("model: Fable 5.1 (high) for OPERATOR");
    expect(renderNousTokens({ ...state, mode: "NORMAL" }, "Asia/Bangkok", now, { settings, reason: "INBOX" }).split("\n")[0]).toContain("model: Fable 5.1 (high) for INBOX");
    settings.lowSpend.cheaperModel = false;
    const detail = renderNousTokens(state, "Asia/Bangkok", now, { settings, reason: "INBOX" });
    expect(detail.split("\n")[0]).toContain("model: Fable 5.1 (high) for INBOX");
    expect(detail).toContain("Cheaper model in low-spend mode: off. Automatic selections: inbox: Fable 5.1 (high)");
    // Operator nous_msg:5ba7a146: effort none is never named.
    settings.models.inbox = { model: "claude-haiku-5-5", effort: "none" };
    expect(renderNousTokens({ ...state, mode: "NORMAL" }, "Asia/Bangkok", now, { settings, reason: "INBOX" }).split("\n")[0]).toContain("model: Haiku 5.5 for INBOX");
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
    const asked = await Promise.all([monitor.read("owner"), monitor.read("owner")]);
    expect(asked[0]).toMatchObject({ mode: "NORMAL", pending: { mode: "LOW" } });
    expect(transition).not.toHaveBeenCalled();
    at += NOUS_MODE_HOLD_MS;
    const low = [await monitor.read("owner")];
    expect(transition).toHaveBeenCalledTimes(1);
    at += 1000;
    expect((await monitor.read("owner")).since).toBe(low[0]!.since);
    mode = "CRITICAL"; await monitor.read("owner");
    mode = "NORMAL"; await monitor.read("owner"); await monitor.read("owner");
    expect(transition.mock.calls.map((call) => [call[1], call[2].mode])).toEqual([["NORMAL", "LOW"], ["LOW", "CRITICAL"], ["CRITICAL", "NORMAL"]]);
  });

  // Operator 5/11: 79 Low-spend changes since 27/10 (27 on 1/11), and a restart's first sample counted as one.
  it("changes NORMAL and LOW only once the new mode held 30 minutes, across restarts; CRITICAL at once", async () => {
    let at = now;
    let mode: NousSpendMode = "NORMAL";
    const stored = new Map<string, NousHeldMode>();
    const held = { load: async (owner: string) => stored.get(owner) ?? null, save: async (owner: string, value: NousHeldMode) => { stored.set(owner, value); } };
    const transition = vi.fn(async () => {});
    const monitor = () => createNousTokenMonitor({ read: async () => ({ ...compute(null, { now: at }), mode }), transition, held });
    const first = monitor();
    await first.read("owner");
    // LOW and NORMAL flapping every 10 minutes never changes the mode.
    for (const next of ["LOW", "NORMAL", "LOW", "NORMAL"] as const) { mode = next; at += 10 * 60_000; await first.read("owner"); }
    expect(transition).not.toHaveBeenCalled();
    mode = "LOW"; at += 60_000;
    expect(await first.read("owner")).toMatchObject({ mode: "NORMAL", pending: { mode: "LOW", since: new Date(at).toISOString() } });
    // A restart in the middle keeps the ask's start: 30 minutes after it, not after the restart.
    const second = monitor();
    at += 20 * 60_000;
    expect((await second.read("owner")).mode).toBe("NORMAL");
    at += 10 * 60_000;
    expect((await second.read("owner")).mode).toBe("LOW");
    expect(transition.mock.calls.map((call) => [call[1], call[2].mode])).toEqual([["NORMAL", "LOW"]]);
    // Back to NORMAL waits too, and says when; CRITICAL comes and goes at once.
    mode = "NORMAL"; at += 60_000;
    const waiting = await monitor().read("owner");
    expect(waiting).toMatchObject({ mode: "LOW", pending: { mode: "NORMAL" }, resetAt: new Date(at + NOUS_MODE_HOLD_MS).toISOString() });
    expect(renderNousTokenSummary(waiting, "UTC", at)).toContain("the samples ask NORMAL since");
    mode = "CRITICAL"; at += 60_000;
    expect((await second.read("owner")).mode).toBe("CRITICAL");
    mode = "NORMAL"; at += 60_000;
    expect((await second.read("owner")).mode).toBe("NORMAL");
    expect(transition.mock.calls.map((call) => [call[1], call[2].mode])).toEqual([["NORMAL", "LOW"], ["LOW", "CRITICAL"], ["CRITICAL", "NORMAL"]]);
  });

  it("reads existing local samples and peeks profiles without probing, even when stale", async () => {
    const readUsage = vi.fn(async () => ({ status: "CONNECTED" as const, email: "main@example.com", plan: "max", fiveHourUsedPercent: 85,
      fiveHourResetAt: reset, weeklyUsedPercent: 10, weeklyResetAt: weeklyReset, weeklyScope: null }));
    const provider = createClaudeUsageAccountProvider({ listProfiles: async () => [{ profileId: "main", displayName: "Main" }], readUsage, now: () => new Date(now) });
    expect(provider.peek()).toBeNull(); await provider();
    const listAccounts = vi.fn(async () => ({ data: [account("main", 100)] }));
    const state = await readNousTokens({ admin: { listAccounts }, profiles: provider.peek(), settings: config, now: now + 20 * 60_000 });
    expect(state.mode).toBe("CRITICAL");
    expect(readUsage).toHaveBeenCalledTimes(1);
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect((await readNousTokens({ settings: config, now })).accounts).toBeNull();
  });
});

// Goal d844e0cc (4/11 18:20 BKK): Low-spend read NORMAL while the Provider advice said Claude Max runs out before its weekly reset.
describe("Nous low-spend mode and the Claude Max pool's weekly pace", () => {
  const at = Date.parse("2026-11-04T11:20:00Z");
  const max = (id: string, fiveHour: number, fiveHourReset: string, week: number, weekReset: string) => account(id, fiveHour, {
    primaryWindow: { usedPercent: fiveHour, resetAt: fiveHourReset, windowMinutes: 300 }, secondaryWindow: { usedPercent: week, resetAt: weekReset, windowMinutes: 10080 } });
  const unsampled = { usedPercent: null, resetAt: null, windowMinutes: null };
  // The stable sample of 4/11 18:20 BKK; `weeks` replaces the weekly figures.
  const sample = (weeks: Partial<Record<"ntheo" | "lab" | "dev" | "crew" | "ops", number>> = {}) => [
    max("ntheo", 15, "2026-11-04T14:30:00Z", weeks.ntheo ?? 95, "2026-11-05T02:00:00Z"),
    max("lab", 99, "2026-11-04T12:10:00Z", weeks.lab ?? 93, "2026-11-05T21:00:00Z"),
    max("dev", 97, "2026-11-04T13:30:00Z", weeks.dev ?? 92, "2026-11-05T23:00:00Z"),
    max("crew", 57, "2026-11-04T13:20:00Z", weeks.crew ?? 60, "2026-11-08T19:00:00Z"),
    max("ops", 87, "2026-11-04T15:30:00Z", weeks.ops ?? 75, "2026-11-08T10:00:00Z"),
    // Three Gemini (Antigravity) accounts with their windows long reset: all their room.
    ...["agy-a", "agy-b", "agy-c"].map((id) => account(id, 0, { provider: "ANTIGRAVITY", planType: "google-ai-pro", primaryWindow: unsampled, secondaryWindow: unsampled, quotaGroups: [{ key: "gemini",
      primaryWindow: { usedPercent: 0, resetAt: "2026-10-16T02:06:52Z", windowMinutes: 300 }, secondaryWindow: { usedPercent: 0, resetAt: "2026-10-22T21:06:53Z", windowMinutes: 10080 } }] }))
  ];
  const space = nousSettingsSchema.parse({ provider: "space", models: Object.fromEntries(NOUS_TURN_KINDS.map((kind) => [kind, { model: "auto", effort: "high" }])) });
  const tokens = (accounts: GatewayAccount[], provider: "claude" | "space") =>
    computeNousTokens({ accounts, profiles, settings: config, now: at, provider, spaceProviders: ["claude", "codex", "gemini"] });
  const background = ["INBOX", "STANDING", "HELPER"] as const;

  it("is LOW while Claude Max runs out before its reset, though Gemini has all its room, and background turns take the LOW models", () => {
    // The 4/11 sample with every week resetting with crew's: no account gets a fresh week before the pool's last reset.
    const accounts = sample().map((entry) => entry.provider === "CLAUDE" ? { ...entry, secondaryWindow: { ...entry.secondaryWindow, resetAt: "2026-11-08T19:00:00Z" } } : entry);
    const rooms = nousProviderRooms(accounts, null, at);
    expect(rooms.find((room) => room.key === "claude")).toMatchObject({ nowLeft: 40, atReset: { percent: 0 }, pace: "AHEAD" });
    expect(rooms.find((room) => room.key === "gemini")).toMatchObject({ nowLeft: 100, atReset: null });
    expect(nousProviderAdvice(rooms).avoid.map(({ room, why }) => [room.key, why])).toContainEqual(["claude", "runs out before its reset"]);
    // Two Max accounts still have 5-hour and weekly room (crew, ops): room alone said NORMAL.
    expect(tokens(accounts, "claude")).toMatchObject({ mode: "LOW", max: { withRoom: 2, total: 5 } });
    // Claude serves first in the Gateway order, so its mode is the Space provider's, not Gemini's NORMAL.
    const state = tokens(accounts, "space");
    expect(state.mode).toBe("LOW");
    for (const reason of background) expect(nousTokenModel(space, reason, state.mode)).toEqual({ model: "auto-balanced", effort: "medium" });
    expect(nousTokenModel(space, "OPERATOR", state.mode)).toEqual({ model: "auto", effort: "high" });
    expect(nousTokenModel(space, "DECISION", state.mode)).toEqual({ model: "auto", effort: "high" });
    // Stable's order names all four routes; Claude via OpenCode has no quota mode of its own (5/11: the world had hidden it).
    expect(computeNousTokens({ accounts, profiles, settings: config, now: at, provider: "space", spaceProviders: ["claude", "codex", "opencode", "gemini"] }).serving)
      .toBe("Space Gateway routes in the provider order (claude LOW, codex CRITICAL, Claude via OpenCode (API key, paid per token), gemini NORMAL); each pool's routing picks the account");
    // A route with no room is passed over: Claude with every 5-hour window full leaves the turn to Gemini (Codex has no account).
    const full = accounts.map((entry) => entry.provider === "CLAUDE" ? { ...entry, primaryWindow: { ...entry.primaryWindow, usedPercent: 100 } } : entry);
    expect(tokens(full, "claude").mode).toBe("CRITICAL");
    expect(tokens(full, "space")).toMatchObject({ mode: "NORMAL", noRoom: ["claude", "codex"] });
  });

  // 5/11 (operator 10:17 BKK, nothing ran all night): LOW at 05:19 and 10:05 BKK on "0% at the weekly reset 12 Nov". ops' 165% and
  // crew's 140% projections erased ntheo's empty week, and lab's and dev's fresh weeks of 6/11 counted nothing. Stable's sample of 03:20 UTC.
  it("counts each account at most used up and the fresh weeks before the pool's last reset: NORMAL on 5/11's pool", () => {
    const now5 = Date.parse("2026-11-05T03:20:00Z");
    const accounts = [
      max("crew", 0, "2026-11-05T01:00:00Z", 67, "2026-11-08T18:59:59.911Z"),
      max("dev", 28, "2026-11-05T07:00:00Z", 98, "2026-11-05T23:00:00Z"),
      { ...max("lab", 2, "2026-11-05T07:00:00Z", 100, "2026-11-05T21:00:00.406Z"), status: "RATE_LIMITED" as const },
      max("ntheo", 0, "2026-11-05T08:00:00Z", 0, "2026-11-12T02:00:00.812Z"),
      max("ops", 0, "2026-11-05T01:00:00Z", 88, "2026-11-08T10:00:00.102Z")
    ];
    const claude = nousProviderRooms(accounts, null, now5).find((room) => room.key === "claude")!;
    // Not 0: lab's and dev's fresh weeks count. 30 at each account's own pace; the pool's whole pace (7/11, nous_msg:e768734b: the spent
    // accounts' load moves to the ones with room) fills ntheo's empty week and the fresh weeks too, and leaves 5.
    expect(claude.atReset).toEqual({ percent: 5, resetAt: "2026-11-12T02:00:00.812Z" });
    expect(nousProviderAdvice([claude]).avoid.map(({ why }) => why)).not.toContain("runs out before its reset");
    const state = (provider: "claude" | "space") => computeNousTokens({ accounts, profiles, settings: config, now: now5, provider, spaceProviders: ["claude", "codex", "gemini"] });
    // Operator 5/11 (nous_msg:3723fc28): dev's last 2% count as room, since lab's week resets in 18 h, before the pool's room runs out.
    expect(state("claude")).toMatchObject({ mode: "NORMAL", max: { withRoom: 4, total: 5 } });
    expect(state("space").mode).toBe("NORMAL");
    // The same pool with every week resetting on 12/11 has no fresh week coming: the pool's pace empties ntheo's week too.
    const together = accounts.map((entry) => ({ ...entry, secondaryWindow: { ...entry.secondaryWindow, resetAt: "2026-11-12T02:00:00.812Z" } }));
    expect(nousProviderRooms(together, null, now5).find((room) => room.key === "claude")!.atReset!.percent).toBe(0);
    // No reset for days: each week keeps its 10% (roomRemainingPercent), so dev's 2% are no room.
    expect(computeNousTokens({ accounts: together, profiles, settings: config, now: now5, provider: "claude" }).max).toEqual({ withRoom: 3, total: 5 });
  });

  // Daily token check 6/11: LOW 6/11 01:30-04:30 BKK on "1 of 5 with room" while ntheo had 52% of its week left and lab's fresh week came
  // at 04:00. Operator 5/11 (nous_msg:3723fc28): fewer accounts with room hold LOW only while the pool's room runs short before a reset.
  // 7/11 (nous_msg:e768734b): the 4 spent accounts' pace moves to ntheo and the fresh weeks, so this pool's week runs out before 12/11
  // (0% at reset, as 7/11 bore out: 3 of 5 spent): LOW by the Provider advice's figure (goal d844e0cc), whatever the count says.
  it("is LOW when the pool's whole pace runs out before its last reset, even with fresh weeks coming", () => {
    const at5 = Date.parse("2026-11-05T18:30:00Z");
    const accounts = [
      { ...max("crew", 100, "2026-11-05T19:59:00Z", 100, "2026-11-08T19:00:00Z"), status: "RATE_LIMITED" as const },
      max("dev", 0, "2026-11-05T22:00:00Z", 100, "2026-11-05T23:00:00Z"),
      max("lab", 0, "2026-11-05T22:00:00Z", 100, "2026-11-05T21:00:00Z"),
      max("ntheo", 52, "2026-11-05T19:10:00Z", 48, "2026-11-12T02:00:00Z"),
      { ...max("ops", 0, "2026-11-05T22:00:00Z", 100, "2026-11-08T10:00:00Z"), status: "RATE_LIMITED" as const }
    ];
    const mode = (pool: GatewayAccount[]) => computeNousTokens({ accounts: pool, profiles, settings: config, now: at5, provider: "claude" });
    expect(nousProviderRooms(accounts, null, at5).find((room) => room.key === "claude")!.atReset!.percent).toBe(0);
    expect(mode(accounts)).toMatchObject({ mode: "LOW", max: { withRoom: 1, total: 5 } });
    // ntheo's 5-hour window at 90% 40 minutes before its reset fills first at its pace: the count holds LOW.
    const hot = accounts.map((entry) => entry.id === "ntheo" ? { ...entry, primaryWindow: { ...entry.primaryWindow, usedPercent: 90 } } : entry);
    expect(mode(hot)).toMatchObject({ mode: "LOW", max: { withRoom: 1, total: 5 } });
  });

  it("stays NORMAL while the Claude Max pool is on pace", () => {
    // About three points under the share of each account's week that has passed.
    const accounts = sample({ ntheo: 88, lab: 77, dev: 76, crew: 35, ops: 40 });
    const claude = nousProviderRooms(accounts, null, at).find((room) => room.key === "claude")!;
    expect(claude.pace).toBe("ON");
    expect(claude.atReset!.percent).toBeGreaterThanOrEqual(1);
    expect(tokens(accounts, "claude").mode).toBe("NORMAL");
    const state = tokens(accounts, "space");
    expect(state.mode).toBe("NORMAL");
    for (const reason of background) expect(nousTokenModel(space, reason, state.mode)).toEqual({ model: "auto", effort: "high" });
  });
});

// Plan clipboard:mjpENip0ilmC (operator 31/10 13:12 BKK): Nous sees what every provider has left, the pickers' figure, and Space's advice.
describe("Nous provider room and advice", () => {
  const window = (usedPercent: number | null, resetAt: string | null, windowMinutes: number) => ({ usedPercent, resetAt, windowMinutes });
  const none = window(null, null, 300);
  // The week resets in 25 hours: 143 of its 168 hours have passed (85%).
  const pools = [
    account("max-a", 10, { secondaryWindow: window(88, weeklyReset, 10080) }),
    account("codex", 5, { provider: "CODEX", planType: "plus", secondaryWindow: window(20, weeklyReset, 10080) }),
    account("codex-paused", 100, { provider: "CODEX", planType: "free", status: "PAUSED" }),
    account("agy", 0, { provider: "ANTIGRAVITY", planType: "google-ai-pro", primaryWindow: none, secondaryWindow: { ...none, windowMinutes: null }, quotaGroups: [
      { key: "gemini", primaryWindow: window(10, reset, 300), secondaryWindow: window(50, weeklyReset, 10080) },
      { key: "claude", primaryWindow: window(0, reset, 300), secondaryWindow: window(0, weeklyReset, 10080) }] })
  ];
  const api = (providerId: string, label: string, status: ApiProviderAccount["status"], balance: string | null, remainingPercent?: number): ApiProviderAccount =>
    ({ id: providerId, providerId, label, status, balance, currency: "USD", remainingPercent, detail: null, sampledAt: new Date(now).toISOString() });
  const sample = { data: [api("openrouter", "OpenRouter", "CONNECTED", "$12.30", 41), api("deepseek", "DeepSeek", "EXHAUSTED", "$0.00"), api("openai", "OpenAI", "CONNECTED", "Configured")],
    pagination: { page: 1, pageSize: 3, totalItems: 3, totalPages: 1 }, source: "test", isStale: false, error: null, checkedAt: new Date(now).toISOString() };

  it("gives each pool its share left now and at the weekly reset at this pace, and each API key its balance", () => {
    const rooms = nousProviderRooms(pools, sample.data, now);
    const room = (key: string) => rooms.find((entry) => entry.key === key)!;
    // Claude Max: 88 used + 88/143 an hour for 25 hours runs out; 3 points ahead of the week is still ON.
    expect(room("claude")).toMatchObject({ provider: "claude", accounts: 1, nowLeft: 12, atReset: { percent: 0, resetAt: weeklyReset }, pace: "ON" });
    // The paused Codex account is not counted: 20 + 20/143 × 25 used at the reset leaves 77%.
    expect(room("codex")).toMatchObject({ accounts: 1, nowLeft: 80, atReset: { percent: 77 }, pace: "UNDER", points: -65 });
    expect(room("gemini")).toMatchObject({ provider: "gemini", nowLeft: 50, atReset: { percent: 41 } });
    expect(room("antigravity-claude")).toMatchObject({ provider: null, nowLeft: 100, atReset: { percent: 100 } });
    expect(room("openrouter").api).toEqual({ balance: "$12.30", percent: 41, exhausted: false });
    // Unknown stays unknown: OpenAI reports no balance and no Claude API sample exists.
    expect(nousProviderRoomText(room("openai"))).toBe("balance not reported");
    expect(nousProviderRoomText(room("anthropic"))).toBe("balance unknown");
    expect(nousProviderRoomText(room("openrouter"))).toBe("$12.30 left (41%)");
    expect(nousProviderRoomText(room("codex"))).toBe("80% left now, 77% at the weekly reset, pace UNDER");

    const { use, avoid } = nousProviderAdvice(rooms);
    expect(use.map((entry) => entry.key)).toEqual(["antigravity-claude", "codex", "gemini"]);
    expect(avoid.map(({ room: entry, why }) => [entry.key, why])).toEqual([["claude", "runs out before its reset"], ["deepseek", "no balance left"]]);
    // No room now and AHEAD of pace are reasons to avoid too.
    const ahead = nousProviderRooms([account("max-b", 95, { secondaryWindow: window(95, weeklyReset, 10080) })], null, now);
    expect(nousProviderAdvice(ahead).avoid[0]).toMatchObject({ why: "no room now" });
    const fast = nousProviderRooms([account("codex", 5, { provider: "CODEX", planType: "plus", secondaryWindow: window(60, "2026-10-27T10:00:00.000Z", 10080) })], null, now);
    expect(nousProviderAdvice(fast).avoid[0]).toMatchObject({ why: "runs out before its reset" });
    // Operator 5/11 12:32 BKK: a pool AHEAD of pace whose week would still reset with room (a fresh account) is used, never avoided.
    const pooled = { key: "claude", name: "Claude Max", provider: "claude" as const, accounts: 2, nowLeft: 60, atReset: { percent: 30, resetAt: weeklyReset }, pace: "AHEAD" as const, points: 12 };
    expect(nousProviderAdvice([pooled])).toMatchObject({ avoid: [], use: [pooled] });
    expect(nousProviderAdvice([{ ...pooled, atReset: null }]).avoid[0]).toMatchObject({ why: "ahead of pace" });
  });

  it("puts the rooms and the advice in the world's Tokens lines and space_token_state from the API keys' last sample only", async () => {
    const tokens = compute(pools, { api: sample });
    const summary = renderNousTokenSummary(tokens, "UTC", now);
    expect(summary).toContain("Providers (left now, at this pace at the weekly reset in UTC, pace): Claude Max 12% left now, 0% at the weekly reset 25 Oct, 10:00, pace ON; Codex 80% left now, 77%");
    expect(summary).toContain("OpenRouter $12.30 left (41%)");
    expect(summary).toContain("Provider advice: use now Claude · GPT on Antigravity (100% would reset unused 25 Oct, 10:00), Codex (77% would reset unused 25 Oct, 10:00), Gemini (Antigravity) (41%");
    expect(summary).toContain("avoid Claude Max (runs out before its reset), DeepSeek (no balance left). Non-code work (research, reading, mail drafts, checks, summaries) goes by default "
      + "to a Gemini (Antigravity) pane (pane type gemini, a Claude or GPT model there for the Claude · GPT pool), not to Claude Max. Code changes in any app: Claude Opus or GPT-6 Astra only, never a Sol model.");
    const detail = renderNousTokens(tokens, "UTC", now);
    expect(detail).toContain("- ANTIGRAVITY agy · ACTIVE: gemini models: 5-hour: 10% used");
    expect(detail).toContain("- API OpenRouter · CONNECTED: balance $12.30; 41% left");
    expect(renderNousTokenSummary(compute(null), "UTC", now)).toContain("Providers: unknown (no Space Gateway account sample).");

    // The balance provider's peek never asks a provider: Nous reads only what the quota views already fetched.
    const provider = createApiProviderAccountProvider();
    expect(provider.peek()).toBeNull();
    expect((await readNousTokens({ settings: config, now, api: provider.peek() })).api).toBeNull();
  });

  it("names each Space Gateway key pool in the world's Providers line and an out-of-credit key as such (nous_msg:71a41c2e)", () => {
    const row = (id: string, providerId: string, label: string, status: ApiProviderAccount["status"], detail: string): ApiProviderAccount =>
      ({ id, providerId, label, status, balance: null, currency: null, detail, sampledAt: null });
    const rooms = nousProviderRooms([], [row("openai", "openai", "OpenAI", "EXHAUSTED", "No credit"), row("gateway-adaption", "adaption", "Adaption Labs", "CONNECTED", "Space Gateway key pool"),
      row("gateway-amd_token_lab", "amd_token_lab", "AMD Token Lab", "CONNECTED", "Space Gateway key pool"), row("gateway-nvidia", "nvidia", "NVIDIA NIM", "CONNECTED", "Space Gateway key pool"),
      row("gateway-groq", "groq", "Groq", "EXHAUSTED", "Space Gateway key pool · out of credits")], Date.parse("2026-11-06T16:00:00.000Z"));
    const text = (key: string) => nousProviderRoomText(rooms.find((room) => room.key === key));
    expect(["gateway-adaption", "gateway-amd_token_lab", "gateway-nvidia"].map(text)).toEqual(Array(3).fill("Space Gateway key pool"));
    expect([text("gateway-groq"), text("openai")]).toEqual(["Space Gateway key pool · out of credits", "no balance left"]);
    expect(nousProviderAdvice(rooms).avoid.map((entry) => entry.room.name)).toEqual(["OpenAI API", "Groq"]);
  });
});
