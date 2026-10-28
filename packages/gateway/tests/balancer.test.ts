import { describe, expect, it } from "vitest";
import {
  accountStatusForPermanentFailure, burstSameAccountBackoffSeconds, evaluateHealthTier, failoverDecision, handlePermanentFailure,
  handleQuotaExceeded, handleRateLimit, HEALTH_TIER_DRAINING, HEALTH_TIER_HEALTHY, HEALTH_TIER_PROBING, selectAccount, selectPlanTier,
  type AccountState
} from "../src/router/balancer.js";
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
