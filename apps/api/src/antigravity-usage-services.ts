import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  antigravityUsageAccountListSchema,
  type AntigravityUsageAccount,
  type AntigravityUsageAccountList,
  type AntigravityUsageGroup
} from "@space/contracts";

export const ANTIGRAVITY_CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ?? "";
export const ANTIGRAVITY_CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET ?? "";
export const ANTIGRAVITY_QUOTA_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
export const ANTIGRAVITY_LOAD_CODE_ASSIST_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
export const GOOGLE_OAUTH_TOKEN_URL =
  "https://oauth2.googleapis.com/token";

const usageCacheTtlMs = 60_000;
const usageStaleFallbackMs = 10 * 60_000;

export interface AntigravityProfileLocation {
  profileId: string;
  tokenPath: string;
}

export function extractEmailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  const rawPayload = parts[1];
  if (!rawPayload) return null;
  try {
    let payload = rawPayload.replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4 !== 0) payload += "=";
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    const claims = JSON.parse(decoded) as { email?: string };
    return typeof claims.email === "string" && claims.email.includes("@") ? claims.email : null;
  } catch {
    return null;
  }
}

function toPercent(fraction: unknown): number | null {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  return Math.min(Math.max(Math.round(fraction * 1000) / 10, 0), 100);
}

export function parseAntigravityQuotaSummary(data: unknown): {
  gemini: AntigravityUsageGroup;
  claude: AntigravityUsageGroup;
} {
  const emptyGroup = (displayName: string, description?: string): AntigravityUsageGroup => ({
    displayName,
    description: description ?? null,
    fiveHourRemainingPercent: null,
    fiveHourResetAt: null,
    weeklyRemainingPercent: null,
    weeklyResetAt: null
  });

  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const groups = Array.isArray(record.groups) ? (record.groups as Array<Record<string, unknown>>) : [];

  const extractGroup = (groupData: Record<string, unknown> | undefined, defaultName: string): AntigravityUsageGroup => {
    if (!groupData) return emptyGroup(defaultName);
    const buckets = Array.isArray(groupData.buckets)
      ? (groupData.buckets as Array<Record<string, unknown>>)
      : [];
    const b5h = buckets.find(
      (b) => b.window === "5h" || (typeof b.bucketId === "string" && b.bucketId.includes("5h"))
    );
    const bWeekly = buckets.find(
      (b) => b.window === "weekly" || (typeof b.bucketId === "string" && b.bucketId.includes("weekly"))
    );
    return {
      displayName: typeof groupData.displayName === "string" ? groupData.displayName : defaultName,
      description: typeof groupData.description === "string" ? groupData.description : null,
      fiveHourRemainingPercent: toPercent(b5h?.remainingFraction),
      fiveHourResetAt: typeof b5h?.resetTime === "string" ? b5h.resetTime : null,
      weeklyRemainingPercent: toPercent(bWeekly?.remainingFraction),
      weeklyResetAt: typeof bWeekly?.resetTime === "string" ? bWeekly.resetTime : null
    };
  };

  const geminiGroupData = groups.find((g) => {
    const name = String(g.displayName ?? "").toLowerCase();
    const buckets = Array.isArray(g.buckets) ? (g.buckets as Array<Record<string, unknown>>) : [];
    return name.includes("gemini") || buckets.some((b) => String(b.bucketId ?? "").includes("gemini"));
  });

  const claudeGroupData = groups.find((g) => {
    const name = String(g.displayName ?? "").toLowerCase();
    const buckets = Array.isArray(g.buckets) ? (g.buckets as Array<Record<string, unknown>>) : [];
    return (
      name.includes("claude") ||
      name.includes("gpt") ||
      buckets.some((b) => String(b.bucketId ?? "").includes("3p"))
    );
  });

  return {
    gemini: extractGroup(geminiGroupData, "Gemini Models"),
    claude: extractGroup(claudeGroupData, "Claude and GPT models")
  };
}

export async function discoverAntigravityProfiles(
  codexHome: string = "/var/lib/spaceapp-user/.codex"
): Promise<AntigravityProfileLocation[]> {
  const locations: AntigravityProfileLocation[] = [];
  const geminiRoot = join(codexHome, "space-gemini");

  const mainToken = join(geminiRoot, "home", ".gemini", "antigravity-cli", "antigravity-oauth-token");
  locations.push({ profileId: "main", tokenPath: mainToken });

  const profilesDir = join(geminiRoot, "profiles");
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        locations.push({
          profileId: entry.name,
          tokenPath: join(profilesDir, entry.name, "home", ".gemini", "antigravity-cli", "antigravity-oauth-token")
        });
      }
    }
  } catch {}

  return locations;
}

