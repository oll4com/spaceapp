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
    weeklyUsedPercent, weeklyResetAt, weeklyScope
  };
}

export async function fetchClaudeUsage(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<ClaudeUsage> {
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: { authorization: `Bearer ${accessToken}`, "anthropic-beta": CLAUDE_OAUTH_BETA, "content-type": "application/json" },
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

export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

export interface ClaudeProfile {
  accountUuid: string | null;
  email: string | null;
  planType: string | null;
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
    planType: claudePlanLabel(organizationType, tier)
  };
}
