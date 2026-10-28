import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { backoffSeconds, parseRetryAfter } from "./retry.js";

/**
 * Account selection, ported from codex-lb `app/core/balancer/logic.py` (MIT, Soju06/codex-lb), with the
 * strict plan-priority tiers of the deployed Space fork. All times are Unix seconds.
 */

export type BalancerAccountStatus = "ACTIVE" | "RATE_LIMITED" | "QUOTA_EXCEEDED" | "PAUSED" | "REAUTH_REQUIRED" | "DEACTIVATED";
export type RoutingStrategy =
  | "USAGE_WEIGHTED" | "ROUND_ROBIN" | "CAPACITY_WEIGHTED" | "RELATIVE_AVAILABILITY"
  | "FILL_FIRST" | "SEQUENTIAL_DRAIN" | "RESET_DRAIN" | "SINGLE_ACCOUNT";
export type TrafficClass = "foreground" | "opportunistic";
export type UsageWeightedOrder = "secondary_first" | "primary_first";
export type ResetPreferenceWindow = "primary" | "secondary";
export type RoutingPolicy = "normal" | "burn_first" | "preserve";
export type FailureClass = "rate_limit" | "quota" | "retryable_transient" | "non_retryable";
export type FailoverAction = "failover_next" | "retry_same_account" | "surface";

export interface UpstreamError {
  message?: string;
  resetsAt?: number;
  resetsInSeconds?: number;
}

export interface AccountState {
  accountId: string;
  status: BalancerAccountStatus;
  usedPercent?: number | null;
  resetAt?: number | null;
  primaryResetAt?: number | null;
  primaryWindowMinutes?: number | null;
  blockedAt?: number | null;
  cooldownUntil?: number | null;
  secondaryUsedPercent?: number | null;
  secondaryResetAt?: number | null;
  lastErrorAt?: number | null;
  lastSelectedAt?: number | null;
  errorCount: number;
  deactivationReason?: string | null;
  planType?: string | null;
  capacityCredits?: number | null;
  healthTier: number;
  priorityUsedPercent?: number | null;
  prioritySecondaryUsedPercent?: number | null;
  priorityResetAt?: number | null;
  priorityCapacityCredits?: number | null;
  limitScopedUsage?: boolean;
  accessTokenExpiresAt?: number | null;
  routingPolicy?: RoutingPolicy;
  ignoreStandardQuota?: boolean;
  /** Draw-weight multiplier from the recent upstream error rate; 1 is neutral. */
  selectionWeightMultiplier?: number;
}

export interface SelectionResult {
  account: AccountState | null;
  errorMessage: string | null;
  errorCode?: string | null;
  resetsAt?: number | null;
}

export interface RoutingCost { total: number; reason?: string | null }
export type RoutingCostsByAccount = Record<string, RoutingCost>;

export const permanentFailureCodes: Record<string, string> = {
  refresh_token_expired: "Refresh token expired - re-login required",
  refresh_token_reused: "Refresh token was reused - re-login required",
  refresh_token_invalidated: "Refresh token was revoked - re-login required",
  invalid_grant: "Refresh token grant invalid - re-login required",
  token_invalidated: "Authentication token invalidated - re-login required",
  token_expired: "Authentication token expired - re-login required",
  app_session_terminated: "ChatGPT session ended - re-login required",
  account_session_expired: "ChatGPT session ended - re-login required",
  account_auth_invalidated: "Authentication failed after token refresh - re-login required",
  invalid_refresh_token: "Refresh token invalid - re-login required",
  account_deactivated: "Account has been deactivated",
  account_suspended: "Account has been suspended",
  account_deleted: "Account has been deleted"
};

const reauthRequiredFailureCodes = new Set([
  "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "invalid_grant", "token_invalidated",
  "token_expired", "app_session_terminated", "account_session_expired", "account_auth_invalidated", "invalid_refresh_token"
]);

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
const RATE_LIMIT_RESET_MAX_HORIZON_SECONDS = 366 * SECONDS_PER_DAY;
const RATE_LIMIT_RESET_ROUNDING_TOLERANCE_SECONDS = 1;
const UNKNOWN_RESET_BUCKET_DAYS = 10_000;
const UNKNOWN_RESET_FALLBACK_SECONDS = 7 * SECONDS_PER_DAY;
const RELATIVE_AVAILABILITY_MIN_DIVISOR_SECONDS = 5 * 60;
const RELATIVE_AVAILABILITY_MIN_WEIGHT_FRACTION = 0.1;
export const DEFAULT_RELATIVE_AVAILABILITY_POWER = 2;
export const DEFAULT_RELATIVE_AVAILABILITY_TOP_K = 5;
const UNKNOWN_PLAN_FALLBACK = "free";
const capacityPlanAliases: Record<string, string> = {
  education: "edu", k12: "edu", guest: "free", go: "free", free_workspace: "free", quorum: "free", unknown: "free", max: "max5x"
};

// Claude plans (max5x, max20x) live in their own pool, so only their ratio to Claude Pro (taken as "pro") matters.
export const PLAN_CAPACITY_CREDITS_PRIMARY: Record<string, number> = {
  free: 0, plus: 225, business: 225, team: 225, edu: 225, pro: 1500, prolite: 1125, enterprise: 1500, max5x: 7500, max20x: 30000
};
export const PLAN_CAPACITY_CREDITS_SECONDARY: Record<string, number> = {
  free: 1134, plus: 7560, business: 7560, team: 7560, edu: 7560, pro: 50400, prolite: 37800, enterprise: 50400, max5x: 252000, max20x: 1008000
};

