import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeUsageAccount, CliAccountBalance, CliAccountProfile } from "@space/contracts";

const mocks = vi.hoisted(() => ({
  codex: vi.fn(),
  agy: vi.fn(),
  claude: vi.fn(),
  apiProviders: vi.fn(),
  identities: vi.fn(),
  balance: vi.fn(),
  runtimes: vi.fn((): { data: Array<{ id: string }> } | null => null),
  voiceInput: vi.fn(() => null as unknown),
}));
vi.mock("../src/features/voice-input/VoiceInputProvider.js", () => ({ useOptionalVoiceInput: mocks.voiceInput }));
vi.mock("../src/api.js", () => ({
  api: {
    toolbarUsageAccounts: mocks.codex,
    toolbarAntigravityUsageAccounts: mocks.agy,
    toolbarClaudeUsageAccounts: mocks.claude,
    toolbarApiProviderAccounts: mocks.apiProviders,
    cliAccountIdentities: mocks.identities,
    cliAccountBalance: mocks.balance,
    cliRuntimesSnapshot: mocks.runtimes,
  },
}));

import { CliAccountPicker } from "../src/features/cli-accounts/CliAccountPicker.js";
import { CodexAccountPicker } from "../src/features/cli-accounts/CodexAccountPicker.js";
import {
  antigravityModelGroup,
  antigravityQuotaGroups,
  CLI_ACCOUNT_BLOCKED_COLOR,
  CLI_ACCOUNT_OFF_COLOR,
  cliAccountAvailability,
  cliAccountAvailabilityColor,
  cliAccountPlan,
  cliAccountPool,
  cliAccountForecasts,
  cliAccountForecastText,
  modelProviderAvailability,
} from "../src/features/cli-accounts/cli-account-availability.js";
import { fetchCliAccountBalance, resetCliAccountBalanceForTests } from "../src/features/cli-accounts/cli-account-balance.js";
import { resetCliAccountIdentitiesForTests } from "../src/features/cli-accounts/cli-account-identities.js";
import { resetSharedQuotaCacheForTests, type SharedQuotaCache } from "../src/features/desktop-widgets/shared-quota-cache.js";
import { watchedQuota } from "../src/features/desktop-widgets/quota-overview.js";
import { claudeAccountEntries } from "../src/features/toolbar-metrics/account-entries.js";
import { CLI_RUNTIME_VISIBILITY_EVENT } from "../src/cli-runtime-visibility-events.js";