export interface AntigravityUsageProviderOptions {
  codexHome?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  profileLabels?: () => Promise<Map<string, string>>;
}

export function createAntigravityUsageAccountProvider(
  options: AntigravityUsageProviderOptions = {}
): () => Promise<AntigravityUsageAccountList> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const codexHome = options.codexHome ?? "/var/lib/spaceapp-user/.codex";

  let cached: { value: AntigravityUsageAccountList; collectedAtMs: number } | null = null;
  let inFlight: Promise<AntigravityUsageAccountList> | null = null;

  async function fetchProfileUsage(
    loc: AntigravityProfileLocation,
    displayLabel: string
  ): Promise<AntigravityUsageAccount | null> {
    let tokenJsonStr: string;
    try {
      tokenJsonStr = await readFile(loc.tokenPath, "utf8");
    } catch {
      return null;
    }

    let tokenData: any;
    try {
      tokenData = JSON.parse(tokenJsonStr);
    } catch {
      return null;
    }

    const email = extractEmailFromIdToken(tokenData?.id_token);
    let accessToken: string | null = tokenData?.token?.access_token ?? null;
    const refreshToken: string | null = tokenData?.token?.refresh_token ?? null;
    const expiryStr: string | null = tokenData?.token?.expiry ?? null;

    const expiryMs = expiryStr ? Date.parse(expiryStr) : Number.NaN;
    const currentMs = now().getTime();
    const needsRefresh =
      !accessToken ||
      !Number.isFinite(expiryMs) ||
      expiryMs <= currentMs + 120_000;

    if (needsRefresh && refreshToken && ANTIGRAVITY_CLIENT_ID && ANTIGRAVITY_CLIENT_SECRET) {
      try {
        const body = new URLSearchParams({
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: "refresh_token"
        });
        const refreshResp = await fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString()
        });
        if (refreshResp.ok) {
          const refreshData = (await refreshResp.json()) as any;
          if (refreshData.access_token) {
            accessToken = refreshData.access_token;
            tokenData.token = {
              ...tokenData.token,
              access_token: refreshData.access_token,
              expiry: new Date(currentMs + (refreshData.expires_in ?? 3600) * 1000).toISOString()
            };
            await writeFile(loc.tokenPath, JSON.stringify(tokenData, null, 2), "utf8").catch(() => {});
          }
        }
      } catch {}
    }

    const emptyGroup = (displayName: string): AntigravityUsageGroup => ({
      displayName,
      description: null,
      fiveHourRemainingPercent: null,
      fiveHourResetAt: null,
      weeklyRemainingPercent: null,
      weeklyResetAt: null
    });

    if (!accessToken) {
      return {
        id: loc.profileId,
        label: displayLabel,
        email,
        tier: null,
        status: "EXPIRED",
        gemini: emptyGroup("Gemini Models"),
        claude: emptyGroup("Claude and GPT models"),
        sampledAt: now().toISOString()
      };
    }

    try {
      // Step 1: Call loadCodeAssist to discover the correct project and account tier.
      // This is required because retrieveUserQuotaSummary returns 403 for free-tier
      // accounts when called without a project, but succeeds when the correct project
      // (e.g. "aicode-consumers") is supplied in the request body.
      let quotaProject = "aicode-consumers";
      let tierLabel: string | null = null;

      try {
        const lcaResp = await fetchImpl(ANTIGRAVITY_LOAD_CODE_ASSIST_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "Antigravity/1.2.3"
          },
          body: JSON.stringify({
            metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "PLUGIN_UNSPECIFIED" }
          })
        });
        if (lcaResp.ok) {
          const lcaData = (await lcaResp.json()) as any;
          if (typeof lcaData?.cloudaicompanionProject === "string" && lcaData.cloudaicompanionProject) {
            quotaProject = lcaData.cloudaicompanionProject;
          }
          // Prefer paidTier name if it is a real paid tier, otherwise fall back to currentTier name
          const paidTierName: string | undefined = lcaData?.paidTier?.name;
          const paidTierId: string | undefined = lcaData?.paidTier?.id;
          if (paidTierName && paidTierId && paidTierId !== "free-tier") {
            tierLabel = paidTierName;
          } else if (typeof lcaData?.currentTier?.name === "string") {
            tierLabel = lcaData.currentTier.name;
          }
        }
      } catch {
        // Non-fatal: fall back to default project and null tier
      }

      const quotaResp = await fetchImpl(ANTIGRAVITY_QUOTA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "Antigravity/1.2.3"
        },
        body: JSON.stringify({ project: quotaProject })
      });

      if (quotaResp.status === 401 || quotaResp.status === 403) {
        return {
          id: loc.profileId,
          label: displayLabel,
          email,
          tier: tierLabel,
          status: "UNLICENSED",
          gemini: emptyGroup("Gemini Models"),
          claude: emptyGroup("Claude and GPT models"),
          sampledAt: now().toISOString()
        };
      }

      if (!quotaResp.ok) {
        return {
          id: loc.profileId,
          label: displayLabel,
          email,
          tier: tierLabel,
          status: "ERROR",
          gemini: emptyGroup("Gemini Models"),
          claude: emptyGroup("Claude and GPT models"),
          sampledAt: now().toISOString()
        };
      }

      const quotaData = await quotaResp.json();
      const parsedGroups = parseAntigravityQuotaSummary(quotaData);

      return {
        id: loc.profileId,
        label: displayLabel,
        email,
        tier: tierLabel,
        status: "CONNECTED",
        gemini: parsedGroups.gemini,
        claude: parsedGroups.claude,
        sampledAt: now().toISOString()
      };
    } catch {
      return {
        id: loc.profileId,
        label: displayLabel,
        email,
        tier: null,
        status: "ERROR",
        gemini: emptyGroup("Gemini Models"),
        claude: emptyGroup("Claude and GPT models"),
        sampledAt: now().toISOString()
      };
    }
  }


  function unavailable(): AntigravityUsageAccountList {
    const current = now();
    if (cached && current.getTime() - cached.collectedAtMs <= usageStaleFallbackMs) {
      return antigravityUsageAccountListSchema.parse({
        ...cached.value,
        isStale: true,
        error: "Antigravity usage data is temporarily unavailable.",
        checkedAt: current.toISOString()
      });
    }
    return antigravityUsageAccountListSchema.parse({
      data: [],
      pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
      source: "space-gemini-profiles",
      isStale: true,
      error: "Antigravity usage data is temporarily unavailable.",
      checkedAt: current.toISOString()
    });
  }

  async function collect(): Promise<AntigravityUsageAccountList> {
    const profiles = await discoverAntigravityProfiles(codexHome);
    const labels = options.profileLabels ? await options.profileLabels().catch(() => new Map()) : new Map();

    const results = await Promise.all(
      profiles.map((loc) => {
        const configuredLabel = labels.get(loc.profileId);
        const label = configuredLabel || loc.profileId;
        return fetchProfileUsage(loc, label);
      })
    );

    const data = results.filter((r): r is AntigravityUsageAccount => r !== null);
    // Sort so connected/active accounts appear with priority, and alphabetically by email/label
    data.sort((a, b) => {
      if (a.status === "CONNECTED" && b.status !== "CONNECTED") return -1;
      if (a.status !== "CONNECTED" && b.status === "CONNECTED") return 1;
      return (a.email || a.label).localeCompare(b.email || b.label);
    });

    const collectedAt = now();
    const value = antigravityUsageAccountListSchema.parse({
      data,
      pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: data.length ? 1 : 0 },
      source: "space-gemini-profiles",
      isStale: false,
      error: null,
      checkedAt: collectedAt.toISOString()
    });

    cached = { value, collectedAtMs: collectedAt.getTime() };
    return value;
  }

  function refresh(): Promise<AntigravityUsageAccountList> {
    if (inFlight) return inFlight;
    const request = collect().catch(() => unavailable());
    inFlight = request;
    const clear = () => {
      if (inFlight === request) inFlight = null;
    };
    void request.then(clear, clear);
    return request;
  }

  return async () => {
    const nowMs = now().getTime();
    if (cached && nowMs - cached.collectedAtMs <= usageCacheTtlMs) return cached.value;
    if (cached && nowMs - cached.collectedAtMs <= usageStaleFallbackMs) {
      void refresh();
      return cached.value;
    }
    return refresh();
  };
}
