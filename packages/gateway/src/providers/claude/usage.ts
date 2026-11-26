import type { GatewayResetGrant } from "@space/contracts";
import { CLAUDE_OAUTH_BETA } from "./oauth.js";

/**
 * Claude plan usage (`/api/oauth/usage`, what Claude Code's /usage shows): the 5-hour session window and the weekly
 * window, as Space already reads them for profile quotas (apps/api/src/claude-usage.ts).
 */
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface ClaudeUsage {
  fiveHourUsedPercent: number | null;
  fiveHourResetAt: string | null;
  weeklyUsedPercent: number | null;
  weeklyResetAt: string | null;
  weeklyScope: string | null;
  /** Limit-reset grants ("cedar_ember", what Claude Code's /limit-reset spends), null when the answer carried none. */
  resetGrants: ClaudeResetGrant[] | null;
  /** The windows Anthropic says are used up ("five_hour", "seven_day", ...). */
  exhausted: string[];
}

export interface ClaudeResetGrant extends GatewayResetGrant { id: string; usableNow: boolean; clears: string[] }

/** Claude Code's reset program and the windows a grant can clear (read from Claude Code 2.1.325). */
export const CLAUDE_RESET_PROGRAM = "cedar_ember";
const CLAUDE_USAGE_QUERY = `?${CLAUDE_RESET_PROGRAM}=1&skip_spend=1`;
/**
 * Anthropic gives the reset grants only to Claude Code: without its user agent the usage answer says `eligible: false,
 * ineligible_reason: "surface"` with no grants and nothing used up (read 14/11 on crew@: every account showed "Resets 0").
 * shortcut: pinned to the Claude Code version that read them; raise it if the answer says ineligible_reason "cli_version".
 */
export const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.325 (external, cli)";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Claude Code's own kind of a grant: one that gives back weekly is Fable's, else its type, else what it clears. */
export function claudeResetKind(grant: { gives_back_weekly?: unknown; type?: unknown; clears: string[] }): GatewayResetGrant["kind"] {
  if (grant.gives_back_weekly === true) return "fable";
  if (grant.type === "session" || grant.type === "weekly" || grant.type === "full") return grant.type;
  const session = grant.clears.includes("five_hour"), other = grant.clears.some((window) => window !== "five_hour");
  return session && !other ? "session" : other && !session ? "weekly" : "full";
}

export function parseClaudeResetGrants(data: unknown, now = Date.now()): ClaudeResetGrant[] | null {
  const program = record(record(data)[CLAUDE_RESET_PROGRAM]);
  if (!Array.isArray(program.grants)) return null;
  return program.grants.map(record).flatMap((grant) => {
    const clears = strings(grant.clears);
    const left = typeof grant.resets_left === "number" && Number.isInteger(grant.resets_left) ? Math.max(0, grant.resets_left) : 0;
    const endsAt = isoTime(grant.ends_at);
    if (typeof grant.id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(grant.id) || grant.paused === true || left === 0
      || (endsAt !== null && Date.parse(endsAt) <= now)) return [];
    return [{ id: grant.id, kind: claudeResetKind({ ...grant, clears }), left, endsAt, usableNow: grant.usable_now === true, clears }];
  }).sort((left, right) => (left.endsAt ? Date.parse(left.endsAt) : Infinity) - (right.endsAt ? Date.parse(right.endsAt) : Infinity));
}

/**
 * The grant to spend on the used-up windows: one Anthropic says is usable now and that clears one of them, the earliest to expire first,
 * one that clears every used-up window before one that clears only the week. While the week is used up, only a grant that clears the week
 * fits: a session reset would leave it blocked. Null when none fits.
 */
export function claudeResetGrantFor(grants: ClaudeResetGrant[], exhausted: string[]): ClaudeResetGrant | null {
  // A Fable grant gives back only what Fable used this week, never a fresh week (Claude Code 2.1.325; dev@ 14/11: a used-up week came back at 93%).
  const clears = (grant: ClaudeResetGrant, window: string) => grant.clears.includes(window) && !(grant.kind === "fable" && window === "seven_day");
  const usable = grants.filter((grant) => grant.usableNow && exhausted.some((window) => clears(grant, window))
    && (!exhausted.includes("seven_day") || clears(grant, "seven_day")));
  return usable.find((grant) => exhausted.every((window) => clears(grant, window))) ?? usable[0] ?? null;
}

export class ClaudeUsageError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const percent = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.round(value * 10) / 10, 0), 100) : null;
const isoTime = (value: unknown): string | null => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

export function parseClaudeUsage(data: unknown): ClaudeUsage {
  const body = record(data);
  const limits = Array.isArray(body.limits) ? body.limits.map(record) : [];
  const fiveHour = record(body.five_hour);
  const session = limits.find((limit) => limit.group === "session" || limit.kind === "session");
  const sevenDay = record(body.seven_day);
  let weeklyUsedPercent = percent(sevenDay.utilization);
  let weeklyResetAt = isoTime(sevenDay.resets_at);
  let weeklyScope: string | null = null;
  if (weeklyUsedPercent === null) {
    const weekly = limits.filter((limit) => limit.group === "weekly" && percent(limit.percent) !== null)
      .sort((left, right) => (percent(right.percent) ?? 0) - (percent(left.percent) ?? 0))[0];
    if (weekly) {
      weeklyUsedPercent = percent(weekly.percent);
      weeklyResetAt = isoTime(weekly.resets_at);
      const name = record(record(weekly.scope).model).display_name;
      weeklyScope = typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : null;
    }
  }
  return {
    fiveHourUsedPercent: percent(fiveHour.utilization) ?? percent(session?.percent),
    fiveHourResetAt: isoTime(fiveHour.resets_at) ?? isoTime(session?.resets_at),
    weeklyUsedPercent, weeklyResetAt, weeklyScope,
    resetGrants: parseClaudeResetGrants(data), exhausted: strings(record(body[CLAUDE_RESET_PROGRAM]).exhausted)
  };
}

