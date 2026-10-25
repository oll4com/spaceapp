import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

// Runs inside the claude-vscode-parity wrapper as the CLI owner. It reads one account
// profile's OAuth sign-in, asks Anthropic for the plan usage that Claude Code's /usage
// shows, and prints only percentages and reset times. Tokens never leave this process.
// It never refreshes a token: rotating it here could sign out a running Claude pane, and
// every running pane already renews its own sign-in before it expires.
export const CLAUDE_USAGE_CONFIG_ROOT = "/var/lib/spaceapp-user/.codex/space-claude";
// The same key files claude-vscode-parity uses: the installation API key serves the "api" profile
// (and main without a subscription login); the "space-gateway" profile signs in with a gateway key.
export const CLAUDE_INSTALLATION_KEY_FILE = "/opt/spaceapp/secrets/space-claude.key";
export const CLAUDE_GATEWAY_KEY_FILE = "/var/lib/spaceapp-user/.config/space-gateway/claude-code.key";
const apiKeyProfileId = "api";
const gatewayProfileId = "space-gateway";
export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The free model list: a working API key answers 200, a revoked one 401 (used-up credits still 200). */
export const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
export const claudeUsageProfileIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

const tokenExpirySkewMs = 60_000;
const usageRequestTimeoutMs = 8_000;

// IDLE: the access token lapsed while no pane used the account; Claude renews it with the stored
// refresh token on its next request, so the account is still signed in. Only the reader reports it.
export type ClaudeProfileUsageStatus = "CONNECTED" | "IDLE" | "NOT_CONNECTED" | "EXPIRED" | "API_KEY" | "GATEWAY" | "ERROR";

export interface ClaudeProfileUsage {
  status: ClaudeProfileUsageStatus;
  email: string | null;
  plan: string | null;
  fiveHourUsedPercent: number | null;
  fiveHourResetAt: string | null;
  weeklyUsedPercent: number | null;
  weeklyResetAt: string | null;
  weeklyScope: string | null;
  /** API_KEY only: whether the key answered the model list; null when Anthropic could not be reached. */
  apiKeyVerified?: boolean | null;
}

export interface ClaudeUsageWindows {
  fiveHourUsedPercent: number | null;
  fiveHourResetAt: string | null;
  weeklyUsedPercent: number | null;
  weeklyResetAt: string | null;
  weeklyScope: string | null;
}

export interface ReadClaudeProfileUsageOptions {
  configRoot?: string;
  installationKeyFile?: string;
  gatewayKeyFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function percent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value * 10) / 10, 0), 100);
}