const sampledAt = new Date().toISOString();
// One fixed now for reset times and the clock: a millisecond between them rounded "Back in 40m" up to 41m on CI.
const NOW = Date.now();
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const page = <T,>(data: T[], source: string) => ({
  data,
  pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 },
  source,
  isStale: false,
  error: null,
  checkedAt: sampledAt,
});
const claudeAccount = (id: string, fiveHour: number | null, weekly: number | null, status: "CONNECTED" | "NOT_CONNECTED" = "CONNECTED") => ({
  id,
  label: id,
  email: `${id}@example.test`,
  plan: "Team",
  status,
  fiveHourRemainingPercent: fiveHour,
  fiveHourResetAt: at(90),
  weeklyRemainingPercent: weekly,
  weeklyResetAt: at(4 * 24 * 60),
  weeklyScope: null,
  sampledAt,
});
const profile = (profileId: string): CliAccountProfile => ({
  runtimeId: "cli:claude",
  profileId,
  displayName: profileId,
  createdAt: sampledAt,
  updatedAt: sampledAt,
  updatedBy: null,
});
const hue = (color: string) => Number(/^hsl\((\d+)/.exec(color)?.[1]);

function apiFallbackSample(): SharedQuotaCache {
  const accounts: ClaudeUsageAccount[] = [
    { ...claudeAccount("api", null, null), email: null, plan: null, status: "API_KEY", apiKeyVerified: true, gatewayFallback: "ON",
      apiKeyUsage: { requests: 20, costUsd: 40, lastUsedAt: at(-1), lastRequest: { at: at(-1), succeeded: true } }, apiKeyMonth: { spentUsd: 301.93, budgetUsd: 500 } },
    { ...claudeAccount("space-gateway", null, null), email: null, plan: null, status: "GATEWAY", pool: [
      { label: "ops", signInRequired: false, fiveHourRemainingPercent: 0, fiveHourResetAt: at(40), weeklyRemainingPercent: 70, weeklyResetAt: at(300) },
    ] },
  ];
  return { codex: null, agy: null, claude: page(accounts, "space-claude-profiles"), api: null, fetchedAt: NOW };
}

function quotaSample(claude: ReturnType<typeof claudeAccount>[]): SharedQuotaCache {
  return { codex: null, agy: null, claude: page(claude, "space-claude-profiles"), api: null, fetchedAt: Date.now() };
}

describe("CLI account availability colours", () => {
  it("moves continuously from orange to green with remaining quota and turns red when unusable", () => {
    const hues = [1, 25, 50, 75, 100].map((percent) => hue(cliAccountAvailabilityColor(percent)));
    for (let index = 1; index < hues.length; index += 1) expect(hues[index]!).toBeGreaterThan(hues[index - 1]!);
    expect(hues[0]).toBeGreaterThan(10);
    expect(hues.at(-1)).toBeGreaterThan(130);

    const clock = NOW;
    const quota = quotaSample([claudeAccount("ready", 82, 64), claudeAccount("limited", 0, 70), claudeAccount("weekdone", 100, 0), claudeAccount("signedout", null, null, "NOT_CONNECTED")]);
    const ready = cliAccountAvailability({ runtimeId: "cli:claude", profileId: "ready", quota, identity: null, clock });
    expect(ready).toMatchObject({ tone: "ready", percent: 64, label: "64%" });
    expect(ready.color).toBe(cliAccountAvailabilityColor(64));
    const limited = cliAccountAvailability({ runtimeId: "cli:claude", profileId: "limited", quota, identity: null, clock });
    expect(limited).toMatchObject({ tone: "blocked", color: CLI_ACCOUNT_BLOCKED_COLOR });
    expect(limited.label).toMatch(/^Back in /);
    // Operator 8/11: a spent week names the date it comes back, not only "Week exhausted".
    const weekDone = cliAccountAvailability({ runtimeId: "cli:claude", profileId: "weekdone", quota, identity: null, clock });
    expect(weekDone).toMatchObject({ tone: "blocked", label: expect.stringMatching(/^Back \w{3} \d{1,2} \w{3} \d\d:\d\d$/) });
    expect(weekDone.description).toMatch(/^Not available now · Week exhausted · back \w{3} \d{1,2} \w{3} /);
    expect(cliAccountAvailability({ runtimeId: "cli:claude", profileId: "signedout", quota, identity: null, clock }))
      .toMatchObject({ tone: "blocked", color: CLI_ACCOUNT_BLOCKED_COLOR, label: "Not signed in" });
    // Before the first quota sample a signed-in Claude account is still being checked.
    expect(cliAccountAvailability({
      runtimeId: "cli:claude",
      profileId: "ready",
      quota: null,
      identity: { runtimeId: "cli:claude", profileId: "ready", displayName: "ready", email: null, authStatus: "CONNECTED" },
      clock,
    })).toMatchObject({ tone: "pending", label: "Checking…" });
    // CLIs without quota reports fall back to their sign-in status.
    expect(cliAccountAvailability({
      runtimeId: "cli:cursor",
      profileId: "main",
      quota,
      identity: { runtimeId: "cli:cursor", profileId: "main", displayName: "Main", email: null, authStatus: "NOT_CONNECTED" },
      clock,
    })).toMatchObject({ tone: "blocked", label: "Not signed in" });
  });
});

describe("quota forecast at reset", () => {
  it("projects this week's pace of the subscription accounts to their reset", () => {
    const clock = NOW;
    // Each fixture week resets in 4 days, so 3 of its 7 days have passed.
    const stale = { ...claudeAccount("stale", 90, 10), weeklyResetAt: at(-60) };
    const quota = quotaSample([claudeAccount("paced", 90, 80), claudeAccount("spent", 0, 0), claudeAccount("out", null, 30, "NOT_CONNECTED"), stale]);
    // The pool's pace, paced's 20/3 a day plus spent's 100/3 (7/11: it moves to the account with room), empties paced's 80 in 2 of the
    // 4 days left; spent stays at 100 until it resets; signed-out and stale weeks are left out.
    const forecast = cliAccountForecasts("cli:claude", quota, clock)[0]!;
    expect(forecast).toMatchObject({ accounts: 2, period: "weekly", scope: null, percent: 0, now: 40, color: CLI_ACCOUNT_BLOCKED_COLOR });
    expect(forecast.resetWhen).toMatch(/^at /);
    // Plan clipboard:FDitYcI63D9R: 20 and 100 used against 3/7 of the week passed is +17 points, ahead of pace.
    expect(forecast.pace).toBe("AHEAD");

    const [short] = cliAccountForecasts("cli:claude", quotaSample([claudeAccount("fast", 90, 40)]), clock);
    expect(short).toMatchObject({ percent: 0, color: CLI_ACCOUNT_BLOCKED_COLOR });
    // No sample yet, or no account reporting a period: "Unknown" with the reason, never nothing (operator 31/10 16:59 BKK).
    // Before the first sample the header says it is checking, like the rows, never "Unknown" (stable 31/10).
    expect(cliAccountForecasts("cli:cursor", quota, clock)).toMatchObject([{ percent: null, checking: true }]);
    expect(cliAccountForecasts("cli:claude", null, clock)).toMatchObject([{ percent: null, checking: true }]);
    // Antigravity's groups are Google's: until the first sample names them, one figure is being checked (the pane's group when known).
    expect(cliAccountForecasts("cli:gemini", null, clock).map((entry) => [entry.scope, entry.checking])).toEqual([[null, true]]);
    expect(cliAccountForecasts("cli:gemini", null, clock, "gemini").map((entry) => [entry.scope, entry.checking])).toEqual([["Gemini", true]]);
    // A sample without the provider is unknown, with the reason.
    expect(cliAccountForecasts("cli:claude", { ...quota, claude: null }, clock)).toMatchObject([{ percent: null, reason: expect.stringMatching(/no quota sample/) }]);
    expect(cliAccountForecasts("cli:claude", { ...quota, claude: null }, clock)[0]!.checking).toBeUndefined();
    expect(cliAccountForecasts("cli:claude", quotaSample([claudeAccount("new", 100, null)]), clock))
      .toMatchObject([{ percent: null, reason: "None of the 1 signed-in account reported a current weekly limit" }]);
  });

  // 7/11 (nous_msg:e768734b): the header read «43% free at Fri 06:00» while 3 of the 5 accounts were spent and 1% of the pool was free.
  it("leads with the share free now and moves the spent accounts' load to the ones with room", () => {
    const week = (id: string, remaining: number, hours: number) => ({ ...claudeAccount(id, 100, remaining), weeklyResetAt: at(hours * 60) });
    const quota = quotaSample([week("ops", 0, 20.4), week("crew", 0, 29.4), week("ntheo", 0, 108.4), week("lab", 3, 127.4), week("dev", 3, 129.4)]);
    const [forecast] = cliAccountForecasts("cli:claude", quota, NOW);
    expect(forecast!.percent!).toBeLessThan(43);
    expect(cliAccountForecastText(forecast!)).toMatch(/^1% now · 17% free (at|in) /);
  });

  // Plan clipboard:mjpENip0ilmC: every picker that has a quota period shows the share left at its reset, as Claude's does.
  it("covers Antigravity per model group and Copilot or Kimi from the quota their CLI reports", () => {
    const clock = NOW;
    const group = (weekly: number) => ({ displayName: "Models", fiveHourRemainingPercent: 90, fiveHourResetAt: at(40), weeklyRemainingPercent: weekly, weeklyResetAt: at(4 * 24 * 60) });
    const agy = { id: "spc", label: "spc", email: null, tier: "Google AI Pro", status: "CONNECTED" as const, gemini: group(80), claude: group(100), sampledAt };
    const quota: SharedQuotaCache = { codex: null, agy: page([agy], "agy"), claude: null, api: null, fetchedAt: NOW };
    // 3 of 7 days passed: Gemini used 20 and goes on at 20/3 a day; Claude · GPT is untouched.
    // 8/11: Only the pane's group; without one, both groups.
    expect(cliAccountForecasts("cli:gemini", quota, clock, "claude").map((entry) => entry.scope)).toEqual(["Claude · GPT"]);
    const geminiOnly = cliAccountForecasts("cli:gemini", quota, clock, "gemini");
    expect(geminiOnly.map((entry) => entry.scope)).toEqual(["Gemini"]);
    expect(geminiOnly[0]!.percent).toBeCloseTo(100 - (20 + 80 / 3), 1);
    // Without a model group, both groups show.
    const both = cliAccountForecasts("cli:gemini", quota, clock);
    expect(both.map((entry) => entry.scope)).toEqual(["Gemini", "Claude · GPT"]);
    expect(both[1]!.percent).toBe(100);
    expect(both[1]!.pace).toBe("UNDER");

    // Google AI Pro reports Gemini quota on a 5-hour window without a weekly limit: the forecast uses the 5-hour window.
    const fiveHourOnly = { ...agy, gemini: { displayName: "Gemini Models", fiveHourRemainingPercent: 90, fiveHourResetAt: at(150), weeklyRemainingPercent: null, weeklyResetAt: null } };
    const [proGemini] = cliAccountForecasts("cli:gemini", { ...quota, agy: page([fiveHourOnly], "agy") }, clock, "gemini");
    expect(proGemini).toMatchObject({ scope: "Gemini", now: 90, percent: 80 });

    const days = 86_400_000;
    const monthReset = at(15 * 24 * 60);
    const monthStart = new Date(monthReset);
    monthStart.setUTCMonth(monthStart.getUTCMonth() - 1);
    const window = (id: string, remainingPercent: number, resetAt: string) => ({ id, label: id, remainingPercent, resetAt });
    const balance = (runtimeId: "cli:copilot" | "cli:kimi", windows: ReturnType<typeof window>[]) => ({
      runtimeId, next: "main", checkedAt: sampledAt,
      profiles: [{ profileId: "main", displayName: "main", exhaustedUntil: null, available: true,
        usage: { status: "OK" as const, plan: null, remainingPercent: 0, resetAt: null, windows } }],
    });
    // Copilot's premium requests reset monthly: 20 used since the month began, at that pace until the reset.
    const [copilot] = cliAccountForecasts("cli:copilot", null, clock, null, balance("cli:copilot", [window("premium_interactions", 80, monthReset)]));
    expect(copilot).toMatchObject({ period: "monthly", accounts: 1 });
    expect(copilot!.percent).toBeCloseTo(100 - (20 + (20 / (clock - monthStart.getTime())) * 15 * days), 1);
    // Kimi's week counts; its 5-hour window never sets a figure for the reset.
    const [kimi] = cliAccountForecasts("cli:kimi", null, clock, null, balance("cli:kimi", [window("limit_5h", 5, at(60)), window("limit_7d", 60, at(4 * 24 * 60))]));
    expect(kimi).toMatchObject({ period: "weekly" });
    expect(kimi!.percent).toBeCloseTo(100 - (40 + (40 / 3) * 4), 1);
    // Another CLI's balance never counts.
    expect(cliAccountForecasts("cli:cursor", null, clock, null, balance("cli:kimi", [window("limit_7d", 60, at(4 * 24 * 60))]))).toMatchObject([{ percent: null }]);
    // Cursor reports no period that resets: unknown, with the reason.
    expect(cliAccountForecasts("cli:cursor", null, clock, null, { ...balance("cli:kimi", []), runtimeId: "cli:cursor" }))
      .toMatchObject([{ percent: null, reason: "None of the 1 account reported a quota period that resets" }]);
  });
});

describe("model picker providers", () => {
  it("names what each provider has left and never makes up a number", () => {
    const clock = NOW;
    const api = (providerId: string, status: "CONNECTED" | "EXHAUSTED" | "ERROR", balance: string | null, remainingPercent?: number) =>
      ({ id: providerId, providerId, label: providerId, status, balance, currency: "USD", remainingPercent, detail: null, sampledAt });
    const quota: SharedQuotaCache = { ...codexQuota([codexAccount("kate", 90, 72)]),
      api: page([api("openrouter", "CONNECTED", "$12.30", 41), api("deepseek", "EXHAUSTED", "$0.00"), api("openai", "CONNECTED", "Configured")], "api") };
    const openrouter = modelProviderAvailability("openrouter", quota, clock)!;
    // Prepaid credits never renew: the balance, and that it does not reset.
    expect(openrouter).toMatchObject({ tone: "off", percent: 41, label: "$12.30 left · no reset", color: cliAccountAvailabilityColor(41) });
    expect(openrouter.description).toContain("41% left");
    expect(openrouter.description).toContain("does not reset");
    expect(modelProviderAvailability("deepseek", quota, clock)).toMatchObject({ tone: "blocked", label: "No balance" });
    expect(modelProviderAvailability("openai", quota, clock)).toMatchObject({ label: "Unknown · no reset", percent: null });
    // The Claude API key paced to the monthly budget (no prepaid balance): the budget left when it renews on the 1st, at this pace.
    const budget = modelProviderAvailability("anthropic", { ...quota, api: page([api("anthropic", "CONNECTED", null, 7)], "api") }, Date.UTC(2026, 9, 31, 12));
    expect(budget.label).toBe(`${budget.label.split("%")[0]}% free in 12h`);
    expect(Number(budget.label.split("%")[0])).toBeLessThan(7);
    expect(budget.description).toContain("monthly budget");
    // No sample for the Claude API key: unknown, not a figure.
    expect(modelProviderAvailability("space-gateway-claude", quota, clock)).toMatchObject({ tone: "pending", label: "Unknown" });
    // OpenCode's Space Gateway provider serves the ChatGPT pool.
    // OpenCode's Space Gateway provider shows the Codex pool's share free at its reset, as the Codex account menu does.
    const gateway = modelProviderAvailability("space-gateway", quota, clock);
    expect(gateway).toMatchObject({ tone: "ready", percent: 72 });
    expect(gateway.label).toMatch(/^\d+% now · \d+% free (at|in) /);
    expect(gateway.label).toBe(cliAccountForecastText(cliAccountForecasts("cli:codex", quota, clock)[0]!));
    // OpenCode's Claude Agent (Claude Code on Space Gateway) shows the Claude Max pool's share free at its reset, never the API key's.
    const claudeQuota: SharedQuotaCache = { ...quota, claude: page([claudeAccount("team", 80, 60),
      { ...claudeAccount("space-gateway", null, null), status: "GATEWAY" as never, pool: [{ label: "team", signInRequired: false, fiveHourRemainingPercent: 80,
        fiveHourResetAt: at(90), weeklyRemainingPercent: 60, weeklyResetAt: at(4 * 24 * 60) }] }], "claude") };
    const agent = modelProviderAvailability("claude-agent", claudeQuota, clock);
    expect(agent.label).toBe(cliAccountForecastText(cliAccountForecasts("cli:claude", claudeQuota, clock)[0]!));
    expect(agent.tone).toBe("ready");
    expect(modelProviderAvailability("claude-agent", null, clock)).toMatchObject({ label: "Checking…" });
    // A provider Space reads no quota for says so.
    expect(modelProviderAvailability("opencode", quota, clock)).toMatchObject({ label: "Unknown free at reset", description: expect.stringMatching(/opencode reports no quota/) });
    expect(modelProviderAvailability("openrouter", null, clock)).toMatchObject({ label: "Checking…" });
  });
});

describe("Antigravity model groups and plans", () => {
  const group = (fiveHour: number | null, weekly: number | null) => ({
    displayName: "Models", fiveHourRemainingPercent: fiveHour, fiveHourResetAt: at(40), weeklyRemainingPercent: weekly, weeklyResetAt: at(3 * 24 * 60),
  });
  const agy = (id: string, tier: string | null, gemini: ReturnType<typeof group>, claude: ReturnType<typeof group>) => ({
    id, label: id, email: `${id}@example.test`, tier, status: "CONNECTED" as const, gemini, claude, sampledAt,
  });
  const quota: SharedQuotaCache = {
    codex: null,
    agy: page([agy("spc", "Google AI Pro", group(0, 60), group(100, 100)), agy("free", "Free", group(80, 90), group(null, null))], "agy"),
    claude: page([
      claudeAccount("team", 90, 80),
      { ...claudeAccount("api", null, null), status: "API_KEY" as never },
      { ...claudeAccount("space-gateway", null, null), status: "GATEWAY" as never },
    ], "claude"),
    api: null,
    fetchedAt: Date.now(),
  };

  it("judges an Antigravity account by the model group the pane runs", () => {
    expect(antigravityModelGroup("gemini-3.8-flash")).toBe("gemini");
    expect(antigravityModelGroup("claude-sonnet-4.6")).toBe("claude");
    expect(antigravityModelGroup("gpt-oss-120b")).toBe("claude");
    expect(antigravityModelGroup(null)).toBeNull();
    const clock = NOW;
    const onGemini = cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "spc", quota, identity: null, clock, modelGroup: "gemini" });
    expect(onGemini).toMatchObject({ tone: "blocked", color: CLI_ACCOUNT_BLOCKED_COLOR });
    expect(onGemini.description).toContain("For Gemini models");
    expect(cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "spc", quota, identity: null, clock, modelGroup: "claude" }))
      .toMatchObject({ tone: "ready", percent: 100 });
    // Without a known model the best group decides, and both windows stay visible.
    const best = cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "spc", quota, identity: null, clock });
    expect(best).toMatchObject({ tone: "ready", percent: 100 });
    expect(best.windows.map((window) => window.label)).toEqual(["Gemini", "Claude · GPT"]);
    // 8/11: With a known model group, only that group's window appears.
    const geminiWindows = cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "spc", quota, identity: null, clock, modelGroup: "gemini" });
    expect(geminiWindows.windows.every((window) => window.label === "Gemini")).toBe(true);
  });

  it("judges the Antigravity Space Gateway account by the best pooled account for the pane's model group", () => {
    const clock = NOW;
    // spc is out of Gemini quota, free still has 80%: the gateway serves Gemini models from free.
    expect(cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "space-gateway", quota, identity: null, clock, modelGroup: "gemini" }))
      .toMatchObject({ tone: "ready", percent: 80, detail: "1 of 2 pooled accounts ready" });
    // Out-of-rotation Free profiles stay out of the gateway pool count while keeping their own quota and plan in the picker.
    const withPaused: SharedQuotaCache = {
      ...quota,
      agy: { ...page([agy("pir", "Google AI Pro", group(96, null), group(0, 0))], "agy"), outOfRotation: [agy("spc", "Free", group(null, 0), group(null, 0))] },
    };
    expect(cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "space-gateway", quota: withPaused, identity: null, clock, modelGroup: "gemini" }))
      .toMatchObject({ tone: "ready", percent: 96, detail: "1 of 1 pooled account ready" });
    expect(cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "spc", quota: withPaused, identity: null, clock, modelGroup: "gemini" }))
      .toMatchObject({ tone: "blocked", color: CLI_ACCOUNT_BLOCKED_COLOR });
    expect(cliAccountPlan("cli:gemini", "spc", withPaused)).toBe("Free");
    const empty = { ...quota, agy: page([agy("spc", null, group(0, 0), group(0, 0))].map((account) => ({ ...account, status: "EXPIRED" as const })), "agy") };
    expect(cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "space-gateway", quota: empty, identity: null, clock }))
      .toMatchObject({ tone: "blocked", label: "No accounts" });
  });

  it("offers every quota group Google reports, in its order, and maps a model to the group named after it", () => {
    const clock = NOW;
    const pro = { ...agy("pro", "Google AI Pro", group(50, 90), group(null, 0)), groups: [
      { id: "gemini", ...group(50, 90), displayName: "Gemini Models" },
      { id: "claude", ...group(null, 0), displayName: "Claude and GPT models" },
      { id: "gemini-argon-wtu", ...group(null, 40), displayName: "Gemini 4 Argon" },
    ] };
    const free = { ...agy("free", "Free", group(null, 100), group(null, 0)), groups: pro.groups.slice(0, 2) };
    const withArgon: SharedQuotaCache = { ...quota, agy: page([pro, free], "agy") };
    const groups = antigravityQuotaGroups(withArgon.agy);
    expect(groups).toEqual([{ id: "gemini", label: "Gemini" }, { id: "claude", label: "Claude · GPT" }, { id: "gemini-argon-wtu", label: "Gemini 4 Argon" }]);
    // A group Google stops reporting is no longer offered; the older list without groups offers the groups it has data for.
    expect(antigravityQuotaGroups(page([free], "agy")).map((option) => option.id)).toEqual(["gemini", "claude"]);
    expect(antigravityQuotaGroups(quota.agy).map((option) => option.id)).toEqual(["gemini", "claude"]);
    expect(antigravityModelGroup("gemini-4-argon-high", groups)).toBe("gemini-argon-wtu");
    expect(antigravityModelGroup("gemini-3.8-flash-high", groups)).toBe("gemini");
    expect(antigravityModelGroup("claude-opus-5-5-max", groups)).toBe("claude");
    const onArgon = cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "pro", quota: withArgon, identity: null, clock, modelGroup: "gemini-argon-wtu" });
    expect(onArgon).toMatchObject({ tone: "ready", percent: 40 });
    expect(onArgon.description).toContain("For Gemini 4 Argon models");
    expect(cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "pro", quota: withArgon, identity: null, clock }).windows.map((window) => window.label))
      .toEqual(["Gemini", "Claude · GPT", "Gemini 4 Argon"]);
    // The gateway pools only the accounts that have the group.
    expect(cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "space-gateway", quota: withArgon, identity: null, clock, modelGroup: "gemini-argon-wtu" }))
      .toMatchObject({ detail: "1 of 2 pooled accounts ready" });
    expect(cliAccountForecasts("cli:gemini", withArgon, clock).map((entry) => entry.scope)).toEqual(["Gemini", "Claude · GPT", "Gemini 4 Argon"]);
  });

  it("keeps the paid API key account out of use and shows the Space Gateway account as ready", () => {
    const clock = NOW;
    expect(cliAccountAvailability({ runtimeId: "cli:claude", profileId: "api", quota, identity: null, clock }))
      .toMatchObject({ tone: "off", color: CLI_ACCOUNT_OFF_COLOR, label: "Paid · not used", detail: "Per token · only when picked by hand" });
    expect(cliAccountAvailability({ runtimeId: "cli:claude", profileId: "space-gateway", quota, identity: null, clock }))
      .toMatchObject({ tone: "ready", label: "Ready", description: "Available now · Space Gateway picks a pooled Claude account" });
  });

  it("judges the Space Gateway account by its pool and names the pooled accounts", () => {
    const clock = NOW;
    const member = (label: string, fiveHour: number | null, minutes = 40, signInRequired = false) => ({
      label, signInRequired, fiveHourRemainingPercent: fiveHour, fiveHourResetAt: at(minutes), weeklyRemainingPercent: 70, weeklyResetAt: at(3 * 24 * 60),
    });
    const withPool = (pool: ReturnType<typeof member>[]): SharedQuotaCache => ({
      ...quota, claude: page([{ ...claudeAccount("space-gateway", null, null), label: "Space Gateway (pooled)", status: "GATEWAY" as never, pool }], "claude"),
    });
    const read = (pool: ReturnType<typeof member>[]) =>
      cliAccountAvailability({ runtimeId: "cli:claude", profileId: "space-gateway", quota: withPool(pool), identity: null, clock });

    // Every pooled account at its 5-hour limit (seen live 2026-10-12): not ready, back when the first one resets.
    const limited = read([member("crew", 0, 140), member("lab", 0, 40), member("ops", 0, 170)]);
    expect(limited).toMatchObject({ tone: "blocked", label: "Back in 40m" });
    expect(limited.description).toBe("Not available now · Back in 40m · 0 of 3 pooled accounts ready");
    expect(limited.detail).toBe("0 of 3 pooled accounts ready");
    expect(read([member("crew", 0), member("lab", 64)])).toMatchObject({ tone: "ready", percent: 64, detail: "1 of 2 pooled accounts ready" });
    expect(read([member("ops", null, 40, true)])).toMatchObject({ tone: "blocked", label: "Sign-in required" });
    expect(read([])).toMatchObject({ tone: "blocked", label: "No accounts" });

    const [entry] = claudeAccountEntries(withPool([member("crew", 0, 140), member("lab", 0, 40)]).claude!.data, clock);
    expect(entry).toMatchObject({ title: "Space Gateway (pooled)", details: ["Pools crew, lab"], hint: "0 of 2 pooled accounts available now.",
      availability: { state: "soon" }, rows: [] });
    // Quota alerts count accounts, and the gateway's accounts are already listed on their own.
    expect(watchedQuota(withPool([member("lab", 64)]), clock, { provider: "claude", proOnly: false }).total).toBe(0);
  });

  it("names each account's plan", () => {
    expect(cliAccountPlan("cli:gemini", "spc", quota)).toBe("AI Pro");
    expect(cliAccountPlan("cli:gemini", "free", quota)).toBe("Free");
    expect(cliAccountPlan("cli:claude", "team", quota)).toBe("Team");
    expect(cliAccountPlan("cli:claude", "api", quota)).toBe("API key");
    // The gateway account's name already says Space Gateway, so it carries no plan badge.
    expect(cliAccountPlan("cli:claude", "space-gateway", quota)).toBeNull();
    expect(cliAccountPlan("cli:cursor", "main", quota)).toBeNull();
  });
});

