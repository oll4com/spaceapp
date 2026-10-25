/**
 * Code Assist account calls for Antigravity: the account's project and tier (`loadCodeAssist`) and its quota groups
 * (`retrieveUserQuotaSummary`). Every Code Assist request names the account's project, so the gateway rewrites it
 * when a request moves to another account.
 */
export const CODE_ASSIST_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

export type AntigravityQuotaGroup = "gemini" | "claude";

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

/** Claude and GPT models draw on the "Claude and GPT models" quota; everything else on the Gemini quota. */
export function quotaGroupForModel(model: string | null | undefined): AntigravityQuotaGroup {
  const name = (model ?? "").toLowerCase();
  return name.startsWith("claude") || name.startsWith("gpt") || name.includes("/claude") ? "claude" : "gemini";
}

async function post(path: string, accessToken: string, body: Json, fetchImpl: typeof fetch, baseUrl: string): Promise<Json> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "user-agent": "antigravity" },
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
export function parseQuotaSummary(data: unknown): Record<AntigravityQuotaGroup, AntigravityGroupUsage> {
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
  const gemini = groups.find((group) => String(group.displayName ?? "").toLowerCase().includes("gemini")
    || bucketsOf(group).some((bucket) => String(bucket.bucketId ?? "").includes("gemini")));
  const claude = groups.find((group) => /claude|gpt/.test(String(group.displayName ?? "").toLowerCase())
    || bucketsOf(group).some((bucket) => String(bucket.bucketId ?? "").includes("3p")));
  return { gemini: usage(gemini), claude: usage(claude) };
}

export async function fetchQuotaSummary(accessToken: string, project: string | null, options: { fetchImpl?: typeof fetch; baseUrl?: string } = {}) {
  return parseQuotaSummary(await post("/v1internal:retrieveUserQuotaSummary", accessToken, { project: project ?? "aicode-consumers" },
    options.fetchImpl ?? fetch, options.baseUrl ?? CODE_ASSIST_BASE_URL));
}