function isoTime(value: unknown): string | null {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function label(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : null;
}

export function claudeProfileDir(profileId: string, configRoot = CLAUDE_USAGE_CONFIG_ROOT): string {
  return profileId === "main" ? configRoot : join(configRoot, "profiles", profileId);
}

// Prefers the documented windows; team plans report weekly limits only as scoped entries
// in `limits`, so the tightest weekly entry is the one that blocks the account first.
export function parseClaudeOAuthUsage(data: unknown): ClaudeUsageWindows {
  const body = record(data);
  const limits = Array.isArray(body.limits) ? body.limits.map(record) : [];
  const fiveHour = record(body.five_hour);
  const session = limits.find((limit) => limit.group === "session" || limit.kind === "session");
  const sevenDay = record(body.seven_day);
  let weeklyUsedPercent = percent(sevenDay.utilization);
  let weeklyResetAt = isoTime(sevenDay.resets_at);
  let weeklyScope: string | null = null;
  if (weeklyUsedPercent === null) {
    const weekly = limits
      .filter((limit) => limit.group === "weekly" && percent(limit.percent) !== null)
      .sort((left, right) => (percent(right.percent) ?? 0) - (percent(left.percent) ?? 0))[0];
    if (weekly) {
      weeklyUsedPercent = percent(weekly.percent);
      weeklyResetAt = isoTime(weekly.resets_at);
      weeklyScope = label(record(record(weekly.scope).model).display_name);
    }
  }
  return {
    fiveHourUsedPercent: percent(fiveHour.utilization) ?? percent(session?.percent),
    fiveHourResetAt: isoTime(fiveHour.resets_at) ?? isoTime(session?.resets_at),
    weeklyUsedPercent,
    weeklyResetAt,
    weeklyScope
  };
}

export function claudePlanLabel(subscriptionType: unknown, rateLimitTier: unknown): string | null {
  const plan = label(subscriptionType);
  const tier = typeof rateLimitTier === "string" ? /max_(\d+)x/i.exec(rateLimitTier)?.[1] : undefined;
  const name = plan ? `${plan[0]!.toUpperCase()}${plan.slice(1)}` : null;
  if (name && tier) return `${name} · Max ${tier}x`;
  return name ?? (tier ? `Max ${tier}x` : null);
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  if (!(await regularFile(path))) return null;
  try {
    return record(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

// Mirrors the wrapper's gateway_key_valid: a regular, non-empty file the CLI owner keeps private.
async function privateKeyFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    const mode = stats.mode & 0o777;
    return stats.isFile() && stats.size > 0 && (mode === 0o600 || mode === 0o400) &&
      (typeof process.getuid !== "function" || stats.uid === process.getuid());
  } catch {
    return false;
  }
}

async function readApiKey(profileId: string, profileDir: string, installationKeyFile: string): Promise<string | null> {
  const files = [join(profileDir, "credentials", "api-key"), ...(profileId === "main" || profileId === apiKeyProfileId ? [installationKeyFile] : [])];
  for (const path of files) {
    if (!(await regularFile(path))) continue;
    const key = (await readFile(path, "utf8").catch(() => "")).trim();
    if (key) return key;
  }
  return null;
}

// A key only ever leaves this process as the credential of Anthropic's free model list.
async function verifyApiKey(apiKey: string, fetchImpl: typeof fetch): Promise<boolean | null> {
  try {
    const response = await fetchImpl(CLAUDE_MODELS_URL, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(usageRequestTimeoutMs)
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) return false;
    return response.ok ? true : null;
  } catch {
    return null;
  }
}

interface ClaudeSignIn {
  accessToken: string | null;
  refreshable: boolean;
  expiresAt: number | null;
  plan: string | null;
}

async function readSignIn(profileDir: string): Promise<ClaudeSignIn | null> {
  const credentials = await readJson(join(profileDir, ".credentials.json"));
  if (!credentials) return null;
  const oauth = record(credentials.claudeAiOauth);
  return {
    accessToken: typeof oauth.accessToken === "string" && oauth.accessToken ? oauth.accessToken : null,
    refreshable: typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0,
    expiresAt: typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
    plan: claudePlanLabel(oauth.subscriptionType, oauth.rateLimitTier)
  };
}

export async function readClaudeProfileUsage(
  profileId: string,
  options: ReadClaudeProfileUsageOptions = {}
): Promise<ClaudeProfileUsage> {
  if (!claudeUsageProfileIdPattern.test(profileId)) throw new Error("Invalid Claude account profile.");
  const configRoot = options.configRoot ?? CLAUDE_USAGE_CONFIG_ROOT;
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const profileDir = claudeProfileDir(profileId, configRoot);
  const state = await readJson(join(profileDir, ".claude.json"));
  const emailValue = record(state?.oauthAccount).emailAddress;
  const email = typeof emailValue === "string" && emailValue.includes("@") ? emailValue : null;
  const empty = {
    email,
    plan: null,
    fiveHourUsedPercent: null,
    fiveHourResetAt: null,
    weeklyUsedPercent: null,
    weeklyResetAt: null,
    weeklyScope: null,
    apiKeyVerified: null
  };

  if (profileId === gatewayProfileId) {
    return { ...empty, status: (await privateKeyFile(options.gatewayKeyFile ?? CLAUDE_GATEWAY_KEY_FILE)) ? "GATEWAY" : "NOT_CONNECTED" };
  }
  const installationKeyFile = options.installationKeyFile ?? CLAUDE_INSTALLATION_KEY_FILE;
  const apiKey = await readApiKey(profileId, profileDir, installationKeyFile);
  // The API account bills its key even when a subscription login is also stored.
  if (profileId === apiKeyProfileId && apiKey) {
    return { ...empty, status: "API_KEY", apiKeyVerified: await verifyApiKey(apiKey, fetchImpl) };
  }
  const signIn = await readSignIn(profileDir);
  if (!signIn?.accessToken) {
    if (!apiKey) return { ...empty, status: "NOT_CONNECTED" };
    return { ...empty, status: "API_KEY", apiKeyVerified: await verifyApiKey(apiKey, fetchImpl) };
  }
  const plan = signIn.plan;
  if (signIn.expiresAt !== null && signIn.expiresAt <= now().getTime() + tokenExpirySkewMs) {
    return { ...empty, plan, status: signIn.refreshable ? "IDLE" : "EXPIRED" };
  }

  try {
    const response = await fetchImpl(CLAUDE_OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${signIn.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(usageRequestTimeoutMs)
    });
    if (response.status === 401) return { ...empty, plan, status: "EXPIRED" };
    if (!response.ok) return { ...empty, plan, status: "ERROR" };
    return { ...empty, plan, ...parseClaudeOAuthUsage(await response.json()), status: "CONNECTED" };
  } catch {
    return { ...empty, plan, status: "ERROR" };
  }
}
