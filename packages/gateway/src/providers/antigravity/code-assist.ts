/**
 * Code Assist account calls for Antigravity: the account's project and tier (`loadCodeAssist`) and its quota groups
 * (`retrieveUserQuotaSummary`). Every Code Assist request names the account's project, so the gateway rewrites it
 * when a request moves to another account.
 */
import { readlink } from "node:fs/promises";
import { basename } from "node:path";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

export const CODE_ASSIST_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

export type AntigravityQuotaGroup = "gemini" | "claude" | "argon";

export interface AntigravityAccountInfo {
  project: string | null;
  tierId: string | null;
  planType: string;
}

export interface AntigravityGroupUsage {
  fiveHourUsedPercent: number | null;
  fiveHourResetAt: string | null;
  weeklyUsedPercent: number | null;
  weeklyResetAt: string | null;
}

export class CodeAssistError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});

/** Claude and GPT models draw on "Claude · GPT", Argon/Pro on the separate Argon quota, everything else on Gemini. */
export function quotaGroupForModel(model: string | null | undefined): AntigravityQuotaGroup {
  const name = (model ?? "").toLowerCase();
  if (name.includes("argon") || name.startsWith("gemini-pro") || name.startsWith("gemini-3-pro") || name.startsWith("gemini-3.1-pro")) return "argon";
  return name.startsWith("claude") || name.startsWith("gpt") || name.includes("/claude") ? "claude" : "gemini";
}

export { antigravityModelRequiresPaidPlan } from "@space/contracts";

// Google lists the Gemini Models quota group only to the Antigravity CLI ("antigravity" alone gets Claude · GPT only), so
// name the installed CLI as apps/api/src/antigravity-usage-services.ts does.
async function antigravityUserAgent(): Promise<string> {
  const version = basename(await readlink(`${SPACE_INSTALL_ROOT}/var/cli-versions/gemini/current`).catch(() => ""));
  return `antigravity/cli/${/^\d+\.\d+\.\d+$/.test(version) ? version : "1.5.3"}`;
}

async function post(path: string, accessToken: string, body: Json, fetchImpl: typeof fetch, baseUrl: string): Promise<Json> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "user-agent": await antigravityUserAgent() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw new CodeAssistError(0, `Code Assist request failed: ${error instanceof Error ? error.message : "network error"}`);
  }
  if (!response.ok) throw new CodeAssistError(response.status, `Code Assist ${path} returned HTTP ${response.status}`);
  return obj(await response.json().catch(() => ({})));
}

export async function loadCodeAssist(accessToken: string, options: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): Promise<AntigravityAccountInfo> {
  const data = await post("/v1internal:loadCodeAssist", accessToken,
    { metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "PLUGIN_UNSPECIFIED" } },
    options.fetchImpl ?? fetch, options.baseUrl ?? CODE_ASSIST_BASE_URL);
  const paid = obj(data.paidTier);
  const current = obj(data.currentTier);
  const paidId = typeof paid.id === "string" && paid.id !== "free-tier" ? paid.id : null;
  const tierId = paidId ?? (typeof current.id === "string" ? current.id : null);
  const tierName = paidId ? paid.name : current.id === "free-tier" ? "free" : current.name;
  const planType = typeof tierName === "string" && tierName.trim() ? tierName.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40) : "free";
  return { project: typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject ? data.cloudaicompanionProject : null, tierId, planType };
}

const usedFromRemaining = (fraction: unknown): number | null =>
  typeof fraction === "number" && Number.isFinite(fraction) ? Math.min(100, Math.max(0, Math.round((1 - fraction) * 1000) / 10)) : null;

