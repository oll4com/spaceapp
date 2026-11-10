import { describe, expect, it } from "vitest";
import { createPaceDayStarts } from "@space/db";
import type { GatewayAccount } from "@space/contracts";
import {
  accountStatusForPermanentFailure, burstSameAccountBackoffSeconds, evaluateHealthTier, fillFirstWindowStarted, failoverDecision, handlePermanentFailure,
  handleQuotaExceeded, handleRateLimit, HEALTH_TIER_DRAINING, HEALTH_TIER_HEALTHY, HEALTH_TIER_PROBING, NOUS_OPERATOR_PROJECT, PACE_CAP, paceCapApplies, paceRank, weekShort,
  selectAccount, selectPlanTier, type AccountState
} from "../src/router/balancer.js";
import { createPriorityPanes } from "../src/admin/priority-panes.js";
import { backoffSeconds, parseRetryAfter } from "../src/router/retry.js";

const now = 1_700_000_000;
function account(accountId: string, overrides: Partial<AccountState> = {}): AccountState {
  return { accountId, status: "ACTIVE", errorCount: 0, healthTier: HEALTH_TIER_HEALTHY, ...overrides };
}
const pick = (states: AccountState[], options: Parameters<typeof selectAccount>[1] = {}) => selectAccount(states, { now, ...options }).account?.accountId;

describe("retry hints (codex-lb parity)", () => {
  it("parses single, compound and word units", () => {
    expect(parseRetryAfter("Try again in 1.2s")).toBe(1.2);
    expect(parseRetryAfter("Try again in 500ms")).toBe(0.5);
    expect(parseRetryAfter("no retry info")).toBeNull();
    expect(parseRetryAfter("Try again in 20m")).toBe(1200);
    expect(parseRetryAfter("Please try again in 6m0s.")).toBe(360);
    expect(parseRetryAfter("Try again in 1h2m3s")).toBe(3723);
    expect(parseRetryAfter("Try again in 30 seconds")).toBe(30);
    expect(parseRetryAfter("Try again in 2 minutes")).toBe(120);
    expect(parseRetryAfter("Try again in 2 months")).toBeNull();
  });

  it("backs off exponentially with bounded jitter", () => {
    expect(backoffSeconds(1, () => 0.5)).toBeCloseTo(0.2);
    expect(backoffSeconds(3, () => 0.5)).toBeCloseTo(0.8);
    expect(backoffSeconds(1, () => 0)).toBeCloseTo(0.18);
    expect(backoffSeconds(1, () => 1)).toBeCloseTo(0.22);
  });
});