const codexAccount = (id: string, fiveHour: number | null, weekly: number | null, planType: string | null = "pro") => ({
  id, label: id, planType, fiveHourRemainingPercent: fiveHour, weeklyRemainingPercent: weekly,
  fiveHourResetAt: at(90), weeklyResetAt: at(4 * 24 * 60), sampledAt,
});
const codexQuota = (accounts: ReturnType<typeof codexAccount>[] | null): SharedQuotaCache => ({
  codex: accounts ? page(accounts, "space-gateway") : null, agy: null, claude: null, api: null, fetchedAt: Date.now(),
});

describe("Codex accounts behind Space Gateway", () => {
  it("judges the gateway by the best ChatGPT account in its pool", () => {
    const clock = NOW;
    const gateway = (accounts: ReturnType<typeof codexAccount>[] | null) =>
      cliAccountAvailability({ runtimeId: "cli:codex", profileId: "space-gateway", quota: codexQuota(accounts), identity: null, clock });
    expect(gateway([codexAccount("kate", 90, 72), codexAccount("leo", 1, 80)]))
      .toMatchObject({ tone: "ready", percent: 72, label: "72%", detail: "1 of 2 pooled accounts ready" });
    const limited = gateway([codexAccount("leo", 1, 80)]);
    expect(limited).toMatchObject({ tone: "blocked", detail: "0 of 1 pooled account ready" });
    expect(limited.label).toMatch(/^Back in 1h 3\dm$/);
    expect(gateway([])).toMatchObject({ tone: "blocked", label: "No accounts" });
    expect(gateway(null)).toMatchObject({ tone: "pending", label: "Unknown" });
    expect(cliAccountAvailability({ runtimeId: "cli:codex", profileId: "space-gateway", quota: null, identity: null, clock }))
      .toMatchObject({ tone: "pending", label: "Checking…" });
    expect(cliAccountPlan("cli:codex", "space-gateway", codexQuota([codexAccount("kate", 90, 72)]))).toBeNull();
  });

  it("lists each pooled account with its plan and both quota windows", () => {
    const clock = NOW;
    const pool = cliAccountPool("cli:codex", codexQuota([codexAccount("kate", 90, 72), codexAccount("leo", 0, 80, null)]), clock)!;
    expect(pool.map((member) => [member.name, member.plan, member.availability.detail])).toEqual([
      ["kate", "Pro", "5h 90% · Week 72%"],
      ["leo", null, "5h 0% · Week 80%"],
    ]);
    expect(pool[0]!.availability).toMatchObject({ tone: "ready", label: "72%" });
    expect(pool[1]!.availability.tone).toBe("blocked");
    expect(pool[1]!.availability.label).toMatch(/^Back in /);
    expect(cliAccountPool("cli:codex", codexQuota(null), clock)).toBeNull();
    expect(cliAccountPool("cli:claude", codexQuota([codexAccount("kate", 90, 72)]), clock)).toBeNull();
  });
});