export async function fetchClaudeUsage(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<ClaudeUsage> {
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_USAGE_URL + CLAUDE_USAGE_QUERY, {
      headers: { authorization: `Bearer ${accessToken}`, "anthropic-beta": CLAUDE_OAUTH_BETA, "content-type": "application/json",
        "user-agent": CLAUDE_CODE_USER_AGENT },
      signal: AbortSignal.timeout(8_000)
    });
  } catch (error) {
    throw new ClaudeUsageError(0, `Claude usage request failed: ${error instanceof Error ? error.message : "network error"}`);
  }
  if (!response.ok) throw new ClaudeUsageError(response.status, `Claude usage returned HTTP ${response.status}`);
  return parseClaudeUsage(await response.json());
}

/** Plan from the access token's rate-limit tier header values or subscription type, e.g. "max" + "default_claude_max_20x". */
export function claudePlanLabel(subscriptionType: string | null, rateLimitTier: string | null): string | null {
  const tier = rateLimitTier ? /max_(\d+)x/i.exec(rateLimitTier)?.[1] : undefined;
  if (tier) return `max${tier}x`;
  return subscriptionType?.toLowerCase() ?? null;
}

export type ClaudeResetOutcome = "RESET" | "ALREADY_REDEEMED" | "NOTHING_TO_RESET" | "NO_CREDIT";
const RESET_OUTCOMES: Record<string, ClaudeResetOutcome> = {
  reset: "RESET", already_used: "ALREADY_REDEEMED", not_limited: "NOTHING_TO_RESET", cooldown: "NO_CREDIT", ineligible: "NO_CREDIT", unavailable: "NO_CREDIT"
};

/**
 * Spends one grant the way Claude Code's /limit-reset does: `request_id` makes a repeat of the same request spend nothing more.
 * Returns the outcome and the windows Anthropic cleared.
 */
export async function claimClaudeReset(input: { accessToken: string; organizationUuid: string; grantId: string; requestId: string; fetchImpl?: typeof fetch }):
  Promise<{ outcome: ClaudeResetOutcome; cleared: string[] }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.anthropic.com/api/organizations/${encodeURIComponent(input.organizationUuid)}/reset_rate_limits`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.accessToken}`, "anthropic-beta": CLAUDE_OAUTH_BETA, "content-type": "application/json",
        "user-agent": CLAUDE_CODE_USER_AGENT },
      body: JSON.stringify({ program: CLAUDE_RESET_PROGRAM, grant_id: input.grantId, request_id: input.requestId }),
      signal: AbortSignal.timeout(25_000)
    });
  } catch (error) {
    throw new ClaudeUsageError(0, `Claude reset request failed: ${error instanceof Error ? error.message : "network error"}`);
  }
  if (!response.ok) throw new ClaudeUsageError(response.status, `Claude reset returned HTTP ${response.status}`);
  const body = record(await response.json());
  const outcome = RESET_OUTCOMES[String(body.result)];
  if (!outcome) throw new ClaudeUsageError(502, `Claude reset answered an unknown result: ${String(body.result).slice(0, 40)}`);
  return { outcome, cleared: strings(body.cleared) };
}

export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

export interface ClaudeProfile {
  accountUuid: string | null;
  email: string | null;
  planType: string | null;
  organizationUuid: string | null;
}

/** The signed-in account and its subscription (what Claude Code stores as subscriptionType and rateLimitTier). */
export async function fetchClaudeProfile(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<ClaudeProfile> {
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}`, "anthropic-beta": CLAUDE_OAUTH_BETA, "content-type": "application/json" },
      signal: AbortSignal.timeout(8_000)
    });
  } catch (error) {
    throw new ClaudeUsageError(0, `Claude profile request failed: ${error instanceof Error ? error.message : "network error"}`);
  }
  if (!response.ok) throw new ClaudeUsageError(response.status, `Claude profile returned HTTP ${response.status}`);
  const body = record(await response.json());
  const account = record(body.account);
  const organization = record(body.organization);
  const organizationType = typeof organization.organization_type === "string" ? organization.organization_type.replace(/^claude_/, "") : null;
  const tier = typeof organization.rate_limit_tier === "string" ? organization.rate_limit_tier : null;
  return {
    accountUuid: typeof account.uuid === "string" ? account.uuid : null,
    email: typeof account.email === "string" ? account.email : typeof account.email_address === "string" ? account.email_address : null,
    planType: claudePlanLabel(organizationType, tier),
    organizationUuid: typeof organization.uuid === "string" ? organization.uuid : null
  };
}