describe("account selection (codex-lb parity)", () => {
  it("usage weighted picks the lowest used percent", () => {
    expect(pick([account("a", { usedPercent: 50 }), account("b", { usedPercent: 10 })], { routingStrategy: "USAGE_WEIGHTED" })).toBe("b");
  });

  it("prefers the earlier secondary reset bucket, bucketed by day, when enabled", () => {
    const states = () => [
      account("a", { usedPercent: 10, secondaryUsedPercent: 10, secondaryResetAt: now + 3 * 86400 }),
      account("b", { usedPercent: 50, secondaryUsedPercent: 50, secondaryResetAt: now + 2 * 3600 })
    ];
    expect(pick(states(), { preferEarlierReset: true, routingStrategy: "USAGE_WEIGHTED" })).toBe("b");
    expect(pick(states(), { preferEarlierReset: false, routingStrategy: "USAGE_WEIGHTED" })).toBe("a");
    expect(pick([
      account("a", { usedPercent: 20, secondaryUsedPercent: 20, secondaryResetAt: now + 23 * 3600 }),
      account("b", { usedPercent: 10, secondaryUsedPercent: 10, secondaryResetAt: now + 3600 })
    ], { preferEarlierReset: true, routingStrategy: "USAGE_WEIGHTED" })).toBe("b");
    expect(pick([
      account("a", { usedPercent: 0, secondaryUsedPercent: 0, secondaryResetAt: null }),
      account("b", { usedPercent: 90, secondaryUsedPercent: 90, secondaryResetAt: now + 3600 })
    ], { preferEarlierReset: true, routingStrategy: "USAGE_WEIGHTED" })).toBe("b");
  });

  it("applies burn-first and preserve routing policies", () => {
    expect(pick([account("normal", { usedPercent: 1 }), account("temp", { usedPercent: 80, routingPolicy: "burn_first" })], { routingStrategy: "USAGE_WEIGHTED" })).toBe("temp");
    expect(pick([account("review", { usedPercent: 1, routingPolicy: "preserve" }), account("normal", { status: "REAUTH_REQUIRED", usedPercent: 95 })], { routingStrategy: "USAGE_WEIGHTED" })).toBe("normal");
    expect(pick([account("review", { usedPercent: 70, routingPolicy: "preserve" }), account("normal", { status: "RATE_LIMITED", usedPercent: 1, resetAt: now + 60 })], { routingStrategy: "USAGE_WEIGHTED" })).toBe("review");
  });

  it("skips rate-limited accounts until their reset and recovers them after", () => {
    expect(pick([account("a", { status: "RATE_LIMITED", usedPercent: 5, resetAt: now + 60 }), account("b", { usedPercent: 10 })])).toBe("b");
    const recovered = account("a", { status: "RATE_LIMITED", usedPercent: 99, resetAt: now - 1, errorCount: 2 });
    expect(pick([recovered], { routingStrategy: "USAGE_WEIGHTED" })).toBe("a");
    expect(recovered).toMatchObject({ status: "ACTIVE", usedPercent: 0, errorCount: 0, resetAt: null });
  });

  it("reports pool-wide usage exhaustion with the earliest exhausted reset", () => {
    const result = selectAccount([
      account("a", { status: "RATE_LIMITED", usedPercent: 100, resetAt: now + 600, primaryResetAt: now + 60 }),
      account("b", { status: "QUOTA_EXCEEDED", usedPercent: 100, resetAt: now + 7200, primaryResetAt: now + 3600 }),
      account("paused", { status: "PAUSED" })
    ], { now });
    expect(result).toEqual({ account: null, errorCode: "usage_limit_reached", errorMessage: "Rate limit exceeded. Try again in 60s", resetsAt: now + 60 });
    const secondary = selectAccount([account("a", { status: "RATE_LIMITED", usedPercent: 10, secondaryUsedPercent: 100, resetAt: now + 60, secondaryResetAt: now + 3600 })], { now });
    expect(secondary).toMatchObject({ errorCode: "usage_limit_reached", errorMessage: "Rate limit exceeded. Try again in 300s", resetsAt: now + 3600 });
  });

  it("fails over to the usable account and explains all-blocked pools", () => {
    expect(pick([account("exhausted", { status: "QUOTA_EXCEEDED", usedPercent: 100, resetAt: now + 3600 }), account("usable", { usedPercent: 40 })])).toBe("usable");
    expect(selectAccount([account("p", { status: "PAUSED" }), account("d", { status: "DEACTIVATED" })], { now }).errorMessage).toBe("All accounts are paused or deactivated");
    expect(selectAccount([account("p", { status: "PAUSED" })], { now }).errorMessage).toBe("All accounts are paused");
    expect(selectAccount([], { now }).errorMessage).toBe("No available accounts");
  });

  it("holds accounts in error backoff and falls back to the one that recovers first", () => {
    const first = account("a", { errorCount: 3, lastErrorAt: now - 10 });
    const second = account("b", { errorCount: 4, lastErrorAt: now - 10 });
    expect(pick([first, second])).toBe("a");
    expect(pick([account("a", { errorCount: 3, lastErrorAt: now - 10 })])).toBeUndefined();
    const served = account("c", { errorCount: 3, lastErrorAt: now - 31 });
    expect(pick([served], { routingStrategy: "USAGE_WEIGHTED" })).toBe("c");
    expect(served.errorCount).toBe(0);
  });

  it("round robin prefers the least recently selected and never-selected accounts", () => {
    expect(pick([
      account("a", { usedPercent: 90, lastSelectedAt: now - 2 }), account("b", { usedPercent: 10, lastSelectedAt: now - 30 }),
      account("c", { usedPercent: 5, lastSelectedAt: now - 5 })
    ], { routingStrategy: "ROUND_ROBIN" })).toBe("b");
    expect(pick([account("a", { usedPercent: 1, lastSelectedAt: now - 1 }), account("b", { usedPercent: 99, lastSelectedAt: null })], { routingStrategy: "ROUND_ROBIN" })).toBe("b");
  });

  it("round robin ties are deterministic per replica and spread across replicas", () => {
    const pool = () => Array.from({ length: 5 }, (_, index) => account(`acct-${index + 1}`, { usedPercent: 10 }));
    const winner = pick(pool(), { routingStrategy: "ROUND_ROBIN", replicaSalt: "replica-a" });
    expect(pick(pool(), { routingStrategy: "ROUND_ROBIN", replicaSalt: "replica-a" })).toBe(winner);
    const winners = new Set(Array.from({ length: 40 }, (_, index) => pick(pool(), { routingStrategy: "ROUND_ROBIN", replicaSalt: `replica-${index}` })));
    expect(winners.size).toBeGreaterThan(2);
  });

  it("single account, sequential drain and reset drain have one deterministic answer", () => {
    expect(pick([account("b"), account("a")], { routingStrategy: "SINGLE_ACCOUNT" })).toBe("a");
    expect(pick([
      account("pro", { usedPercent: 0, capacityCredits: 50_400 }), account("plus", { usedPercent: 0, capacityCredits: 7_560 }),
      account("free", { usedPercent: 95, capacityCredits: 1_134 })
    ], { routingStrategy: "SEQUENTIAL_DRAIN" })).toBe("free");
    expect(pick([
      account("soon-5h-late-weekly", { usedPercent: 10, secondaryUsedPercent: 10, resetAt: now + 300, secondaryResetAt: now + 5 * 86400 }),
      account("later-5h-soon-weekly", { usedPercent: 50, secondaryUsedPercent: 20, resetAt: now + 7200, secondaryResetAt: now + 2 * 86400 }),
      account("middle", { usedPercent: 0, secondaryUsedPercent: 0, resetAt: now + 1800, secondaryResetAt: now + 3 * 86400 })
    ], { routingStrategy: "RESET_DRAIN" })).toBe("later-5h-soon-weekly");
  });

  it("fill first drains the busiest account, weekly usage breaking ties", () => {
    expect(pick([
      account("fresh", { usedPercent: 0 }), account("busy", { usedPercent: 60, secondaryUsedPercent: 10 }),
      account("busier-weekly", { usedPercent: 60, secondaryUsedPercent: 40 })
    ], { routingStrategy: "FILL_FIRST" })).toBe("busier-weekly");
  });

  it("capacity weighted draws by remaining weekly credits", () => {
    const states = () => [
      account("plus", { planType: "plus", usedPercent: 0, secondaryUsedPercent: 0 }),
      account("pro", { planType: "pro", usedPercent: 0, secondaryUsedPercent: 0 })
    ];
    // plus has 7560 credits, pro 50400: a draw below 7560/57960 lands on plus.
    expect(pick(states(), { routingStrategy: "CAPACITY_WEIGHTED", random: () => 0.05 })).toBe("plus");
    expect(pick(states(), { routingStrategy: "CAPACITY_WEIGHTED", random: () => 0.5 })).toBe("pro");
    expect(pick([account("spent", { planType: "plus", secondaryUsedPercent: 100 }), account("left", { planType: "plus", secondaryUsedPercent: 50 })],
      { routingStrategy: "CAPACITY_WEIGHTED", random: () => 0 })).toBe("left");
  });

  it("prefers healthy accounts over draining ones and admits a due probe", () => {
    expect(pick([account("draining", { healthTier: HEALTH_TIER_DRAINING, usedPercent: 1 }), account("healthy", { usedPercent: 50 })], { routingStrategy: "USAGE_WEIGHTED" })).toBe("healthy");
    expect(pick([
      account("probe", { healthTier: HEALTH_TIER_PROBING, usedPercent: 80, lastSelectedAt: now - 120 }),
      account("healthy", { usedPercent: 1 })
    ], { routingStrategy: "USAGE_WEIGHTED" })).toBe("probe");
  });

  it("keeps opportunistic traffic off the last normal account's emergency floor", () => {
    const result = selectAccount([account("only", { usedPercent: 97, secondaryUsedPercent: 50 })], { now, trafficClass: "opportunistic" });
    expect(result.account).toBeNull();
    expect(result.errorMessage).toMatch(/^opportunistic burn window closed/);
  });
});