describe("CLI account balance reads", () => {
  it("never asks a CLI that is switched off (API audit 5/11: 985 failed reads a day for copilot and kimi)", async () => {
    resetCliAccountBalanceForTests();
    const balance = { runtimeId: "cli:copilot", profiles: [], next: null } as unknown as CliAccountBalance;
    const loader = vi.fn(async () => balance);
    mocks.runtimes.mockReturnValue({ data: [{ id: "cli:cursor" }] });
    try {
      expect(await fetchCliAccountBalance("cli:copilot", loader)).toBeNull();
      expect(loader).not.toHaveBeenCalled();
      // Switched on again: the runtimes list names it, so it is asked.
      mocks.runtimes.mockReturnValue({ data: [{ id: "cli:copilot" }] });
      expect(await fetchCliAccountBalance("cli:copilot", loader)).toBe(balance);
      // Before the runtimes list has loaded nothing is known, so it is asked as before.
      resetCliAccountBalanceForTests();
      mocks.runtimes.mockReturnValue(null);
      expect(await fetchCliAccountBalance("cli:copilot", loader)).toBe(balance);
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      mocks.runtimes.mockReturnValue(null);
      resetCliAccountBalanceForTests();
    }
  });

  it("stops asking once the server says the CLI is switched off, until a CLI is switched on or off (API audit 6/11: 705 failed reads)", async () => {
    resetCliAccountBalanceForTests();
    vi.useFakeTimers();
    try {
      const disabled = Object.assign(new Error("CLI runtime is disabled."), { code: "CLI_RUNTIME_DISABLED", status: 503 });
      const loader = vi.fn(async (): Promise<CliAccountBalance> => { throw disabled; });
      expect(await fetchCliAccountBalance("cli:kimi", loader)).toBeNull();
      vi.advanceTimersByTime(10 * 60_000);
      expect(await fetchCliAccountBalance("cli:kimi", loader)).toBeNull();
      expect(loader).toHaveBeenCalledTimes(1);
      const balance = { runtimeId: "cli:kimi", profiles: [], next: null } as unknown as CliAccountBalance;
      loader.mockResolvedValueOnce(balance);
      window.dispatchEvent(new CustomEvent(CLI_RUNTIME_VISIBILITY_EVENT, { detail: { source: "server" } }));
      expect(await fetchCliAccountBalance("cli:kimi", loader)).toBe(balance);
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      resetCliAccountBalanceForTests();
    }
  });

  it("asks a failing CLI again only after a minute, not on every hover (API audit 4/11: 282 failed reads a day for switched-off CLIs)", async () => {
    resetCliAccountBalanceForTests();
    vi.useFakeTimers();
    try {
      const loader = vi.fn(async (): Promise<CliAccountBalance> => { throw new Error("CLI runtime is disabled"); });
      expect(await fetchCliAccountBalance("cli:kimi", loader)).toBeNull();
      expect(await fetchCliAccountBalance("cli:kimi", loader)).toBeNull();
      expect(loader).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      const balance = { runtimeId: "cli:kimi", profiles: [], next: null } as unknown as CliAccountBalance;
      loader.mockResolvedValueOnce(balance);
      expect(await fetchCliAccountBalance("cli:kimi", loader)).toBe(balance);
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      resetCliAccountBalanceForTests();
    }
  });
});