/** Quota groups as Space reads them for profiles (apps/api/src/antigravity-usage-services.ts), as used percentages. */
export function parseQuotaSummary(data: unknown, userQuota?: unknown, nowMs = Date.now()): Record<AntigravityQuotaGroup, AntigravityGroupUsage> {
  const groups = Array.isArray(obj(data).groups) ? (obj(data).groups as unknown[]).map(obj) : [];
  const bucketsOf = (group: Json) => (Array.isArray(group.buckets) ? (group.buckets as unknown[]).map(obj) : []);
  const usage = (group: Json | undefined): AntigravityGroupUsage => {
    const buckets = group ? bucketsOf(group) : [];
    const five = buckets.find((bucket) => bucket.window === "5h" || String(bucket.bucketId ?? "").includes("5h"));
    const week = buckets.find((bucket) => bucket.window === "weekly" || String(bucket.bucketId ?? "").includes("weekly"));
    return {
      fiveHourUsedPercent: usedFromRemaining(five?.remainingFraction), fiveHourResetAt: typeof five?.resetTime === "string" ? five.resetTime : null,
      weeklyUsedPercent: usedFromRemaining(week?.remainingFraction), weeklyResetAt: typeof week?.resetTime === "string" ? week.resetTime : null
    };
  };
  // "Gemini 4 Argon" also names Gemini: only the family group counts, as apps/api/src/antigravity-usage-services.ts reads it.
  const groupKey = (group: Json) => {
    const bucket = bucketsOf(group)[0];
    const id = String(bucket?.bucketId ?? ""), window = String(bucket?.window ?? "");
    return window && id.endsWith(`-${window}`) ? id.slice(0, -window.length - 1) : id.replace(/-[^-]*$/, "");
  };
  const gemini = usage(groups.find((group) => groupKey(group) === "gemini")
    ?? groups.find((group) => /^gemini models?$/i.test(String(group.displayName ?? "").trim())));
  const claude = usage(groups.find((group) => /claude|gpt/.test(String(group.displayName ?? "").toLowerCase())
    || bucketsOf(group).some((bucket) => String(bucket.bucketId ?? "").includes("3p"))));
  const argon = usage(groups.find((group) => groupKey(group) === "gemini-argon-wtu" || groupKey(group) === "argon")
    ?? groups.find((group) => /argon/i.test(String(group.displayName ?? "").trim())));
  if (gemini.fiveHourUsedPercent === null && gemini.weeklyUsedPercent === null && userQuota) {
    const raw = Array.isArray(obj(userQuota).buckets) ? (obj(userQuota).buckets as unknown[]).map(obj) : [];
    const geminiBuckets = raw.filter((b) => /^gemini/i.test(String(b.modelId ?? "")) && usedFromRemaining(b.remainingFraction) !== null);
    const weeklyOnly = claude.fiveHourUsedPercent === null && claude.weeklyUsedPercent !== null;
    const isWeekly = (b: Json) => b.window === "weekly" || weeklyOnly || (typeof b.resetTime === "string" && Date.parse(b.resetTime) - nowMs > 6 * 3_600_000);
    const tightest = (items: Json[]) => items.reduce<Json | undefined>(
      (best, cur) => (!best || (usedFromRemaining(cur.remainingFraction) ?? 0) > (usedFromRemaining(best.remainingFraction) ?? 0) ? cur : best),
      undefined
    );
    const five = tightest(geminiBuckets.filter((b) => !isWeekly(b)));
    const week = tightest(geminiBuckets.filter(isWeekly));
    if (five) { gemini.fiveHourUsedPercent = usedFromRemaining(five.remainingFraction); gemini.fiveHourResetAt = typeof five.resetTime === "string" ? five.resetTime : null; }
    if (week) { gemini.weeklyUsedPercent = usedFromRemaining(week.remainingFraction); gemini.weeklyResetAt = typeof week.resetTime === "string" ? week.resetTime : null; }
  }
  return { gemini, claude, argon };
}

export async function fetchQuotaSummary(accessToken: string, project: string | null, options: { fetchImpl?: typeof fetch; baseUrl?: string } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? CODE_ASSIST_BASE_URL;
  const body = { project: project ?? "aicode-consumers" };
  const summary = await post("/v1internal:retrieveUserQuotaSummary", accessToken, body, fetchImpl, baseUrl);
  const parsed = parseQuotaSummary(summary);
  if (parsed.gemini.fiveHourUsedPercent !== null || parsed.gemini.weeklyUsedPercent !== null) return parsed;
  const userQuota = await post("/v1internal:retrieveUserQuota", accessToken, body, fetchImpl, baseUrl).catch(() => null);
  return userQuota ? parseQuotaSummary(summary, userQuota) : parsed;
}