// Operator rule 2026-10-27 (plan clipboard:nUloPOH3blDT): every account's week used, none run out before its reset.
describe("weekly pace first (Space fork)", () => {
  const week = 7 * 86_400;
  // Gateway, 27/10: ntheogr used 45% of its week with 19% of it passed (+26, ahead); niggmopai 8% at 14% (-6).
  const ntheogr = () => account("ntheogr", { planType: "plus", usedPercent: 61, secondaryUsedPercent: 45, secondaryResetAt: now + 0.81 * week });
  const niggmopai = () => account("niggmopai", { planType: "prolite", usedPercent: null, secondaryUsedPercent: 8, secondaryResetAt: now + 0.86 * week });

  it("serves new work from the account furthest under its weekly pace, over the plan tiers, ahead-of-pace accounts last", () => {
    expect(pick([ntheogr(), niggmopai()], { planPriority: ["plus", "prolite", "pro"] })).toBe("ntheogr");
    expect(pick([ntheogr(), niggmopai()], { planPriority: ["plus", "prolite", "pro"], weeklyPace: true })).toBe("niggmopai");
    // Claude Max: lab 39% at 67% of its week (-28) is further under pace than ntheo 54% at 79% (-25).
    const ntheo = account("ntheo", { usedPercent: 36, secondaryUsedPercent: 54, secondaryResetAt: now + 0.21 * week });
    const lab = account("lab", { usedPercent: 18, secondaryUsedPercent: 39, secondaryResetAt: now + 0.33 * week });
    const ahead = account("ahead", { usedPercent: 0, secondaryUsedPercent: 90, secondaryResetAt: now + 0.5 * week });
    expect(pick([ahead, ntheo, lab], { routingStrategy: "CAPACITY_WEIGHTED", weeklyPace: true })).toBe("lab");
    expect(pick([ahead, ntheo], { weeklyPace: true })).toBe("ntheo");
    // A limited account still never serves; unknown or reset weeks count as on pace, the plan tier and 5-hour use break ties.
    expect(pick([account("limited", { status: "RATE_LIMITED", resetAt: now + 600, secondaryUsedPercent: 0, secondaryResetAt: now + week }), ahead], { weeklyPace: true })).toBe("ahead");
    expect(pick([account("pro", { planType: "pro", usedPercent: 0 }), account("plus", { planType: "plus", usedPercent: 50, secondaryUsedPercent: 70, secondaryResetAt: now - 1 })],
      { planPriority: ["plus", "pro"], weeklyPace: true })).toBe("plus");
  });

  // Operator 5/11 («μην χάνετε ούτε ένα token»): a week that resets within a day with room left loses it unused, so it serves first.
  it("serves first a week that resets within a day with more than 15% left, even when another is further under its pace", () => {
    // crew 60% with 19 hours left (-29) against ntheo, a fresh week at 0% (-1): crew's 40% would reset unused.
    const crew = (used: number) => account("crew", { usedPercent: 10, secondaryUsedPercent: used, secondaryResetAt: now + 19 * 3600 });
    const fresh = account("ntheo", { usedPercent: 0, secondaryUsedPercent: 0, secondaryResetAt: now + 0.99 * week });
    const under = account("lab", { usedPercent: 0, secondaryUsedPercent: 10, secondaryResetAt: now + 0.3 * week });
    expect(pick([under, fresh, crew(60)], { weeklyPace: true })).toBe("crew");
    // 15% or less left within the day: the weekly pace decides again (lab, -60, before crew, -6).
    expect(pick([under, fresh, crew(90)], { weeklyPace: true })).toBe("lab");
  });

  // Plan clipboard:ctqx7SPqkWR2 step 4 (1/11: dev and lab, furthest under pace, took every new conversation to 100% of 5 hours).
  it("sends new work past an account over 85% of its 5-hour window while another is under it, and back when none is", () => {
    const lab = (fiveHour: number) => account("lab", { usedPercent: fiveHour, primaryResetAt: now + 3600, secondaryUsedPercent: 0, secondaryResetAt: now + 0.67 * week });
    // crew's week resets in 2 days, so a day's use-it-or-lose-it preference does not apply here.
    const crew = account("crew", { usedPercent: 44, primaryResetAt: now + 3 * 3600, secondaryUsedPercent: 62, secondaryResetAt: now + 0.3 * week });
    expect(pick([lab(80), crew], { weeklyPace: true })).toBe("lab");
    expect(pick([lab(90), crew], { weeklyPace: true })).toBe("crew");
    expect(pick([lab(90), crew], { weeklyPace: true, fiveHourSoftCapPercent: 95 })).toBe("lab");
    // Every account past the cap: the pace order holds (the exhaustion floor still guards 100%).
    expect(pick([lab(90), account("crew", { usedPercent: 92, primaryResetAt: now + 3600, secondaryUsedPercent: 62, secondaryResetAt: now + 0.3 * week })], { weeklyPace: true })).toBe("lab");
  });

  // Goal d844e0cc (28/10: ntheo at 88% of its week, 12 h to its reset, still first): the floor keeps an account off 100%.
  it("skips an account at the exhaustion floor of its week or 5 hours while another has room", () => {
    const nearlyOut = () => account("out", { usedPercent: 10, secondaryUsedPercent: 98, secondaryResetAt: now + 0.05 * week });
    const busy = () => account("busy", { usedPercent: 20, secondaryUsedPercent: 90, secondaryResetAt: now + 0.5 * week });
    // (c) floor 0 changes nothing: "out" is furthest under pace (+3 against +40).
    expect(pick([nearlyOut(), busy()], { weeklyPace: true, exhaustionFloorPercent: 0 })).toBe("out");
    // (a) the default floor 3 and the configured one; (e) the 5-hour window the same way.
    expect(pick([nearlyOut(), busy()], { weeklyPace: true })).toBe("busy");
    expect(pick([nearlyOut(), busy()], { weeklyPace: true, exhaustionFloorPercent: 3 })).toBe("busy");
    const fiveHourOut = account("five", { usedPercent: 98, primaryResetAt: now + 3600, secondaryUsedPercent: 10, secondaryResetAt: now + 0.5 * week });
    expect(pick([fiveHourOut, busy()], { weeklyPace: true })).toBe("busy");
    // (b) every account at or past the floor: the original pick holds, never "No available accounts".
    const alsoOut = account("also", { usedPercent: 97, primaryResetAt: now + 3600, secondaryUsedPercent: 90, secondaryResetAt: now + 0.5 * week });
    expect(pick([nearlyOut(), alsoOut], { weeklyPace: true })).toBe("out");
    // (d) unknown usage and a window whose reset passed are never dropped.
    const unknown = account("unknown", { usedPercent: null, secondaryUsedPercent: null });
    expect(pick([unknown, busy()], { weeklyPace: true })).toBe("unknown");
    const reset = account("reset", { usedPercent: 99, primaryResetAt: now - 1, secondaryUsedPercent: 99, secondaryResetAt: now - 1 });
    expect(pick([reset, busy()], { weeklyPace: true })).toBe("reset");
  });
});