describe("CliAccountPicker", () => {
  beforeEach(() => {
    resetSharedQuotaCacheForTests();
    resetCliAccountIdentitiesForTests();
    resetCliAccountBalanceForTests();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.voiceInput.mockReturnValue(null);
    mocks.codex.mockResolvedValue(page([], "codex"));
    mocks.agy.mockResolvedValue(page([], "agy"));
    mocks.apiProviders.mockResolvedValue(page([], "api"));
    mocks.claude.mockResolvedValue(page([claudeAccount("ops", 90, 80), claudeAccount("lab", 0, 50)], "space-claude-profiles"));
    mocks.identities.mockResolvedValue({
      accounts: [
        { runtimeId: "cli:claude", profileId: "ops", displayName: "ops", email: "ops@example.test", authStatus: "CONNECTED" },
        { runtimeId: "cli:claude", profileId: "lab", displayName: "lab", email: "lab@example.test", authStatus: "CONNECTED" },
      ],
      checkedAt: sampledAt,
    });
  });

  it("opens the account list with one click, marks the active account and switches with a second click", async () => {
    const onSelect = vi.fn();
    render(
      <CliAccountPicker
        runtimeId="cli:claude"
        providerLabel="Claude"
        icon={<span />}
        paneTitle="Claude pane"
        profiles={[profile("ops"), profile("lab")]}
        selectedProfileId="ops"
        onSelect={onSelect}
      />
    );
    const trigger = screen.getByRole("button", { name: "Claude account for Claude pane" });
    expect(trigger.getAttribute("title")).toMatch(/^Claude account: ops/);
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", { name: "Claude account for Claude pane" });
    const [ops, lab] = within(menu).getAllByRole("menuitemradio");
    expect(ops!.getAttribute("aria-checked")).toBe("true");
    expect(within(ops!).getByText("Active")).toBeTruthy();
    await waitFor(() => expect(within(ops!).getByText("80%")).toBeTruthy());
    expect(within(ops!).getByText("ops@example.test")).toBeTruthy();
    expect(within(ops!).getByText("Team")).toBeTruthy();
    expect(ops!.getAttribute("data-tone")).toBe("ready");
    expect(lab!.getAttribute("data-tone")).toBe("blocked");
    expect(lab!.style.getPropertyValue("--cli-account-color")).toBe(CLI_ACCOUNT_BLOCKED_COLOR);
    expect(within(menu).getByText("1 of 2 available now")).toBeTruthy();
    // ops and lab, 3 days into their weeks with 20% and 50% used: 65% free now; their pooled 70/3 a day for 4 days leaves ~18% at the reset.
    expect(within(menu).getByText("65% now").closest(".cli-account-menu-forecast")!.textContent).toMatch(/^65% now18% free (at|in) /);

    fireEvent.click(lab!);
    expect(onSelect).toHaveBeenCalledWith("lab");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows one tab per Google quota group, starts on the pane model's group and leaves out the accounts without it", async () => {
    const group = (weekly: number) => ({ displayName: "Models", fiveHourRemainingPercent: null, fiveHourResetAt: null, weeklyRemainingPercent: weekly, weeklyResetAt: at(3 * 24 * 60) });
    const groups = [
      { id: "gemini", ...group(90), displayName: "Gemini Models" },
      { id: "claude", ...group(30), displayName: "Claude and GPT models" },
      { id: "gemini-argon-wtu", ...group(40), displayName: "Gemini 4 Argon" },
    ];
    const account = (id: string, tier: string, listed: typeof groups) =>
      ({ id, label: id, email: null, tier, status: "CONNECTED" as const, gemini: group(90), claude: group(30), groups: listed, sampledAt });
    mocks.agy.mockResolvedValue(page([account("pro", "Google AI Pro", groups), account("free", "Free", groups.slice(0, 2))], "agy"));
    render(
      <CliAccountPicker runtimeId="cli:gemini" providerLabel="Google" icon={<span />} paneTitle="Argon pane"
        profiles={[profile("pro"), profile("free")]} selectedProfileId="free" onSelect={vi.fn()} modelId="gemini-4-argon-high" />
    );
    fireEvent.click(screen.getByRole("button", { name: "Google account for Argon pane" }));
    const menu = await screen.findByRole("menu");
    const tabs = await within(menu).findByRole("group", { name: "Quota group" });
    const tab = (name: string) => within(tabs).getByRole("menuitemradio", { name });
    expect(within(tabs).getAllByRole("menuitemradio").map((entry) => entry.textContent)).toEqual(["Gemini", "Claude · GPT", "Gemini 4 Argon"]);
    expect(tab("Gemini 4 Argon").getAttribute("aria-checked")).toBe("true");
    const accounts = () => Array.from(menu.querySelectorAll(".cli-account-menu-list .cli-account-menu-item")).map((entry) => entry.textContent);
    expect(accounts()).toHaveLength(1);
    expect(accounts()[0]).toContain("pro");
    fireEvent.click(tab("Gemini"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(tab("Gemini").getAttribute("aria-checked")).toBe("true");
    expect(accounts()).toHaveLength(2);
    fireEvent.keyDown(menu, { key: "ArrowLeft" });
    expect(tab("Gemini 4 Argon").getAttribute("aria-checked")).toBe("true");
  });

  it("stays hidden and reads no quota once Settings → CLI pane controls switches the account picker off", () => {
    mocks.voiceInput.mockReturnValue({ settings: { terminalAccountPicker: false } });
    const { container } = render(
      <CliAccountPicker runtimeId="cli:claude" providerLabel="Claude" icon={<span />} paneTitle="Claude pane"
        profiles={[profile("ops")]} selectedProfileId="ops" onSelect={vi.fn()} />
    );
    expect(container.innerHTML).toBe("");
    expect(mocks.claude).not.toHaveBeenCalled();
    expect(mocks.identities).not.toHaveBeenCalled();
  });

  it("shows the paid API key account greyed out, still selectable by hand, and never counts it as available", async () => {
    mocks.claude.mockResolvedValue(page([
      claudeAccount("ops", 90, 80),
      { ...claudeAccount("api", null, null), email: null, plan: null, status: "API_KEY" as never },
    ], "space-claude-profiles"));
    mocks.identities.mockResolvedValue({
      accounts: [
        { runtimeId: "cli:claude", profileId: "ops", displayName: "ops", email: "ops@example.test", authStatus: "CONNECTED" },
        { runtimeId: "cli:claude", profileId: "api", displayName: "api", email: null, authStatus: "CONNECTED" },
      ],
      checkedAt: sampledAt,
    });
    const onSelect = vi.fn();
    render(
      <CliAccountPicker
        runtimeId="cli:claude"
        providerLabel="Claude"
        icon={<span />}
        paneTitle="Claude pane"
        profiles={[profile("ops"), profile("api")]}
        selectedProfileId="ops"
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude account for Claude pane" }));
    const menu = await screen.findByRole("menu", { name: "Claude account for Claude pane" });
    const [, api] = within(menu).getAllByRole("menuitemradio");
    await waitFor(() => expect(within(api!).getByText("Paid · not used")).toBeTruthy());
    expect(within(api!).getByText("Per token · only when picked by hand")).toBeTruthy();
    expect(api!.getAttribute("data-tone")).toBe("off");
    expect(api!.style.getPropertyValue("--cli-account-color")).toBe(CLI_ACCOUNT_OFF_COLOR);
    expect(within(menu).getByText("1 of 2 available now")).toBeTruthy();
    fireEvent.click(api!);
    expect(onSelect).toHaveBeenCalledWith("api");
  });

  it("shows the API key's share of the monthly budget left after this month's Anthropic bill", () => {
    const api = (apiKeyMonth: { spentUsd: number | null; budgetUsd: number | null }) => cliAccountAvailability({
      runtimeId: "cli:claude", profileId: "api", identity: null, clock: Date.now(),
      quota: { codex: null, agy: null, api: null, fetchedAt: Date.now(), claude: page([
        { ...claudeAccount("api", null, null), email: null, plan: null, status: "API_KEY" as never, apiKeyVerified: true, apiKeyMonth },
      ], "space-claude-profiles") as never },
    });
    expect(api({ spentUsd: 125, budgetUsd: 500 })).toMatchObject({ tone: "off", percent: 75, label: "$375.00 left", detail: "$125.00 of $500.00 this month · budget",
      color: cliAccountAvailabilityColor(75) });
    expect(api({ spentUsd: 640, budgetUsd: 500 })).toMatchObject({ percent: 0, label: "$0.00 left", color: CLI_ACCOUNT_BLOCKED_COLOR });
    // Without a budget the row keeps its paid-key look and names what this month cost.
    expect(api({ spentUsd: 12.5, budgetUsd: null })).toMatchObject({ percent: null, label: "Paid · ready", detail: "$12.50 this month · only when picked by hand",
      color: CLI_ACCOUNT_OFF_COLOR });
    expect(api({ spentUsd: null, budgetUsd: 500 })).toMatchObject({ percent: null, label: "Paid · ready" });
  });

  // Operator rule 2026-10-27: the API key never serves Claude Code, so the gateway row never claims it.
  it("shows the API key's own use and budget, while the selected gateway shows only its exhausted pool", async () => {
    mocks.claude.mockResolvedValue(apiFallbackSample().claude);
    mocks.identities.mockResolvedValue({ accounts: [], checkedAt: sampledAt });
    const onSelect = vi.fn();
    const props = { runtimeId: "cli:claude" as const, providerLabel: "Claude", icon: <span />, paneTitle: "Emma",
      profiles: [profile("api"), { ...profile("space-gateway"), displayName: "Space Gateway (pooled)" }], onSelect };
    const { rerender } = render(<CliAccountPicker {...props} selectedProfileId="space-gateway" />);
    fireEvent.click(screen.getByRole("button", { name: "Claude account for Emma" }));
    const menu = await screen.findByRole("menu");
    const [api, gateway] = within(menu).getAllByRole("menuitemradio");
    await waitFor(() => expect(within(api!).getByText("In use")).toBeTruthy());
    expect(within(api!).getByText("$198.07 left")).toBeTruthy();
    expect(api!.getAttribute("aria-checked")).toBe("false");
    expect(api!.getAttribute("data-tone")).toBe("off"); // Auto still cannot pick the paid profile.
    expect(gateway!.getAttribute("aria-checked")).toBe("true");
    expect(gateway!.getAttribute("data-tone")).not.toBe("ready");
    expect(within(gateway!).queryByText("Using API")).toBeNull();
    expect(within(gateway!).queryByText(/budget left/)).toBeNull();
    expect(within(menu).getByText("0 of 2 available now")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
    // Other direct profiles must not appear to be using the gateway's API key.
    rerender(<CliAccountPicker {...props} selectedProfileId="api" />);
    expect(within(api!).queryByText("In use")).toBeNull();
  });

  it.each(["no requests", "failed request", "old use", "stale sample", "old sample", "future use", "legacy sample"])("does not claim current API use with %s", (reason) => {
    const quota = apiFallbackSample();
    const api = quota.claude!.data[0]!;
    if (reason === "no requests") api.apiKeyUsage = { requests: 0, costUsd: 0, lastUsedAt: null };
    if (reason === "failed request") api.apiKeyUsage!.lastRequest!.succeeded = false;
    if (reason === "old use") api.apiKeyUsage!.lastRequest!.at = at(-6);
    if (reason === "stale sample") quota.claude!.isStale = true;
    if (reason === "old sample") quota.claude!.checkedAt = at(-6);
    if (reason === "future use") api.apiKeyUsage!.lastRequest!.at = at(6);
    if (reason === "legacy sample") delete api.apiKeyUsage!.lastRequest;
    expect(cliAccountAvailability({ runtimeId: "cli:claude", profileId: "api", quota, identity: null, clock: NOW }).gatewayInUse).toBe(false);
    expect(cliAccountAvailability({ runtimeId: "cli:claude", profileId: "space-gateway", quota, identity: null, clock: NOW }).label).not.toMatch(/API/);
  });

  it.each(["subscription recovered", "reset passed", "unknown pool", "fallback off", "key rejected"])("stops showing API fallback when %s", (reason) => {
    const quota = apiFallbackSample();
    const [api, gateway] = quota.claude!.data;
    if (reason === "subscription recovered") gateway!.pool![0]!.fiveHourRemainingPercent = 80;
    if (reason === "reset passed") gateway!.pool![0]!.fiveHourResetAt = at(-1);
    if (reason === "unknown pool") {
      gateway!.pool![0]!.fiveHourRemainingPercent = null;
      gateway!.pool![0]!.weeklyRemainingPercent = null;
    }
    if (reason === "fallback off") api!.gatewayFallback = "OFF";
    if (reason === "key rejected") api!.apiKeyVerified = false;
    const available = (profileId: string) => cliAccountAvailability({ runtimeId: "cli:claude", profileId, quota, identity: null, clock: NOW });
    expect(available("api").gatewayInUse).toBe(false);
    expect(available("space-gateway").label).not.toMatch(/API/);
  });

  it("names Space Gateway once and shows its pool in a short line instead of the long description", async () => {
    const pooled = (label: string, fiveHour: number) => ({
      label, signInRequired: false, fiveHourRemainingPercent: fiveHour, fiveHourResetAt: at(40), weeklyRemainingPercent: 70, weeklyResetAt: at(3 * 24 * 60),
    });
    mocks.claude.mockResolvedValue(page([
      claudeAccount("ops", 90, 80),
      { ...claudeAccount("space-gateway", null, null), label: "Space Gateway", email: null, plan: null, status: "GATEWAY" as never,
        pool: [pooled("crew", 34), pooled("lab", 60)] },
    ], "space-claude-profiles"));
    render(
      <CliAccountPicker
        runtimeId="cli:claude"
        providerLabel="Claude"
        icon={<span />}
        paneTitle="Claude pane"
        profiles={[profile("ops"), { ...profile("space-gateway"), displayName: "Space Gateway" }]}
        selectedProfileId="space-gateway"
        onSelect={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude account for Claude pane" }));
    const menu = await screen.findByRole("menu", { name: "Claude account for Claude pane" });
    const [, gateway] = within(menu).getAllByRole("menuitemradio");
    await waitFor(() => expect(within(gateway!).getByText("2 of 2 pooled accounts ready")).toBeTruthy());
    expect(within(gateway!).getByText("Space Gateway")).toBeTruthy();
    expect(gateway!.querySelector(".cli-account-plan-badge")).toBeNull();
    expect(gateway!.textContent!.match(/Space Gateway/g)).toHaveLength(1);
  });

  it("narrows the menu to the pane so a small pane or screen shows it whole", async () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
    Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get() { return pane; } });
    pane.getBoundingClientRect = () => ({ left: 100, right: 340, top: 0, bottom: 400, width: 240, height: 400, x: 100, y: 0, toJSON: () => ({}) });
    try {
      render(
        <CliAccountPicker
          runtimeId="cli:claude"
          providerLabel="Claude"
          icon={<span />}
          paneTitle="Claude pane"
          profiles={[profile("ops"), profile("lab")]}
          selectedProfileId="ops"
          onSelect={vi.fn()}
        />,
        { container: pane },
      );
      const trigger = screen.getByRole("button", { name: "Claude account for Claude pane" });
      trigger.getBoundingClientRect = () => ({ left: 300, right: 330, top: 8, bottom: 36, width: 30, height: 28, x: 300, y: 8, toJSON: () => ({}) });
      fireEvent.click(trigger);
      const menu = await screen.findByRole("menu");
      expect(menu.style.maxWidth).toBe("222px");
    } finally {
      if (offsetParent) Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
      pane.remove();
    }
  });

  it("shows the GitHub login for Copilot accounts that report no email", async () => {
    mocks.identities.mockResolvedValue({
      accounts: [{ runtimeId: "cli:copilot", profileId: "main", displayName: "Main", email: null, login: "octo-cat", authStatus: "CONNECTED" }],
      checkedAt: sampledAt,
    });
    render(
      <CliAccountPicker
        runtimeId="cli:copilot"
        providerLabel="GitHub"
        icon={<span />}
        paneTitle="Copilot pane"
        profiles={[{ ...profile("main"), displayName: "Main" }]}
        selectedProfileId="main"
        onSelect={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "GitHub account for Copilot pane" }));
    const menu = await screen.findByRole("menu", { name: "GitHub account for Copilot pane" });
    expect(await within(menu).findByText("@octo-cat")).toBeTruthy();
    expect(within(menu).getByText("Signed in")).toBeTruthy();
  });

  it("closes on Escape without switching and does not reselect the active account", async () => {
    const onSelect = vi.fn();
    render(
      <CliAccountPicker
        runtimeId="cli:claude"
        providerLabel="Claude"
        icon={<span />}
        paneTitle="Claude pane"
        profiles={[profile("ops"), profile("lab")]}
        selectedProfileId="ops"
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude account for Claude pane" }));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Claude account for Claude pane" }));
    fireEvent.click(within(await screen.findByRole("menu")).getAllByRole("menuitemradio")[0]!);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it("offers Auto first for balanced CLIs and names the account Auto runs on", async () => {
    const onSelect = vi.fn();
    const onAuto = vi.fn();
    const { rerender } = render(
      <CliAccountPicker
        runtimeId="cli:copilot"
        providerLabel="GitHub"
        icon={<span />}
        paneTitle="Copilot pane"
        profiles={[profile("main"), profile("work")]}
        selectedProfileId="main"
        onSelect={onSelect}
        auto={{ active: false, onSelect: onAuto }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "GitHub account for Copilot pane" }));
    const items = within(await screen.findByRole("menu")).getAllByRole("menuitemradio");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("Auto (Space Gateway)");
    expect(items[1]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(items[0]!);
    expect(onAuto).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    rerender(
      <CliAccountPicker
        runtimeId="cli:copilot"
        providerLabel="GitHub"
        icon={<span />}
        paneTitle="Copilot pane"
        profiles={[profile("main"), profile("work")]}
        selectedProfileId="work"
        onSelect={onSelect}
        auto={{ active: true, onSelect: onAuto }}
      />
    );
    expect(screen.getByRole("button", { name: "GitHub account for Copilot pane" }).getAttribute("title")).toContain("Auto, now work");
    fireEvent.click(screen.getByRole("button", { name: "GitHub account for Copilot pane" }));
    const menu = await screen.findByRole("menu");
    const autoItem = within(menu).getAllByRole("menuitemradio")[0]!;
    expect(autoItem.getAttribute("aria-checked")).toBe("true");
    expect(autoItem.textContent).toContain("Now on work");
    expect(within(menu).getByText("In use")).toBeTruthy();
    fireEvent.click(autoItem);
    expect(onAuto).toHaveBeenCalledTimes(1);
  });
});

describe("CodexAccountPicker", () => {
  beforeEach(() => {
    resetSharedQuotaCacheForTests();
    resetCliAccountIdentitiesForTests();
    resetCliAccountBalanceForTests();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.agy.mockResolvedValue(page([], "agy"));
    mocks.claude.mockResolvedValue(page([], "space-claude-profiles"));
    mocks.apiProviders.mockResolvedValue(page([], "api"));
  });

  it("shows Space Gateway as the pane's account and its ChatGPT accounts for their quota only", async () => {
    mocks.codex.mockResolvedValue(page([codexAccount("kate", 90, 72), codexAccount("leo", 0, 80, "plus")], "space-gateway"));
    render(<CodexAccountPicker paneTitle="Kate" />);
    const trigger = screen.getByRole("button", { name: "ChatGPT account for Kate" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "ChatGPT account for Kate" });
    const [gateway] = within(menu).getAllByRole("menuitemradio");
    expect(gateway!.getAttribute("aria-checked")).toBe("true");
    expect(within(gateway!).getByText("Space Gateway")).toBeTruthy();
    await waitFor(() => expect(within(gateway!).getByText("1 of 2 pooled accounts ready")).toBeTruthy());
    expect(within(gateway!).getByText("72%")).toBeTruthy();
    expect(within(menu).getByText("Space Gateway picks the account")).toBeTruthy();

    const pool = within(menu).getByRole("group", { name: "Accounts Space Gateway picks from" });
    const [kate, leo] = within(pool).getAllByRole("menuitem");
    expect(kate!.getAttribute("aria-disabled")).toBe("true");
    expect(within(kate!).getByText("Pro")).toBeTruthy();
    expect(within(kate!).getByText("5h 90% · Week 72%")).toBeTruthy();
    expect(leo!.getAttribute("data-tone")).toBe("blocked");
    expect(within(leo!).getByText("Plus")).toBeTruthy();

    // Arrow keys move between choices only; the pooled accounts cannot be picked one by one.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(gateway);
    fireEvent.click(leo!);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("stays hidden once Space Gateway reports no ChatGPT accounts", async () => {
    mocks.codex.mockResolvedValue(page([], "space-gateway"));
    render(<CodexAccountPicker paneTitle="Kate" />);
    fireEvent.click(screen.getByRole("button", { name: "ChatGPT account for Kate" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "ChatGPT account for Kate" })).toBeNull());
  });
});

describe("balanced CLI accounts", () => {
  const usage = (remainingPercent: number | null, status: "OK" | "UNKNOWN" | "NOT_CONNECTED" | "GATEWAY" | "ERROR" = "OK") => ({
    status, plan: status === "OK" ? "Copilot Pro" : null, remainingPercent, resetAt: at(3 * 24 * 60),
    windows: remainingPercent === null ? [] : [{ id: "premium", label: "Premium requests", remainingPercent, resetAt: at(3 * 24 * 60) }],
  });
  const balance = (profiles: Array<[string, ReturnType<typeof usage>, string | null]>, next: string | null) => ({
    runtimeId: "cli:copilot" as const,
    profiles: profiles.map(([profileId, entryUsage, exhaustedUntil]) => ({ profileId, displayName: profileId, usage: entryUsage, exhaustedUntil,
      available: entryUsage.status === "OK" && !exhaustedUntil })),
    next,
    checkedAt: sampledAt,
  });
  const signedIn = (profileId: string) => ({ runtimeId: "cli:copilot" as const, profileId, displayName: profileId, email: null, authStatus: "CONNECTED" as const });

  beforeEach(() => {
    resetSharedQuotaCacheForTests();
    resetCliAccountIdentitiesForTests();
    resetCliAccountBalanceForTests();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.codex.mockResolvedValue(page([], "codex"));
    mocks.agy.mockResolvedValue(page([], "agy"));
    mocks.apiProviders.mockResolvedValue(page([], "api"));
    mocks.claude.mockResolvedValue(page([], "space-claude-profiles"));
    mocks.identities.mockResolvedValue({ accounts: [signedIn("main"), signedIn("work")], checkedAt: sampledAt });
  });

  it("judges Copilot, Cursor and Kimi accounts by the quota their CLI reports and the limits Space saw", () => {
    const clock = NOW;
    const sample = balance([["main", usage(40), null], ["work", usage(70), at(90)], ["spare", usage(null, "UNKNOWN"), null], ["gone", usage(null, "NOT_CONNECTED"), null],
      ["empty", usage(0), null]], "main");
    const judge = (profileId: string) => cliAccountAvailability({ runtimeId: "cli:copilot", profileId, quota: null, identity: signedIn(profileId), clock, balance: sample });
    expect(judge("main")).toMatchObject({ tone: "ready", percent: 40, label: "40%", windows: [{ label: "Premium requests", percent: 40 }] });
    expect(judge("main").description).toMatch(/Premium requests 40% \(resets at /);
    expect(judge("work")).toMatchObject({ tone: "blocked", color: CLI_ACCOUNT_BLOCKED_COLOR });
    expect(judge("work").description).toContain("reached its limit");
    expect(judge("spare")).toMatchObject({ tone: "neutral", label: "Signed in" });
    expect(judge("gone")).toMatchObject({ tone: "blocked", label: "Not signed in" });
    expect(judge("empty").tone).toBe("blocked");
    // Another CLI's balance never colors this one.
    expect(cliAccountAvailability({ runtimeId: "cli:kimi", profileId: "main", quota: null, identity: signedIn("main"), clock, balance: sample }).tone).toBe("neutral");
    expect(cliAccountPlan("cli:copilot", "main", null, sample)).toBe("Copilot Pro");
    expect(cliAccountPlan("cli:copilot", "spare", null, sample)).toBeNull();
  });

  it("shows each account's quota and the account Auto would start on", async () => {
    mocks.balance.mockResolvedValue(balance([["main", usage(30), null], ["work", usage(80), null]], "work"));
    render(
      <CliAccountPicker
        runtimeId="cli:copilot"
        providerLabel="GitHub"
        icon={<span />}
        paneTitle="Copilot pane"
        profiles={[profile("main"), profile("work")]}
        selectedProfileId="main"
        onSelect={vi.fn()}
        auto={{ active: false, onSelect: vi.fn() }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "GitHub account for Copilot pane" }));
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getAllByRole("menuitemradio")[0]!.textContent).toContain("Would start on work"));
    expect(mocks.balance).toHaveBeenCalledWith("cli:copilot");
    const [, main, work] = within(menu).getAllByRole("menuitemradio");
    expect(main!.textContent).toContain("30%");
    expect(main!.textContent).toContain("Copilot Pro");
    expect(work!.textContent).toContain("80%");
  });
});

// Operator 31/10 16:59 BKK: every picker shows "X% free at <reset>", or "Unknown" with the reason where the provider reports nothing.
describe("share free at reset in every account picker", () => {
  const head = async (props: Parameters<typeof CliAccountPicker>[0]) => {
    render(<CliAccountPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: `${props.providerLabel} account for ${props.paneTitle}` }));
    const menu = await screen.findByRole("menu");
    return () => Array.from(menu.querySelectorAll(".cli-account-menu-forecast")).map((entry) => ({
      text: entry.textContent, known: entry.getAttribute("data-known"), title: entry.getAttribute("title") }));
  };
  const picker = (runtimeId: Parameters<typeof CliAccountPicker>[0]["runtimeId"], providerLabel: string, extra: Partial<Parameters<typeof CliAccountPicker>[0]> = {}) =>
    ({ runtimeId, providerLabel, icon: <span />, paneTitle: "pane", profiles: [profile("main")], selectedProfileId: "main", onSelect: vi.fn(), ...extra });
  const group = (weekly: number | null, resetAt: string | null) => ({ displayName: "Models", fiveHourRemainingPercent: null, fiveHourResetAt: null, weeklyRemainingPercent: weekly, weeklyResetAt: resetAt });
  const balanceOf = (runtimeId: string, windows: Array<{ id: string; remainingPercent: number; resetAt: string }>) => ({
    runtimeId, next: "main", checkedAt: sampledAt,
    profiles: [{ profileId: "main", displayName: "main", exhaustedUntil: null, available: true,
      usage: { status: "OK", plan: null, remainingPercent: 50, resetAt: null, windows: windows.map((window) => ({ ...window, label: window.id })) } }],
  });

  beforeEach(() => {
    resetSharedQuotaCacheForTests();
    resetCliAccountIdentitiesForTests();
    resetCliAccountBalanceForTests();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.voiceInput.mockReturnValue(null);
    mocks.codex.mockResolvedValue(page([], "codex"));
    mocks.agy.mockResolvedValue(page([], "agy"));
    mocks.apiProviders.mockResolvedValue(page([], "api"));
    mocks.claude.mockResolvedValue(page([], "space-claude-profiles"));
    mocks.identities.mockResolvedValue({ accounts: [], checkedAt: sampledAt });
  });

  it("Claude: the subscription accounts' weekly figure", async () => {
    mocks.claude.mockResolvedValue(page([claudeAccount("main", 90, 80)], "space-claude-profiles"));
    const forecasts = await head(picker("cli:claude", "Claude"));
    await waitFor(() => expect(forecasts()).toMatchObject([{ known: "true", text: expect.stringMatching(/^\d+% now\d+% free (at|in) /) }]));
  });

  it("ChatGPT (Codex): the pooled accounts' weekly figure", async () => {
    mocks.codex.mockResolvedValue(page([codexAccount("kate", 90, 72)], "space-gateway"));
    render(<CodexAccountPicker paneTitle="Kate" />);
    fireEvent.click(screen.getByRole("button", { name: "ChatGPT account for Kate" }));
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(menu.querySelector('.cli-account-menu-forecast[data-known="true"]')?.textContent).toMatch(/^\d+% now\d+% free (at|in) /));
  });

  it("Google: the pane's model group only; a group Google does not report reads Unknown with the reason", async () => {
    // Stable 31/10: Antigravity's quota report lists only Claude · GPT; the Gemini group is empty for every account.
    // 8/11: When the pane runs a Gemini model, only the Gemini forecast appears; Claude · GPT stays out.
    mocks.agy.mockResolvedValue(page([{ id: "main", label: "main", email: null, tier: "Google AI Pro", status: "CONNECTED", gemini: group(null, null),
      claude: group(88.8, at(4 * 24 * 60)), sampledAt }], "agy"));
    const forecasts = await head(picker("cli:gemini", "Google", { modelId: "gemini-3.8-flash" }));
    await waitFor(() => expect(forecasts()).toMatchObject([
      { known: "false", text: "UnknownGemini free at reset", title: expect.stringContaining("Google reported no current Gemini weekly limit for the 1 signed-in account") },
    ]));
  });

  it("GitHub Copilot: the monthly premium requests", async () => {
    mocks.balance.mockResolvedValue(balanceOf("cli:copilot", [{ id: "premium_interactions", remainingPercent: 80, resetAt: at(15 * 24 * 60) }]));
    const forecasts = await head(picker("cli:copilot", "GitHub", { auto: { active: false, onSelect: vi.fn() } }));
    await waitFor(() => expect(forecasts()).toMatchObject([{ known: "true", title: expect.stringContaining("monthly") }]));
  });

  it("Kimi: the weekly limit", async () => {
    mocks.balance.mockResolvedValue(balanceOf("cli:kimi", [{ id: "limit_5h", remainingPercent: 5, resetAt: at(60) }, { id: "limit_7d", remainingPercent: 60, resetAt: at(4 * 24 * 60) }]));
    const forecasts = await head(picker("cli:kimi", "Kimi", { profiles: [profile("main"), profile("work")], auto: { active: false, onSelect: vi.fn() } }));
    await waitFor(() => expect(forecasts()).toMatchObject([{ known: "true", title: expect.stringContaining("weekly") }]));
  });

  it("Cursor: no period that resets, so Unknown with the reason", async () => {
    mocks.balance.mockResolvedValue(balanceOf("cli:cursor", []));
    const forecasts = await head(picker("cli:cursor", "Cursor", { auto: { active: false, onSelect: vi.fn() } }));
    await waitFor(() => expect(forecasts()).toMatchObject([{ known: "false", text: "Unknownfree at reset",
      title: expect.stringContaining("None of the 1 account reported a quota period that resets") }]));
  });
});