export const HEALTH_TIER_HEALTHY = 0;
export const HEALTH_TIER_DRAINING = 1;
export const HEALTH_TIER_PROBING = 2;
const DRAIN_PRIMARY_THRESHOLD_PCT = 85;
const DRAIN_SECONDARY_THRESHOLD_PCT = 90;
const DRAIN_ERROR_WINDOW_SECONDS = 60;
const DRAIN_ERROR_COUNT_THRESHOLD = 2;
const ERROR_BACKOFF_THRESHOLD = 3;
const PROBE_QUIET_SECONDS = 60;
const PROBE_SUCCESS_STREAK_REQUIRED = 3;
const PRESERVE_MIN_WEEKLY_FLOOR_PCT = 5;
const PRESERVE_MIN_SHORT_WINDOW_FLOOR_PCT = 10;
const NORMAL_LAST_ACCOUNT_EMERGENCY_FLOOR_PCT = 5;
const RECENT_FOREGROUND_ACTIVITY_SECONDS = 30 * 60;
export const USAGE_LIMIT_REACHED = "usage_limit_reached";

type SortKey = (number | string)[];

function compareKeys(left: SortKey, right: SortKey): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

function minBy<T>(items: readonly T[], key: (item: T) => SortKey): T {
  let best: T = items[0] as T;
  let bestKey = key(best);
  for (const item of items.slice(1)) {
    const itemKey = key(item);
    if (compareKeys(itemKey, bestKey) < 0) { best = item; bestKey = itemKey; }
  }
  return best;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableTieBreaker(accountId: string): string { return sha256(accountId); }
function decorrelatedTieBreaker(accountId: string, salt: string): string { return sha256(`${salt}\u0000${accountId}`); }

let configuredReplicaSalt: string | null = null;
let processReplicaSalt: string | null = null;

/** Sets the process-wide salt that decorrelates round-robin ties between replicas. */
export function configureReplicaSalt(salt: string | null): void {
  const normalized = salt?.trim() ?? "";
  configuredReplicaSalt = normalized || null;
}

function effectiveReplicaSalt(explicit: string | null | undefined): string {
  if (explicit?.trim()) return explicit.trim();
  if (configuredReplicaSalt) return configuredReplicaSalt;
  processReplicaSalt ??= hostname().trim() || "space-gateway";
  return processReplicaSalt;
}

function routingPolicy(state: AccountState): RoutingPolicy {
  return state.routingPolicy === "burn_first" || state.routingPolicy === "preserve" ? state.routingPolicy : "normal";
}

function usedPct(state: AccountState, secondary: boolean): number | null {
  if (secondary) return state.secondaryUsedPercent ?? state.usedPercent ?? null;
  return state.usedPercent ?? null;
}

function remainingPct(state: AccountState, secondary: boolean): number | null {
  const used = usedPct(state, secondary);
  return used === null ? null : Math.max(0, 100 - Math.min(100, used));
}

function secondsUntil(resetAt: number | null | undefined, current: number): number | null {
  return resetAt === null || resetAt === undefined ? null : Math.max(0, resetAt - current);
}

function recentForegroundActivity(state: AccountState, current: number): boolean {
  return state.lastSelectedAt !== null && state.lastSelectedAt !== undefined && current - state.lastSelectedAt <= RECENT_FOREGROUND_ACTIVITY_SECONDS;
}

function weeklyPaceFloorPct(state: AccountState, current: number): number {
  const remainingSeconds = secondsUntil(state.secondaryResetAt, current);
  const used = usedPct(state, true);
  if (remainingSeconds === null || used === null) return 100;
  const elapsed = Math.max(0, SECONDS_PER_WEEK - remainingSeconds);
  const expectedUsed = Math.min(100, (elapsed / SECONDS_PER_WEEK) * 100);
  const behindPace = used + 5 < expectedUsed;
  let floor: number;
  if (remainingSeconds <= 6 * SECONDS_PER_HOUR && behindPace) floor = 0;
  else if (remainingSeconds <= SECONDS_PER_DAY && behindPace) floor = 2;
  else if (behindPace) floor = 5;
  else floor = 15;
  if (recentForegroundActivity(state, current)) floor = Math.max(floor, 25);
  return Math.max(PRESERVE_MIN_WEEKLY_FLOOR_PCT, floor);
}

function shortWindowFloorPct(state: AccountState, current: number, preserveCount: number): number {
  const remainingSeconds = secondsUntil(state.resetAt, current);
  let floor = PRESERVE_MIN_SHORT_WINDOW_FLOOR_PCT;
  if (remainingSeconds === null) return 100;
  if (remainingSeconds > SECONDS_PER_HOUR) floor = Math.max(floor, 20);
  if (recentForegroundActivity(state, current)) floor = Math.max(floor, 30);
  if (preserveCount <= 1) floor = Math.max(floor, 25);
  return floor;
}

function preserveAllowsOpportunisticBurn(state: AccountState, current: number, preserveCount: number): boolean {
  if (remainingPct(state, true) === null || remainingPct(state, false) === null) return false;
  if (state.secondaryResetAt === null || state.secondaryResetAt === undefined || state.resetAt === null || state.resetAt === undefined) return false;
  return (remainingPct(state, true) ?? 0) > weeklyPaceFloorPct(state, current)
    && (remainingPct(state, false) ?? 0) > shortWindowFloorPct(state, current, preserveCount);
}

function hasOtherUsableForegroundCapacity(candidate: AccountState, available: AccountState[], current: number): boolean {
  const preserveCount = available.filter((state) => routingPolicy(state) === "preserve").length;
  for (const other of available) {
    if (other.accountId === candidate.accountId) continue;
    if (other.status !== "ACTIVE" && other.status !== "REAUTH_REQUIRED") continue;
    if (routingPolicy(other) === "preserve") {
      if (preserveAllowsOpportunisticBurn(other, current, preserveCount)) return true;
      continue;
    }
    return true;
  }
  return false;
}

function aboveEmergencyFloor(state: AccountState): boolean {
  const primary = remainingPct(state, false);
  const secondary = remainingPct(state, true);
  if (primary === null || secondary === null) return false;
  return primary > NORMAL_LAST_ACCOUNT_EMERGENCY_FLOOR_PCT && secondary > NORMAL_LAST_ACCOUNT_EMERGENCY_FLOOR_PCT;
}

function filterOpportunisticCandidates(available: AccountState[], current: number): { pool: AccountState[]; reason: string | null } {
  const burnFirst: AccountState[] = [];
  const normal: AccountState[] = [];
  const preserve: AccountState[] = [];
  const preserveCount = available.filter((state) => routingPolicy(state) === "preserve").length;
  for (const state of available) {
    const policy = routingPolicy(state);
    if (policy === "burn_first") {
      if (hasOtherUsableForegroundCapacity(state, available, current) || aboveEmergencyFloor(state)) burnFirst.push(state);
    } else if (policy === "preserve") {
      if (preserveAllowsOpportunisticBurn(state, current, preserveCount)) preserve.push(state);
    } else if (hasOtherUsableForegroundCapacity(state, available, current) || aboveEmergencyFloor(state)) {
      normal.push(state);
    }
  }
  if (burnFirst.length || normal.length || preserve.length) return { pool: [...burnFirst, ...normal, ...preserve], reason: null };
  if (available.some((state) => routingPolicy(state) === "preserve")) {
    return { pool: [], reason: "preserve floor or stale usage data blocks opportunistic burn" };
  }
  return { pool: [], reason: "no expendable account has emergency foreground reserve" };
}

function resetPreferenceBucket(state: AccountState, current: number, window: ResetPreferenceWindow): number {
  let resetAt: number | null | undefined;
  if (window === "primary") {
    resetAt = state.primaryResetAt ?? state.priorityResetAt ?? state.secondaryResetAt;
  } else {
    resetAt = state.priorityResetAt ?? state.secondaryResetAt ?? state.primaryResetAt;
  }
  if (resetAt === null || resetAt === undefined) return UNKNOWN_RESET_BUCKET_DAYS * SECONDS_PER_DAY;
  const remaining = Math.max(0, Math.trunc(resetAt - current));
  return window === "secondary" ? Math.floor(remaining / SECONDS_PER_DAY) : remaining;
}

function preferEarlierResetCandidates(available: AccountState[], current: number, window: ResetPreferenceWindow): AccountState[] {
  const earliest = Math.min(...available.map((state) => resetPreferenceBucket(state, current, window)));
  return available.filter((state) => resetPreferenceBucket(state, current, window) === earliest);
}

export function fallbackSecondaryCapacityCredits(planType: string | null | undefined): number {
  const normalized = (planType ?? "").trim().toLowerCase();
  const resolved = capacityPlanAliases[normalized] ?? (normalized || UNKNOWN_PLAN_FALLBACK);
  return PLAN_CAPACITY_CREDITS_SECONDARY[resolved] ?? PLAN_CAPACITY_CREDITS_SECONDARY[UNKNOWN_PLAN_FALLBACK]!;
}

function knownExpiredReauth(state: AccountState, current: number): boolean {
  return state.status === "REAUTH_REQUIRED" && state.accessTokenExpiresAt !== null && state.accessTokenExpiresAt !== undefined
    && state.accessTokenExpiresAt <= current;
}

function priorityPrimaryUsed(state: AccountState): number {
  return state.priorityUsedPercent ?? state.usedPercent ?? 0;
}

function prioritySecondaryUsed(state: AccountState, primaryUsed?: number): number {
  const primary = primaryUsed ?? priorityPrimaryUsed(state);
  if (state.limitScopedUsage && (state.prioritySecondaryUsedPercent === null || state.prioritySecondaryUsedPercent === undefined)) return primary;
  return state.prioritySecondaryUsedPercent ?? state.secondaryUsedPercent ?? primary;
}

function usageSortKey(state: AccountState): SortKey {
  const primary = priorityPrimaryUsed(state);
  return [prioritySecondaryUsed(state, primary), primary, state.lastSelectedAt ?? 0, state.accountId];
}

function primaryUsageSortKey(state: AccountState): SortKey {
  const primary = priorityPrimaryUsed(state);
  return [primary, prioritySecondaryUsed(state, primary), state.lastSelectedAt ?? 0, state.accountId];
}

function plannerCost(state: AccountState, costs: RoutingCostsByAccount | null | undefined): number {
  return costs?.[state.accountId]?.total ?? 0;
}

function lowestPlannerCostCandidates(available: AccountState[], costs: RoutingCostsByAccount | null | undefined): AccountState[] {
  if (!costs || Object.keys(costs).length === 0) return available;
  const lowest = Math.min(...available.map((state) => plannerCost(state, costs)));
  return available.filter((state) => plannerCost(state, costs) === lowest);
}

function remainingSecondaryCredits(state: AccountState): number {
  let capacity = state.priorityCapacityCredits ?? state.capacityCredits ?? null;
  if (capacity === null) capacity = fallbackSecondaryCapacityCredits(state.planType);
  else if (capacity <= 0) return 0;
  const used = prioritySecondaryUsed(state, priorityPrimaryUsed(state));
  return Math.max(0, capacity * (1 - Math.min(used, 100) / 100));
}

function selectionWeightMultiplier(state: AccountState): number {
  const multiplier = state.selectionWeightMultiplier ?? 1;
  if (Number.isNaN(multiplier) || multiplier < 0) return 1;
  return Math.min(multiplier, 1);
}

function weightedChoice<T>(items: T[], weights: number[], random: () => number): T {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let threshold = random() * total;
  for (let index = 0; index < items.length; index += 1) {
    threshold -= weights[index]!;
    if (threshold < 0) return items[index]!;
  }
  return items[items.length - 1]!;
}

function seededAccount(pool: AccountState[], seed: string): AccountState {
  return minBy(pool, (state) => [decorrelatedTieBreaker(state.accountId, seed)]);
}

function seededLeastUsed(available: AccountState[], seed: string): AccountState {
  const keyOf = (state: AccountState) => usageSortKey(state).slice(0, 2);
  const least = keyOf(minBy(available, keyOf));
  return seededAccount(available.filter((state) => compareKeys(keyOf(state), least) === 0), seed);
}

function selectCapacityWeighted(available: AccountState[], random: () => number, seed: string | null): AccountState {
  const weights = available.map((state) => remainingSecondaryCredits(state) * selectionWeightMultiplier(state));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return seed !== null ? seededLeastUsed(available, seed) : minBy(available, usageSortKey);
  if (seed !== null) return seededAccount(available.filter((_, index) => weights[index]! > 0), seed);
  return weightedChoice(available, weights, random);
}

function relativeAvailabilityRawScore(state: AccountState, current: number): number {
  const remainingCredits = remainingSecondaryCredits(state);
  if (remainingCredits <= 0) return 0;
  const resetAt = state.priorityResetAt ?? state.secondaryResetAt;
  const remainingSeconds = resetAt === null || resetAt === undefined ? UNKNOWN_RESET_FALLBACK_SECONDS : Math.max(0, resetAt - current);
  return remainingCredits / Math.max(remainingSeconds, RELATIVE_AVAILABILITY_MIN_DIVISOR_SECONDS);
}

function selectRelativeAvailability(available: AccountState[], options: {
  current: number; power: number; topK: number; deterministicProbe: boolean; seed: string | null; random: () => number;
}): AccountState {
  const raw = available.map((state) => ({ state, score: relativeAvailabilityRawScore(state, options.current) }));
  const best = Math.max(0, ...raw.map((item) => item.score));
  const fallback = () => (options.seed !== null ? seededLeastUsed(available, options.seed) : minBy(available, usageSortKey));
  if (best <= 0) return fallback();
  const power = options.power > 0 ? options.power : DEFAULT_RELATIVE_AVAILABILITY_POWER;
  let weighted = raw
    .map((item) => ({ ...item, weight: (item.score / best) ** power }))
    .filter((item) => item.weight >= RELATIVE_AVAILABILITY_MIN_WEIGHT_FRACTION);
  if (weighted.length === 0) return fallback();
  if (options.seed !== null) {
    const seed = options.seed;
    weighted = [...weighted].sort((a, b) => compareKeys([decorrelatedTieBreaker(a.state.accountId, seed)], [decorrelatedTieBreaker(b.state.accountId, seed)]));
  } else {
    weighted = [...weighted].sort((a, b) => compareKeys([-a.weight, -a.score, ...usageSortKey(a.state)], [-b.weight, -b.score, ...usageSortKey(b.state)]));
    weighted = weighted.slice(0, Math.max(1, options.topK));
  }
  if (options.deterministicProbe) return weighted[0]!.state;
  const weights = weighted.map((item) => item.weight * selectionWeightMultiplier(item.state));
  if (weights.reduce((sum, weight) => sum + weight, 0) <= 0) return fallback();
  if (options.seed !== null) return seededAccount(weighted.filter((_, index) => weights[index]! > 0).map((item) => item.state), options.seed);
  return weightedChoice(weighted.map((item) => item.state), weights, options.random);
}

function configuredCapacityCredits(state: AccountState): number {
  return state.capacityCredits !== null && state.capacityCredits !== undefined && state.capacityCredits > 0
    ? state.capacityCredits
    : fallbackSecondaryCapacityCredits(state.planType);
}

function weeklyResetTimestamp(state: AccountState, current: number): number {
  if (state.secondaryResetAt !== null && state.secondaryResetAt !== undefined && state.secondaryResetAt > current) return state.secondaryResetAt;
  if (state.resetAt !== null && state.resetAt !== undefined && state.resetAt > current) return state.resetAt;
  return Number.POSITIVE_INFINITY;
}

function resetDrainSortKey(state: AccountState, current: number): SortKey {
  const primaryRemaining = 100 - (state.usedPercent ?? 0);
  const secondaryRemaining = 100 - (state.secondaryUsedPercent ?? state.usedPercent ?? 0);
  const resetAt = weeklyResetTimestamp(state, current);
  const bucket = resetAt === Number.POSITIVE_INFINITY ? UNKNOWN_RESET_BUCKET_DAYS : Math.max(0, Math.floor((resetAt - current) / SECONDS_PER_DAY));
  return [bucket, -Math.max(0, primaryRemaining), -Math.max(0, secondaryRemaining), resetAt, stableTieBreaker(state.accountId), state.accountId];
}

function oldestDueProbingAccount(probing: AccountState[], current: number): AccountState | null {
  const due = probing.filter((state) => state.lastSelectedAt === null || state.lastSelectedAt === undefined || current - state.lastSelectedAt >= PROBE_QUIET_SECONDS);
  if (due.length === 0) return null;
  return minBy(due, (state) => [state.lastSelectedAt ?? Number.NEGATIVE_INFINITY, state.accountId]);
}

/** 7-day used % minus the share of the week passed, in points; 0 (on pace) when unknown or the week has reset. */
export function weeklyPacePoints(state: AccountState, current: number): number {
  const used = state.secondaryUsedPercent;
  const reset = state.secondaryResetAt;
  if (used === null || used === undefined || !reset || reset <= current) return 0;
  return used - 100 * (1 - Math.min(7 * SECONDS_PER_DAY, reset - current) / (7 * SECONDS_PER_DAY));
}

/** Normalizes plan names for plan-priority tiers ("Pro Lite" -> "prolite"). */
export function normalizePlanPriorityType(value: string | null | undefined): string {
  const cleaned = (value ?? "").trim().toLowerCase();
  if (!cleaned) return "unknown";
  if (cleaned.replace(/[-_ ]/g, "") === "prolite") return "prolite";
  return cleaned;
}

/** The first configured plan tier that still has an eligible account; unranked plans come last. */
export function selectPlanTier(available: AccountState[], planPriority: readonly string[]): AccountState[] {
  const priority = [...new Set(planPriority.map(normalizePlanPriorityType))];
  if (priority.length === 0) return available;
  for (const plan of priority) {
    const tier = available.filter((state) => normalizePlanPriorityType(state.planType) === plan);
    if (tier.length > 0) return tier;
  }
  const ranked = new Set(priority);
  const fallback = available.filter((state) => !ranked.has(normalizePlanPriorityType(state.planType)));
  return fallback.length > 0 ? fallback : available;
}

function formatRetryHint(waitSeconds: number): string {
  const capped = Math.min(Math.max(0, waitSeconds), 300);
  return `Rate limit exceeded. Try again in ${Math.round(capped)}s`;
}

/** Describes pool-wide exhaustion when every eligible account has a window proven at 100%. */
export function poolUsageExhaustion(states: Iterable<AccountState>, options: {
  current: number; ignoreStandardQuota?: boolean; ignoreStandardQuotaAccountIds?: Iterable<string> | null;
}): SelectionResult | null {
  if (options.ignoreStandardQuota) return null;
  const ignored = new Set(options.ignoreStandardQuotaAccountIds ?? []);
  const primaryEvidence = (state: AccountState) => state.priorityUsedPercent ?? state.usedPercent ?? null;
  const secondaryEvidence = (state: AccountState) => {
    if (state.limitScopedUsage && (state.prioritySecondaryUsedPercent === null || state.prioritySecondaryUsedPercent === undefined)) return primaryEvidence(state);
    return state.prioritySecondaryUsedPercent ?? state.secondaryUsedPercent ?? null;
  };
  const exhausted = (state: AccountState) => (state.status === "QUOTA_EXCEEDED" || state.status === "RATE_LIMITED")
    && [primaryEvidence(state), secondaryEvidence(state)].some((value) => value !== null && value >= 100);
  const exhaustedResetAt = (state: AccountState): number | null => {
    if (state.status !== "QUOTA_EXCEEDED" && state.status !== "RATE_LIMITED") return null;
    const candidates: number[] = [];
    const primary = primaryEvidence(state);
    const secondary = secondaryEvidence(state);
    if (primary !== null && primary >= 100 && state.primaryResetAt !== null && state.primaryResetAt !== undefined) candidates.push(state.primaryResetAt);
    if (secondary !== null && secondary >= 100 && state.secondaryResetAt !== null && state.secondaryResetAt !== undefined) candidates.push(state.secondaryResetAt);
    return candidates.length ? Math.max(...candidates) : null;
  };
  const eligible = [...states].filter((state) => !state.ignoreStandardQuota && !ignored.has(state.accountId)
    && state.status !== "PAUSED" && state.status !== "DEACTIVATED");
  if (eligible.length === 0 || eligible.some((state) => !exhausted(state))) return null;
  const resets = eligible.map(exhaustedResetAt).filter((value): value is number => value !== null);
  const resetsAt = resets.length ? Math.trunc(Math.min(...resets)) : null;
  return {
    account: null,
    errorMessage: resetsAt !== null ? formatRetryHint(Math.max(0, resetsAt - options.current)) : "Usage limit reached",
    errorCode: USAGE_LIMIT_REACHED,
    resetsAt
  };
}

export interface SelectAccountOptions {
  now?: number;
  preferEarlierReset?: boolean;
  preferEarlierResetWindow?: ResetPreferenceWindow;
  routingStrategy?: RoutingStrategy;
  /** Strict plan tiers (Space fork): the first tier with an eligible account is drained, least-used 5h first. */
  planPriority?: readonly string[];
  /**
   * Weekly pace first (operator rule 2026-10-27: every account's week used, none run out before its reset): the account
   * furthest under its pace serves new work, accounts ahead of pace last; plan tiers only break ties.
   */
  weeklyPace?: boolean;
  allowBackoffFallback?: boolean;
  deterministicProbe?: boolean;
  recoveryProbeOnly?: boolean;
  relativeAvailabilityPower?: number;
  relativeAvailabilityTopK?: number;
  usageWeightedOrder?: UsageWeightedOrder;
  trafficClass?: TrafficClass;
  ignoreStandardQuota?: boolean;
  bypassQuotaExceededAccountIds?: Iterable<string> | null;
  routingCosts?: RoutingCostsByAccount | null;
  replicaSalt?: string | null;
  selectionSeed?: string | null;
  allowUsageExhaustionError?: boolean;
  usageExhaustionStates?: Iterable<AccountState> | null;
  random?: () => number;
}

/**
 * Filters accounts that cannot serve now (paused, deactivated, limited, cooling down, in error backoff),
 * recovers expired limits, then applies the routing strategy. Mutates states the way codex-lb does
 * (recovered limits and expired cooldowns are cleared on the passed objects).
 */
export function selectAccount(states: Iterable<AccountState>, options: SelectAccountOptions = {}): SelectionResult {
  const current = options.now ?? Date.now() / 1000;
  const random = options.random ?? Math.random;
  const strategy = options.routingStrategy ?? "CAPACITY_WEIGHTED";
  const resetWindow = options.preferEarlierResetWindow ?? "secondary";
  const trafficClass = options.trafficClass ?? "foreground";
  const seed = options.selectionSeed ?? null;
  const costs = options.routingCosts ?? null;
  const allStates = [...states];
  const exhaustionStates = options.usageExhaustionStates ? [...options.usageExhaustionStates] : allStates;
  const bypassIds = options.bypassQuotaExceededAccountIds ? new Set(options.bypassQuotaExceededAccountIds) : null;
  let available: AccountState[] = [];
  const inErrorBackoff: AccountState[] = [];
  const backoffFor = (state: AccountState) => Math.min(300, 30 * 2 ** (state.errorCount - ERROR_BACKOFF_THRESHOLD));

  for (const state of allStates) {
    const bypass = Boolean(options.ignoreStandardQuota || state.ignoreStandardQuota || bypassIds?.has(state.accountId));
    if (state.status === "DEACTIVATED" || state.status === "PAUSED") continue;
    if (knownExpiredReauth(state, current)) continue;
    if (state.status === "RATE_LIMITED") {
      if (state.resetAt && current >= state.resetAt) {
        state.status = "ACTIVE"; state.usedPercent = 0; state.errorCount = 0; state.resetAt = null;
      } else if (!bypass) continue;
    }
    if (state.status === "QUOTA_EXCEEDED") {
      if (state.resetAt && current >= state.resetAt) {
        state.status = "ACTIVE"; state.usedPercent = 0; state.secondaryUsedPercent = 0; state.resetAt = null;
      } else if (!bypass) continue;
    }
    if (state.cooldownUntil && current >= state.cooldownUntil) {
      state.cooldownUntil = null; state.lastErrorAt = null; state.errorCount = 0;
    }
    if (state.cooldownUntil && current < state.cooldownUntil) continue;
    if (state.errorCount >= ERROR_BACKOFF_THRESHOLD) {
      if (state.lastErrorAt && current - state.lastErrorAt < backoffFor(state)) {
        inErrorBackoff.push(state);
        continue;
      }
      // Backoff served in full: re-enter with a clean slate.
      state.errorCount = 0;
      state.lastErrorAt = null;
    }
    available.push(state);
  }

  if (trafficClass === "opportunistic" && available.length > 0) {
    const filtered = filterOpportunisticCandidates(available, current);
    if (filtered.pool.length === 0) return { account: null, errorMessage: `opportunistic burn window closed: ${filtered.reason}` };
    available = filtered.pool;
  }

  if (available.length === 0) {
    const backoffIds = new Set(inErrorBackoff.map((state) => state.accountId));
    const hardBlockedExists = allStates.some((state) => (
      ["PAUSED", "DEACTIVATED", "RATE_LIMITED", "QUOTA_EXCEEDED"].includes(state.status) || knownExpiredReauth(state, current)
    ) && !backoffIds.has(state.accountId));
    if ((options.allowBackoffFallback ?? true) && (inErrorBackoff.length > 1 || (inErrorBackoff.length > 0 && hardBlockedExists))) {
      available.push(minBy(inErrorBackoff, (state) => [(state.lastErrorAt ?? 0) + backoffFor(state)]));
      if (trafficClass === "opportunistic") {
        const filtered = filterOpportunisticCandidates(available, current);
        if (filtered.pool.length === 0) return { account: null, errorMessage: `opportunistic burn window closed: ${filtered.reason}` };
        available = filtered.pool;
      }
    } else {
      if (options.allowUsageExhaustionError ?? true) {
        const exhaustion = poolUsageExhaustion(exhaustionStates, {
          current, ignoreStandardQuota: options.ignoreStandardQuota, ignoreStandardQuotaAccountIds: bypassIds
        });
        if (exhaustion) return exhaustion;
      }
      const expiredReauth = allStates.filter((state) => knownExpiredReauth(state, current));
      const deactivated = allStates.filter((state) => state.status === "DEACTIVATED");
      const paused = allStates.filter((state) => state.status === "PAUSED");
      const rateLimited = allStates.filter((state) => state.status === "RATE_LIMITED");
      const quotaExceeded = allStates.filter((state) => state.status === "QUOTA_EXCEEDED");
      if (rateLimited.length === 0 && quotaExceeded.length === 0) {
        const p = paused.length > 0, r = expiredReauth.length > 0, d = deactivated.length > 0;
        if (p && r && d) return { account: null, errorMessage: "All accounts are paused, deactivated, or require re-authentication" };
        if (p && r) return { account: null, errorMessage: "All accounts are paused or require re-authentication" };
        if (p && d) return { account: null, errorMessage: "All accounts are paused or deactivated" };
        if (r && d) return { account: null, errorMessage: "All accounts are deactivated or require re-authentication" };
        if (p) return { account: null, errorMessage: "All accounts are paused" };
        if (r) return { account: null, errorMessage: "All accounts require re-authentication" };
        if (d) return { account: null, errorMessage: "All accounts are deactivated" };
      }
      if (quotaExceeded.length > 0) {
        const resets = quotaExceeded.map((state) => state.resetAt).filter((value): value is number => Boolean(value));
        if (resets.length > 0) return { account: null, errorMessage: formatRetryHint(Math.max(0, Math.min(...resets) - Math.trunc(current))) };
      }
      const cooldowns = allStates.map((state) => state.cooldownUntil).filter((value): value is number => Boolean(value) && (value as number) > current);
      if (cooldowns.length > 0) return { account: null, errorMessage: formatRetryHint(Math.max(0, Math.min(...cooldowns) - current)) };
      return { account: null, errorMessage: "No available accounts" };
    }
  }

  if (options.planPriority && options.planPriority.length > 0 && !options.weeklyPace) {
    // Strict exhaustion order: inside the first available plan tier, always use the least-used 5h account;
    // weekly usage only breaks ties. Health tiers and weights never move traffic to a busier account here.
    const tier = selectPlanTier(available, options.planPriority);
    const selected = minBy(tier, (state) => {
      const primary = state.usedPercent ?? 0;
      return [primary, state.secondaryUsedPercent ?? primary, state.accountId];
    });
    return { account: selected, errorMessage: null };
  }

  if (strategy === "SINGLE_ACCOUNT") return { account: minBy(available, (state) => [state.accountId]), errorMessage: null };
  if (strategy === "SEQUENTIAL_DRAIN") {
    return { account: minBy(available, (state) => [configuredCapacityCredits(state), stableTieBreaker(state.accountId), state.accountId]), errorMessage: null };
  }
  if (strategy === "RESET_DRAIN") return { account: minBy(available, (state) => resetDrainSortKey(state, current)), errorMessage: null };

  const healthy = available.filter((state) => state.healthTier === HEALTH_TIER_HEALTHY);
  const probing = available.filter((state) => state.healthTier === HEALTH_TIER_PROBING);
  const draining = available.filter((state) => state.healthTier === HEALTH_TIER_DRAINING);
  // A due probe is admitted before routing-policy preferences so recovery is never starved. A seeded
  // caller never carries the probe: rotating a held conversation is exactly what the seed prevents.
  const dueProbe = (healthy.length > 0 || options.recoveryProbeOnly) && seed === null ? oldestDueProbingAccount(probing, current) : null;
  if (options.recoveryProbeOnly && !dueProbe) return { account: null, errorMessage: null };
  const healthPool = dueProbe ? [dueProbe] : healthy.length ? healthy : probing.length ? probing : draining.length ? draining : available;
  const byPolicy = (policy: RoutingPolicy) => healthPool.filter((state) => routingPolicy(state) === policy);
  const burnFirst = byPolicy("burn_first");
  const normalPool = byPolicy("normal");
  const preservePool = byPolicy("preserve");
  const effectivePool = burnFirst.length ? burnFirst : normalPool.length ? normalPool : preservePool.length ? preservePool : healthPool;
  const preferEarlierReset = Boolean(options.preferEarlierReset) && strategy !== "RELATIVE_AVAILABILITY";
  if (options.weeklyPace) {
    const tiers = (options.planPriority ?? []).map(normalizePlanPriorityType);
    const tier = (state: AccountState) => { const index = tiers.indexOf(normalizePlanPriorityType(state.planType)); return index < 0 ? tiers.length : index; };
    return { account: minBy(effectivePool, (state) => [Math.round(weeklyPacePoints(state, current)), tier(state), state.usedPercent ?? 0, state.accountId]),
      errorMessage: null };
  }

  let selected: AccountState;
  if (strategy === "ROUND_ROBIN") {
    const salt = effectiveReplicaSalt(options.replicaSalt);
    selected = seed !== null
      ? seededAccount(lowestPlannerCostCandidates(effectivePool, costs), seed)
      : minBy(effectivePool, (state) => [plannerCost(state, costs), state.lastSelectedAt ?? 0, decorrelatedTieBreaker(state.accountId, salt)]);
  } else if (strategy === "CAPACITY_WEIGHTED") {
    let pool = preferEarlierReset ? preferEarlierResetCandidates(effectivePool, current, resetWindow) : effectivePool;
    if (options.deterministicProbe) {
      selected = minBy(pool, (state) => [plannerCost(state, costs), -remainingSecondaryCredits(state), ...usageSortKey(state)]);
    } else {
      pool = lowestPlannerCostCandidates(pool, costs);
      selected = selectCapacityWeighted(pool, random, seed);
    }
  } else if (strategy === "RELATIVE_AVAILABILITY") {
    selected = selectRelativeAvailability(lowestPlannerCostCandidates(effectivePool, costs), {
      current, power: options.relativeAvailabilityPower ?? DEFAULT_RELATIVE_AVAILABILITY_POWER,
      topK: options.relativeAvailabilityTopK ?? DEFAULT_RELATIVE_AVAILABILITY_TOP_K,
      deterministicProbe: Boolean(options.deterministicProbe), seed, random
    });
  } else if (strategy === "FILL_FIRST") {
    const pool = options.preferEarlierReset ? preferEarlierResetCandidates(effectivePool, current, resetWindow) : effectivePool;
    selected = minBy(pool, (state) => [-(state.usedPercent ?? 0), -(state.secondaryUsedPercent ?? 0), state.accountId]);
  } else {
    const order = options.usageWeightedOrder ?? "secondary_first";
    if (seed !== null) {
      const pool = preferEarlierReset ? preferEarlierResetCandidates(effectivePool, current, resetWindow) : effectivePool;
      selected = seededAccount(lowestPlannerCostCandidates(pool, costs), seed);
    } else if (order === "primary_first") {
      selected = minBy(effectivePool, (state) => preferEarlierReset
        ? [resetPreferenceBucket(state, current, resetWindow), plannerCost(state, costs), ...primaryUsageSortKey(state)]
        : [plannerCost(state, costs), ...primaryUsageSortKey(state)]);
    } else {
      selected = minBy(effectivePool, (state) => preferEarlierReset
        ? [resetPreferenceBucket(state, current, resetWindow), plannerCost(state, costs), ...usageSortKey(state)]
        : [plannerCost(state, costs), ...usageSortKey(state)]);
    }
  }
  return { account: selected, errorMessage: null };
}

const RATE_LIMITED_MIN_COOLDOWN_SECONDS = 30;
const QUOTA_EXCEEDED_COOLDOWN_SECONDS = 120;

/** A near-future reset deadline, or null when the value is missing, past, or implausibly far away. */
export function plausibleRateLimitResetAt(resetAt: number | null | undefined, now: number, allowRoundingSlack = true): number | null {
  if (resetAt === null || resetAt === undefined || !Number.isFinite(resetAt)) return null;
  const horizon = RATE_LIMIT_RESET_MAX_HORIZON_SECONDS + (allowRoundingSlack ? RATE_LIMIT_RESET_ROUNDING_TOLERANCE_SECONDS : 0);
  if (resetAt <= now || resetAt > now + horizon) return null;
  return resetAt;
}

function extractResetAt(error: UpstreamError, now: number): number | null {
  const resetAt = plausibleRateLimitResetAt(error.resetsAt, now, false);
  if (resetAt !== null) {
    const rounded = Math.ceil(resetAt);
    return plausibleRateLimitResetAt(rounded, now) !== null ? rounded : null;
  }
  const resetIn = error.resetsInSeconds;
  if (resetIn === null || resetIn === undefined || !Number.isFinite(resetIn)) return null;
  if (resetIn <= 0 || resetIn > RATE_LIMIT_RESET_MAX_HORIZON_SECONDS) return null;
  const rounded = Math.ceil(now + resetIn);
  return plausibleRateLimitResetAt(rounded, now) !== null ? rounded : null;
}

export function handleRateLimit(state: AccountState, error: UpstreamError, now = Date.now() / 1000, random: () => number = Math.random): void {
  state.status = "RATE_LIMITED";
  state.errorCount += 1;
  state.lastErrorAt = now;
  state.blockedAt = now;
  const resetAt = extractResetAt(error, now);
  let delay = error.message ? parseRetryAfter(error.message) : null;
  let persistedDelay: number;
  if (delay === null) {
    delay = backoffSeconds(state.errorCount, random);
    persistedDelay = Math.max(delay, RATE_LIMITED_MIN_COOLDOWN_SECONDS);
  } else {
    persistedDelay = delay;
  }
  state.cooldownUntil = now + delay;
  state.resetAt = resetAt ?? Math.ceil(now + persistedDelay);
}

export function handleQuotaExceeded(state: AccountState, error: UpstreamError, now = Date.now() / 1000): void {
  state.status = "QUOTA_EXCEEDED";
  state.usedPercent = 100;
  state.blockedAt = now;
  state.cooldownUntil = now + QUOTA_EXCEEDED_COOLDOWN_SECONDS;
  state.resetAt = extractResetAt(error, now) ?? Math.trunc(now + 3600);
}

export function accountStatusForPermanentFailure(errorCode: string): BalancerAccountStatus {
  return reauthRequiredFailureCodes.has(errorCode) ? "REAUTH_REQUIRED" : "DEACTIVATED";
}

export function handlePermanentFailure(state: AccountState, errorCode: string): void {
  state.status = accountStatusForPermanentFailure(errorCode);
  state.deactivationReason = permanentFailureCodes[errorCode] ?? `Authentication failed: ${errorCode}`;
  state.blockedAt = null;
}

const BURST_SAME_ACCOUNT_BASE_SECONDS = 1;
const BURST_SAME_ACCOUNT_MAX_WAIT_SECONDS = 10;

/** Deterministic wait before same-account burst retry `retryIndex` (1-based); Retry-After acts as a floor. */
export function burstSameAccountBackoffSeconds(retryIndex: number, retryAfterSeconds: number | null): number {
  const exponential = BURST_SAME_ACCOUNT_BASE_SECONDS * 2 ** (Math.max(retryIndex, 1) - 1);
  const floor = retryAfterSeconds !== null && retryAfterSeconds > 0 ? retryAfterSeconds : 0;
  return Math.min(BURST_SAME_ACCOUNT_MAX_WAIT_SECONDS, Math.max(floor, exponential));
}

/** How a failure that the client has not seen yet is handled. Owner-bound requests never move accounts. */
export function failoverDecision(input: {
  failureClass: FailureClass; downstreamVisible: boolean; candidatesRemaining: number; ownerBound?: boolean; sameAccountRetryAvailable?: boolean;
}): FailoverAction {
  if (input.downstreamVisible) return "surface";
  if (input.ownerBound) return input.sameAccountRetryAvailable ? "retry_same_account" : "surface";
  if (input.candidatesRemaining <= 0) return "surface";
  return input.failureClass === "non_retryable" ? "surface" : "failover_next";
}

export function evaluateHealthTier(state: AccountState, options: { now?: number; drainEnteredAt?: number | null; probeSuccessStreak?: number } = {}): number {
  const current = options.now ?? Date.now() / 1000;
  if (["RATE_LIMITED", "QUOTA_EXCEEDED", "PAUSED", "DEACTIVATED"].includes(state.status)) return state.healthTier;
  const shouldDrain = (state.usedPercent !== null && state.usedPercent !== undefined && state.usedPercent >= DRAIN_PRIMARY_THRESHOLD_PCT)
    || (state.secondaryUsedPercent !== null && state.secondaryUsedPercent !== undefined && state.secondaryUsedPercent >= DRAIN_SECONDARY_THRESHOLD_PCT)
    || (state.errorCount >= DRAIN_ERROR_COUNT_THRESHOLD && state.lastErrorAt !== null && state.lastErrorAt !== undefined
      && current - state.lastErrorAt < DRAIN_ERROR_WINDOW_SECONDS);
  if (state.healthTier === HEALTH_TIER_HEALTHY) return shouldDrain ? HEALTH_TIER_DRAINING : HEALTH_TIER_HEALTHY;
  if (state.healthTier === HEALTH_TIER_DRAINING) {
    if (shouldDrain) return HEALTH_TIER_DRAINING;
    if (options.drainEnteredAt !== null && options.drainEnteredAt !== undefined && current - options.drainEnteredAt >= PROBE_QUIET_SECONDS) return HEALTH_TIER_PROBING;
    return HEALTH_TIER_DRAINING;
  }
  if (state.healthTier === HEALTH_TIER_PROBING) {
    if (shouldDrain) return HEALTH_TIER_DRAINING;
    return (options.probeSuccessStreak ?? 0) >= PROBE_SUCCESS_STREAK_REQUIRED ? HEALTH_TIER_HEALTHY : HEALTH_TIER_PROBING;
  }
  return HEALTH_TIER_HEALTHY;
}