describe("plan priority tiers (Space fork of codex-lb)", () => {
  it("drains the first configured plan tier, least-used 5h account first", () => {
    const states = [
      account("pro-idle", { planType: "pro", usedPercent: 0 }),
      account("plus-busy", { planType: "plus", usedPercent: 70, secondaryUsedPercent: 10 }),
      account("plus-light", { planType: "plus", usedPercent: 20, secondaryUsedPercent: 90 })
    ];
    expect(pick(states, { planPriority: ["plus", "prolite", "pro"] })).toBe("plus-light");
    expect(pick(states, { planPriority: ["pro", "plus"] })).toBe("pro-idle");
  });

  it("moves to the next tier only when the first tier has no eligible account", () => {
    const states = [
      account("plus", { planType: "plus", status: "QUOTA_EXCEEDED", resetAt: now + 3600, usedPercent: 100 }),
      account("prolite", { planType: "Pro Lite", usedPercent: 40 }),
      account("pro", { planType: "pro", usedPercent: 0 })
    ];
    expect(pick(states, { planPriority: ["plus", "prolite", "pro"] })).toBe("prolite");
    expect(selectPlanTier([account("team", { planType: "team" })], ["plus"]).map((state) => state.accountId)).toEqual(["team"]);
  });
});

describe("failure handling (codex-lb parity)", () => {
  it("rate limits honor retry hints, upstream resets and a floored persisted deadline", () => {
    const hinted = account("a", { usedPercent: 5 });
    handleRateLimit(hinted, { message: "Try again in 1.5s" }, now);
    expect(hinted).toMatchObject({ status: "RATE_LIMITED", errorCount: 1, blockedAt: now });
    expect(hinted.cooldownUntil).toBeCloseTo(now + 1.5);
    const bare = account("b");
    handleRateLimit(bare, { message: "Rate limit exceeded." }, now, () => 0.5);
    expect(bare.cooldownUntil).toBeCloseTo(now + 0.2);
    expect(bare.resetAt).toBe(now + 30);
    const long = account("c");
    handleRateLimit(long, { message: "Try again in 20m" }, now);
    expect(long.resetAt).toBe(now + 1200);
    const withReset = account("d");
    handleRateLimit(withReset, { message: "Try again in 20m", resetsAt: now + 90.2 }, now);
    expect(withReset.resetAt).toBe(now + 91);
    const implausible = account("e");
    handleRateLimit(implausible, { message: "Try again in 5s", resetsAt: now + 400 * 86400 }, now);
    expect(implausible.resetAt).toBe(now + 5);
  });

  it("quota exceeded blocks the account until its reset", () => {
    const state = account("a");
    handleQuotaExceeded(state, { resetsInSeconds: 600 }, now);
    expect(state).toMatchObject({ status: "QUOTA_EXCEEDED", usedPercent: 100, resetAt: now + 600, cooldownUntil: now + 120 });
    const unknown = account("b");
    handleQuotaExceeded(unknown, {}, now);
    expect(unknown.resetAt).toBe(now + 3600);
  });

  it("permanent failures ask for re-login or deactivate", () => {
    expect(accountStatusForPermanentFailure("refresh_token_reused")).toBe("REAUTH_REQUIRED");
    expect(accountStatusForPermanentFailure("account_suspended")).toBe("DEACTIVATED");
    const state = account("a", { blockedAt: now });
    handlePermanentFailure(state, "mystery");
    expect(state).toMatchObject({ status: "DEACTIVATED", deactivationReason: "Authentication failed: mystery", blockedAt: null });
  });

  it("decides failover only before the client has seen output", () => {
    expect(failoverDecision({ failureClass: "rate_limit", downstreamVisible: true, candidatesRemaining: 3 })).toBe("surface");
    expect(failoverDecision({ failureClass: "rate_limit", downstreamVisible: false, candidatesRemaining: 3 })).toBe("failover_next");
    expect(failoverDecision({ failureClass: "non_retryable", downstreamVisible: false, candidatesRemaining: 3 })).toBe("surface");
    expect(failoverDecision({ failureClass: "quota", downstreamVisible: false, candidatesRemaining: 0 })).toBe("surface");
    expect(failoverDecision({ failureClass: "quota", downstreamVisible: false, candidatesRemaining: 3, ownerBound: true, sameAccountRetryAvailable: true })).toBe("retry_same_account");
    expect(failoverDecision({ failureClass: "quota", downstreamVisible: false, candidatesRemaining: 3, ownerBound: true })).toBe("surface");
    expect(burstSameAccountBackoffSeconds(1, null)).toBe(1);
    expect(burstSameAccountBackoffSeconds(3, null)).toBe(4);
    expect(burstSameAccountBackoffSeconds(2, 7)).toBe(7);
    expect(burstSameAccountBackoffSeconds(9, null)).toBe(10);
  });

  it("moves health tiers healthy -> draining -> probing -> healthy", () => {
    expect(evaluateHealthTier(account("a", { usedPercent: 90 }), { now })).toBe(HEALTH_TIER_DRAINING);
    const draining = account("b", { healthTier: HEALTH_TIER_DRAINING, usedPercent: 10 });
    expect(evaluateHealthTier(draining, { now, drainEnteredAt: now - 30 })).toBe(HEALTH_TIER_DRAINING);
    expect(evaluateHealthTier(draining, { now, drainEnteredAt: now - 61 })).toBe(HEALTH_TIER_PROBING);
    const probing = account("c", { healthTier: HEALTH_TIER_PROBING, usedPercent: 10 });
    expect(evaluateHealthTier(probing, { now, probeSuccessStreak: 2 })).toBe(HEALTH_TIER_PROBING);
    expect(evaluateHealthTier(probing, { now, probeSuccessStreak: 3 })).toBe(HEALTH_TIER_HEALTHY);
  });
});