// Stable 31/10: a phone's Codex menu shut itself as the pane attached its CLI (pending disables the picker).
describe("account menu while the pane starts its CLI", () => {
  beforeEach(() => {
    resetSharedQuotaCacheForTests();
    resetCliAccountIdentitiesForTests();
    resetCliAccountBalanceForTests();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.voiceInput.mockReturnValue(null);
    mocks.codex.mockResolvedValue(page([], "codex"));
    mocks.agy.mockResolvedValue(page([], "agy"));
    mocks.apiProviders.mockResolvedValue(page([], "api"));
    mocks.claude.mockResolvedValue(page([claudeAccount("ops", 90, 80), claudeAccount("lab", 90, 50)], "space-claude-profiles"));
    mocks.identities.mockResolvedValue({ accounts: [], checkedAt: sampledAt });
  });

  it("stays open to read and lets the switch wait until the pane is ready", async () => {
    const onSelect = vi.fn();
    const props = { runtimeId: "cli:claude" as const, providerLabel: "Claude", icon: <span />, paneTitle: "pane",
      profiles: [profile("ops"), profile("lab")], selectedProfileId: "ops", onSelect };
    const { rerender } = render(<CliAccountPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Claude account for pane" }));
    await screen.findByRole("menu");
    rerender(<CliAccountPicker {...props} disabled />);
    const menu = screen.getByRole("menu");
    const lab = within(menu).getAllByRole("menuitemradio")[1]!;
    expect(lab.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(lab);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    rerender(<CliAccountPicker {...props} />);
    fireEvent.click(within(screen.getByRole("menu")).getAllByRole("menuitemradio")[1]!);
    expect(onSelect).toHaveBeenCalledWith("lab");
  });
});