// Operator 3/11 13:09 BKK: one account at a time until ~93% of its 5 hours, so the 5-hour resets come apart.
describe("fill first (Space fork)", () => {
  const week = 7 * 86_400;
  const max = (accountId: string, fiveHour: number | null, weekUsed: number, weekLeft: number) =>
    account(accountId, { usedPercent: fiveHour, primaryResetAt: fiveHour ? now + 3600 : null, secondaryUsedPercent: weekUsed, secondaryResetAt: now + weekLeft * week });
  const fill = (states: AccountState[], reserve: "NORMAL" | "PRIORITY" | null = null, reservePercent?: number) =>
    selectAccount(states, { now, weeklyPace: true, fillFirst: { reserve, reservePercent } });

  it("drains the earliest weekly reset first, using started windows only for equal-reset ties", () => {
    // 3/11: ntheo 27% of its week used, 2 days to its reset; lab 40%, 5 days.
    const ntheo = max("ntheo", null, 27, 2 / 7);
    const lab = max("lab", null, 40, 5 / 7);
    expect(fill([lab, ntheo]).account?.accountId).toBe("ntheo");
    // A later-reset started window cannot outrank an earlier-reset fresh window.
    expect(fill([max("lab", 60, 40, 5 / 7), ntheo]).account?.accountId).toBe("ntheo");
    expect(fill([max("lab", 60, 40, 5 / 7), max("crew", 85, 50, 4 / 7), ntheo]).account?.accountId).toBe("ntheo");
    expect(fill([max("lab", 93, 40, 5 / 7), ntheo]).account?.accountId).toBe("ntheo");
    // A window whose reset passed counts as fresh.
    expect(fill([account("lab", { usedPercent: 90, primaryResetAt: now - 1, secondaryUsedPercent: 40, secondaryResetAt: now + week / 2 }), max("crew", 10, 50, 0.5)]).account?.accountId).toBe("crew");
  });

  it("4/11: drains ntheo, lab, dev before future-reset crew/ops, even with their windows started", () => {
    const states = [max("crew", 80, 45, 112 / 168), max("ops", 70, 51, 103 / 168),
      max("dev", 0, 66, 44 / 168), max("lab", 0, 72, 42 / 168), max("ntheo", 0, 80, 23 / 168)];
    for (const name of ["ntheo", "lab", "dev"]) {
      expect(fill(states).account?.accountId).toBe(name);
      expect(fill(states, "NORMAL").account?.accountId).toBe(name);
      states.find((state) => state.accountId === name)!.usedPercent = 95;
    }
    expect(fill(states).account?.accountId).toBe("ops");
  });

  it("never takes an account past 95% of its week while another has room, unless its week resets within 24 h", () => {
    expect(fill([max("out", 10, 96, 0.5), max("crew", null, 50, 0.6)]).account?.accountId).toBe("crew");
    // Every window past its cap: the most room among weeks under theirs; every week past: the pace rule (the floor guards 100%).
    expect(fill([max("out", 10, 96, 0.5), max("five", 95, 20, 0.6)]).account?.accountId).toBe("five");
    expect(fill([max("out", 10, 96, 0.5), max("full", 20, 97, 0.6)]).account?.accountId).toBe("out");
    // A week that resets within 24 h loses its room anyway: served up to a real 100%, floor included.
    expect(fill([max("out", 10, 98, 0.1), max("crew", null, 50, 0.6)]).account?.accountId).toBe("out");
    expect(fill([max("out", 10, 100, 0.1), max("crew", null, 50, 0.6)]).account?.accountId).toBe("crew");
  });

  it("4/11 09:42Z: NORMAL work drains ntheo (week 95%, reset in 16 h) instead of refusing every request", () => {
    const at = (iso: string) => Date.parse(iso) / 1000;
    const clock = at("2026-11-04T09:42:00Z");
    const claude = (accountId: string, fiveHour: number, weekUsed: number, weekReset: string) =>
      account(accountId, { usedPercent: fiveHour, primaryResetAt: clock + 3600, secondaryUsedPercent: weekUsed, secondaryResetAt: at(weekReset) });
    const states = () => [claude("ntheo", 14, 95, "2026-11-05T02:00:00Z"), claude("crew", 80, 58, "2026-11-08T19:00:00Z"),
      claude("dev", 98, 80, "2026-11-05T23:00:00Z"), claude("lab", 97, 93, "2026-11-05T21:00:00Z"), claude("ops", 99, 64, "2026-11-08T10:00:00Z")];
    const pick = (pool: AccountState[]) => selectAccount(pool, { now: clock, weeklyPace: true, fillFirst: { reserve: "NORMAL" } });
    expect(pick(states())).toMatchObject({ account: { accountId: "ntheo" }, errorMessage: null });
    // Three days from its reset the weekly cap still holds ntheo back, and the refusal says so instead of "5-hour limit".
    const far = states();
    far[0]!.secondaryResetAt = clock + 3 * 86_400;
    const refused = selectAccount(far, { now: clock, weeklyPace: true, fillFirst: { reserve: "NORMAL" }, accountNames: { ntheo: "ntheo@spaceapp.dev" } });
    expect(refused).toMatchObject({ account: null, errorCode: "usage_limit_reached", reserved: true });
    expect(refused.errorMessage).toContain("ntheo@spaceapp.dev weekly 95% (cap 95%)");
    expect(refused.errorMessage).toContain("dev 5-hour 98%");
    expect(refused.errorMessage).toContain("the last one with room, crew (5-hour 80%), is kept for Nous's answers to the operator");
  });

  it("keeps later-renewing capacity for the operator's turns", () => {
    const states = () => [max("lab", 60, 40, 5 / 7), max("crew", null, 50, 6 / 7), max("ntheo", null, 27, 2 / 7)];
    // Normal work fills ntheo; the latest reset, crew, is the reserve.
    expect(fill(states(), "NORMAL").account?.accountId).toBe("ntheo");
    expect(fill([max("lab", 93, 40, 5 / 7), ...states().slice(1)], "NORMAL").account?.accountId).toBe("ntheo");
    // Only the reserve has room under the cap while the pool runs short before a reset (lab's 5 hours began 30 min ago): normal work takes
    // accounts past the cap first, then the reserve up to 80% (20% kept for Nous). Lab's 5 hours back within the hour: nothing is kept.
    const lab95 = (resetIn: number) => account("lab", { usedPercent: 95, primaryResetAt: now + resetIn, secondaryUsedPercent: 40, secondaryResetAt: now + (5 / 7) * week });
    expect(fill([lab95(4.5 * 3600), max("crew", null, 50, 6 / 7)], "NORMAL").account?.accountId).toBe("lab");
    expect(fill([lab95(3600), max("crew", null, 50, 6 / 7)], "NORMAL").account?.accountId).toBe("crew");
    expect(fill([max("crew", 58, 50, 6 / 7)], "NORMAL").account?.accountId).toBe("crew");
    expect(fill([max("crew", 79, 50, 6 / 7)], "NORMAL").account?.accountId).toBe("crew");
    const held = fill([max("crew", 80, 50, 6 / 7), max("lab", 99, 40, 5 / 7)], "NORMAL");
    expect(held.account).toBeNull();
    expect(held.errorCode).toBe("usage_limit_reached");
    expect(fill([max("crew", 80, 50, 6 / 7), max("lab", 99, 40, 5 / 7)], "PRIORITY").account?.accountId).toBe("crew");
    expect(fill([max("crew", 80, 50, 6 / 7), max("lab", 99, 40, 5 / 7)], "NORMAL", 10).account?.accountId).toBe("crew");
    expect(fill([max("crew", 80, 50, 6 / 7), max("lab", 99, 40, 5 / 7)], "NORMAL", 0).account?.accountId).toBe("crew");
  });

  // Operator 5/11 (nous_msg:3723fc28): the 3% floor, the 95% weekly cap and the 20% for the operator hold only while the pool runs short before a reset.
  it("keeps the floors and the operator's reserve only while the pool runs short before its next reset", () => {
    const hour = 3600;
    // 5 hours that began 30 min (fast) or 4 h (slow) ago.
    const crew = (fiveHour: number, began: number, weekUsed = 50, weekResetIn = 6 * 86_400) => account("crew", { usedPercent: fiveHour,
      primaryResetAt: now + 5 * hour - began, secondaryUsedPercent: weekUsed, secondaryResetAt: now + weekResetIn });
    const lab = (fiveHour: number, began: number) => account("lab", { usedPercent: fiveHour, primaryResetAt: now + 5 * hour - began, secondaryUsedPercent: 40, secondaryResetAt: now + 5 * 86_400 });
    // No reset for hours and the pool spends fast: crew, the last with room, keeps 20% for the operator; lab, past its floor, waits.
    expect(fill([crew(80, 0.5 * hour), lab(99, 0.5 * hour)], "NORMAL")).toMatchObject({ account: null, reserved: true });
    // Its own reset soon: crew's 5 hours come back in 24 min and its 20 points carry the pool (42 an hour) until then, so it spends them.
    expect(fill([crew(80, 4.6 * hour), lab(99, 4 * hour)], "NORMAL").account?.accountId).toBe("crew");
    // Another account resets soon: lab's 5 hours come back in 15 min, before crew's 20 points run out (61 an hour), so they are spent.
    expect(fill([crew(80, 2 * hour), lab(99, 4.75 * hour)], "NORMAL").account?.accountId).toBe("crew");
    // The weekly cap the same way: 96% of crew's week waits while its reset is days off and the pool spends fast; 3 h from it, it is spent.
    const ops = account("ops", { usedPercent: 10, primaryResetAt: now + 4 * hour, secondaryUsedPercent: 90, secondaryResetAt: now + 1.5 * 86_400 });
    expect(fill([crew(10, 4 * hour, 96, 6 * 86_400), ops]).account?.accountId).toBe("ops");
    expect(fill([crew(10, 4 * hour, 96, 3 * hour), ops]).account?.accountId).toBe("crew");
  });

  // Goal d844e0cc (stable's five Claude Max on 5/11, week used/passed: crew 81/51, dev 100/91, lab 100/92, ntheo 18/4, ops 100/56).
  it("serves an account ahead of its weekly pace last, only when no other has room, and one under its pace first", () => {
    const today = (ntheoFiveHour: number | null) => [max("crew", 20, 81, 0.49), max("dev", null, 100, 0.09), max("lab", null, 100, 0.08),
      max("ntheo", ntheoFiveHour, 18, 0.96), max("ops", null, 100, 0.44)];
    // crew +30 and ops +44 are ahead; dev +9, lab +8 and ntheo +14 on pace.
    expect(today(10).map((state) => paceRank(state, now))).toEqual([3, 2, 2, 2, 3]);
    // ntheo serves though crew resets days earlier (fill first alone took crew), with or without the operator's reserve.
    for (const reserve of [null, "NORMAL", "PRIORITY"] as const) expect(fill(today(10), reserve).account?.accountId).toBe("ntheo");
    expect(pick(today(10), { weeklyPace: true })).toBe("ntheo");
    // ntheo past its 5-hour switch point or out of its 5 hours: crew serves; nothing is refused for its pace.
    expect(fill(today(95)).account?.accountId).toBe("crew");
    expect(fill(today(100), "NORMAL")).toMatchObject({ account: { accountId: "crew" }, errorMessage: null });
    // Under pace (-19) serves before an on-pace account (-1) that resets earlier.
    expect(fill([max("soon", 10, 70, 2 / 7), max("under", 10, 10, 5 / 7)]).account?.accountId).toBe("under");
  });

  it("lets a conversation follow its account only while that account's window counts", () => {
    expect(fillFirstWindowStarted(max("lab", 40, 40, 0.5), now)).toBe(true);
    expect(fillFirstWindowStarted(max("lab", null, 40, 0.5), now)).toBe(false);
    expect(fillFirstWindowStarted(account("lab", { usedPercent: 80, primaryResetAt: now - 1 }), now)).toBe(false);
  });
});

// Plan clipboard:DotwYXVD2N3n (goal d844e0cc): no account at 100% before its weekly reset; background work holds at today's allowance.
describe("pace cap (Space fork)", () => {
  const day = 86_400;
  // 3.5 days to the reset: day 4 of the last 4 began 12 hours ago at 60% used, so today's allowance is (100 - 60) / 4 = 10%.
  const paced = (id: string, used: number, resetIn = 3.5 * day) => {
    const dayStartAt = now + resetIn - Math.ceil(resetIn / day) * day;
    return account(id, { usedPercent: 10, secondaryUsedPercent: used, secondaryResetAt: now + resetIn, weekDayStart: { at: dayStartAt * 1000, usedPercent: 60 } });
  };

  it("skips an account over today's allowance and holds background work with PACE_CAP when every one is over", () => {
    expect(pick([paced("over", 71), paced("open", 65)], { paceCap: true, fillFirst: { reserve: null } })).toBe("open");
    const held = selectAccount([paced("ops", 71), paced("crew", 75)], { now, paceCap: true, accountNames: { ops: "ops", crew: "crew" } });
    expect(held).toMatchObject({ account: null, errorCode: PACE_CAP, resetsAt: now + day / 2 });
    expect(held.errorMessage).toContain("ops 11%/10%, crew 15%/10%");
    // A spent week (100%) is the usage limit's: alone it is no pace hold, beside held accounts it never serves background work.
    expect(selectAccount([paced("spent", 100)], { now, paceCap: true }).errorCode).not.toBe(PACE_CAP);
    expect(selectAccount([paced("spent", 100), paced("ops", 71)], { now, paceCap: true })).toMatchObject({ account: null, errorCode: PACE_CAP });
  });

  it("never holds Nous's runs or a pane on an open operator request while every account is held; any other background work still gets PACE_CAP", () => {
    // Operator 6/11 (nous_msg:a0d02e19, and the 31/10 rule: his requests never wait): Nous turns, helpers and operator-request panes run on.
    let clock = 1_000;
    const priority = createPriorityPanes({ now: () => clock, ttlMs: 60_000 });
    priority.set(["pane:emma0001"]);
    const held = () => [paced("ops", 71), paced("crew", 75)];
    for (const project of ["nous", "nous-helper", NOUS_OPERATOR_PROJECT, "pane:emma0001"]) {
      expect(selectAccount(held(), { now, paceCap: paceCapApplies(project, priority) }).account, project).not.toBeNull();
    }
    for (const project of [null, "pane:finn0001", "claude-code", "agent-chat"]) {
      const result = selectAccount(held(), { now, paceCap: paceCapApplies(project, priority) });
      expect(result, String(project)).toMatchObject({ account: null, errorCode: PACE_CAP });
      expect(result.errorMessage).toMatch(/background work resumes at \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
    }
    // A list the Space API stops sending lapses: the pane is background work again.
    clock += 60_001;
    expect(paceCapApplies("pane:emma0001", priority)).toBe(true);
  });

  it("opens the pace cap for a Level 1 priority: named panes, or all background work, until the emergency ends or is turned off", () => {
    // Operator 6/11 11:31 BKK (nous_msg:1d470cc93b194f03ae7f7706): finding a server, finding more free tokens.
    let clock = 1_000;
    const priority = createPriorityPanes({ now: () => clock, ttlMs: 300_000 });
    const held = () => [paced("ops", 71), paced("crew", 75)];
    const passes = (project: string | null) => selectAccount(held(), { now, paceCap: paceCapApplies(project, priority) }).account !== null;
    // Panes: the named pane runs, the others and untagged work stay held.
    priority.set([], { all: false, paneIds: ["pane:dino0001"], until: clock + 60_000 });
    expect([passes("pane:dino0001"), passes("pane:andy0001"), passes(null)]).toEqual([true, false, false]);
    expect(priority.emergency()).toEqual({ all: false, paneIds: ["pane:dino0001"], until: clock + 60_000 });
    // All: every background request runs, untagged included.
    priority.set([], { all: true, paneIds: [], until: clock + 60_000 });
    expect([passes("pane:andy0001"), passes(null), passes("claude-code")]).toEqual([true, true, true]);
    // It ends by itself at its own time.
    clock += 60_001;
    expect([passes("pane:andy0001"), passes(null)]).toEqual([false, false]);
    expect(priority.emergency()).toBeNull();
    // Off: the next send carries no emergency, and the panes of open operator requests stay exempt.
    priority.set(["pane:emma0001"], { all: true, paneIds: [], until: clock + 3_600_000 });
    expect(passes("pane:andy0001")).toBe(true);
    priority.set(["pane:emma0001"], null);
    expect([passes("pane:andy0001"), passes("pane:emma0001")]).toEqual([false, true]);
    // An API that stops sending lets the whole list lapse, an emergency included.
    priority.set([], { all: true, paneIds: [], until: clock + 3_600_000 });
    clock += 300_001;
    expect(passes("pane:andy0001")).toBe(false);
  });

  it("never holds the operator's turns", () => {
    expect(pick([paced("ops", 71), paced("crew", 75)])).toBeDefined();
  });

  it("never holds an account in its last 24 hours before its reset", () => {
    expect(pick([paced("last", 95, day / 2)], { paceCap: true })).toBe("last");
  });

  // Plan clipboard:DotwYXVD2N3n, 6/11 19:00 BKK: ntheo 92% of its week 5.6 days before its reset (used 37% today on an allowance of 7.5%),
  // dev 37% and lab 39% a week from theirs, under today's allowance; every one ahead of its pace, so fill first chose ntheo, the earliest reset.
  const weekOf = (id: string, used: number, resetIn: number, dayStartUsed: number) => account(id, { usedPercent: 10, secondaryUsedPercent: used,
    secondaryResetAt: now + resetIn, weekDayStart: { at: (now + resetIn - Math.ceil(resetIn / day) * day) * 1000, usedPercent: dayStartUsed } });
  const sixthOfNovember = () => [weekOf("ntheo", 92, 5.58 * day, 55), weekOf("dev", 37, 6.46 * day, 30), weekOf("lab", 39, 6.38 * day, 30)];
  const claude = { weeklyPace: true, weekRunway: true } as const;

  it("reads a week short when it would not last to its reset, never in its last 24 hours", () => {
    const [ntheo, dev] = sixthOfNovember();
    expect([weekShort(ntheo!, now), weekShort(dev!, now)]).toEqual([true, false]);
    expect(weekShort(weekOf("x", 95, 2 * day, 95), now)).toBe(true);
    expect(weekShort(weekOf("x", 99, day / 2, 99), now)).toBe(false);
    expect(weekShort(account("unknown"), now)).toBe(false);
  });

  it("sets an account short of its week aside while another has room: background, emergency-lifted and operator work alike", () => {
    expect(pick(sixthOfNovember(), { weeklyPace: true, fillFirst: { reserve: null } })).toBe("ntheo");
    for (const paceCap of [true, false] as const) {
      for (const reserve of ["NORMAL", "PRIORITY", null] as const) {
        expect(pick(sixthOfNovember(), { ...claude, paceCap, fillFirst: { reserve } }), `${paceCap} ${reserve}`).not.toBe("ntheo");
      }
      expect(pick(sixthOfNovember(), { ...claude, paceCap }), `${paceCap} weekly pace`).not.toBe("ntheo");
    }
    // Under today's allowance, ntheo is still set aside; it serves the work the others refuse.
    const fresh = () => [weekOf("ntheo", 92, 5.58 * day, 92), weekOf("lab", 39, 6.38 * day, 30)];
    expect(pick(fresh(), { ...claude, fillFirst: { reserve: "PRIORITY" } })).toBe("lab");
    const [ntheo, lab] = fresh();
    expect(pick([ntheo!, { ...lab!, status: "RATE_LIMITED", resetAt: now + 3_600 }], { ...claude, paceCap: true, fillFirst: { reserve: "PRIORITY" } })).toBe("ntheo");
  });

  it("holds nothing Nous's pace cap emergency covers, a short account included; only a spent week stops (operator 7/11 19:24 BKK)", () => {
    let clock = 1_000;
    const priority = createPriorityPanes({ now: () => clock, ttlMs: 300_000 });
    priority.set(["pane:emma0001"], { all: true, paneIds: [], until: clock + 60_000 });
    expect([paceCapApplies("pane:andy0001", priority), paceCapApplies(null, priority), paceCapApplies("pane:emma0001", priority),
      paceCapApplies("nous", priority), paceCapApplies(NOUS_OPERATOR_PROJECT, priority)]).toEqual([false, false, false, false, false]);
    // dev and lab used today's share too: background work without the emergency is held, with it they serve.
    const allCapped = () => [weekOf("ntheo", 92, 5.58 * day, 55), weekOf("dev", 37, 6.46 * day, 20), weekOf("lab", 39, 6.38 * day, 20)];
    expect(selectAccount(allCapped(), { now, ...claude, paceCap: true, fillFirst: { reserve: "NORMAL" } }).errorCode).toBe(PACE_CAP);
    expect(pick(allCapped(), { ...claude, paceCap: false, fillFirst: { reserve: "NORMAL" } })).toMatch(/^(dev|lab)$/);
    // dev and lab at their 5-hour limit: the emergency's work runs on ntheo (short), at 96% of its week too; spent (100%) it is the usage limit's.
    const limited = () => allCapped().map((state) => state.accountId === "ntheo" ? state : { ...state, status: "RATE_LIMITED" as const, resetAt: now + (state.accountId === "dev" ? 7_200 : 3_600) });
    const ntheoAt = (used: number) => limited().map((state) => state.accountId === "ntheo" ? { ...state, secondaryUsedPercent: used } : state);
    expect(pick(limited(), { ...claude, paceCap: false, fillFirst: { reserve: "NORMAL" } })).toBe("ntheo");
    expect(pick(ntheoAt(96), { ...claude, paceCap: false })).toBe("ntheo");
    expect(selectAccount(ntheoAt(100), { now, ...claude, paceCap: false }).errorCode).not.toBe(PACE_CAP);
    expect(selectAccount(limited(), { now, ...claude, paceCap: true, fillFirst: { reserve: "NORMAL" } }).errorCode).toBe(PACE_CAP);
    clock += 60_001;
    expect(paceCapApplies("pane:andy0001", priority)).toBe(true);
  });

  it("still spends an account's last 24 hours when every account is short of its week", () => {
    const low = () => [weekOf("ntheo", 92, 5.58 * day, 55), weekOf("ops", 96, 3 * day, 80), weekOf("last", 90, day / 2, 85)];
    for (const paceCap of [true, false] as const) expect(pick(low(), { ...claude, paceCap, fillFirst: { reserve: "NORMAL" } }), String(paceCap)).toBe("last");
    // Every one short and none in its last day: the pace cap still holds background work; the operator's turns and the emergency's run.
    const short = () => low().slice(0, 2);
    expect(selectAccount(short(), { now, ...claude, paceCap: true, fillFirst: { reserve: "NORMAL" } }).errorCode).toBe(PACE_CAP);
    expect(pick(short(), { ...claude, paceCap: false })).toBeDefined();
    expect(pick(short(), { ...claude, fillFirst: { reserve: "PRIORITY" } })).toBeDefined();
  });

  it("reads each account's used % at the start of its pace day once a day, again after a failed read", async () => {
    const reads: string[] = [];
    let fail = true;
    const starts = createPaceDayStarts({ weekUsedAt: async (id, at) => {
      reads.push(`${id} ${at}`);
      if (fail) { fail = false; throw new Error("database away"); }
      return id === "a" ? 60 : null;
    } });
    const ms = now * 1000;
    const week = (id: string, used: number) => ({ id, secondaryWindow: { usedPercent: used, resetAt: new Date(ms + 3.5 * day * 1000).toISOString(), windowMinutes: 10_080 } }) as GatewayAccount;
    expect((await starts([week("a", 70)], ms)).size).toBe(0);
    expect(Object.fromEntries(await starts([week("a", 70), week("b", 30)], ms))).toEqual({ a: { at: ms - day * 500, usedPercent: 60 }, b: { at: ms - day * 500, usedPercent: 30 } });
    await starts([week("a", 75), week("b", 35)], ms + 3_600_000);
    expect(reads).toEqual([`a ${new Date(ms - day * 500).toISOString()}`, `a ${new Date(ms - day * 500).toISOString()}`, `b ${new Date(ms - day * 500).toISOString()}`]);
  });
});
