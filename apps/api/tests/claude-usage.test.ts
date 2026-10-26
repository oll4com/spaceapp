import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_OAUTH_USAGE_URL,
  claudePlanLabel,
  parseClaudeOAuthUsage,
  readClaudeProfileUsage
} from "../src/claude-usage.js";
import { anthropicMonthSpendUsd, claudeGatewayApiKeyUsage, claudeGatewayPool, createClaudeUsageAccountProvider } from "../src/claude-usage-services.js";
import type { GatewayAccountRecord } from "@space/db";
import type { GatewayRequestLog } from "@space/contracts";

const now = new Date("2026-10-11T01:00:00.000Z");
const accessToken = "sk-ant-oat01-fixture-secret";

// Shape returned for a team plan on 2026-10-11: no seven_day, weekly limits are scoped.
const teamUsage = {
  five_hour: { utilization: 67.0, resets_at: "2026-10-11T04:49:59.732074+00:00" },
  seven_day: null,
  limits: [
    { kind: "session", group: "session", percent: 67, resets_at: "2026-10-11T04:49:59.732074+00:00", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 3, resets_at: "2026-10-15T02:00:00+00:00", scope: { model: { id: null, display_name: "Fable" } } },
    { kind: "weekly_scoped", group: "weekly", percent: 12, resets_at: "2026-10-16T02:00:00+00:00", scope: { model: { id: null, display_name: "Opus" } } }
  ]
};

const roots: string[] = [];

// An old sample answers at once and starts a fresh collection in the background; this reads after that collection.
async function afterRefresh<T>(provider: () => Promise<T>): Promise<T> {
  await provider();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return provider();
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "space-claude-usage-"));
  roots.push(root);
  return root;
}

async function writeProfile(root: string, profileId: string, options: {
  expiresAt?: number;
  email?: string;
  apiKey?: boolean;
  credentials?: boolean;
  refreshToken?: boolean;
} = {}): Promise<string> {
  const dir = profileId === "main" ? root : join(root, "profiles", profileId);
  await mkdir(join(dir, "credentials"), { recursive: true });
  if (options.email) {
    await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: options.email } }));
  }
  if (options.credentials !== false && !options.apiKey) {
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken,
        ...(options.refreshToken === false ? {} : { refreshToken: "sk-ant-ort01-fixture-refresh" }),
        expiresAt: options.expiresAt ?? now.getTime() + 3_600_000,
        subscriptionType: "team",
        rateLimitTier: "default_claude_max_5x"
      }
    }));
  }
  if (options.apiKey) await writeFile(join(dir, "credentials", "api-key"), "sk-ant-api-fixture\n");
  return dir;
}

function usageFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("Claude plan usage parsing", () => {
  it("uses the session window and the tightest scoped weekly limit for team plans", () => {
    expect(parseClaudeOAuthUsage(teamUsage)).toEqual({
      fiveHourUsedPercent: 67,
      fiveHourResetAt: "2026-10-11T04:49:59.732Z",
      weeklyUsedPercent: 12,
      weeklyResetAt: "2026-10-16T02:00:00.000Z",
      weeklyScope: "Opus"
    });
  });

  it("prefers the overall seven-day window when the plan reports one", () => {
    expect(parseClaudeOAuthUsage({
      five_hour: { utilization: 4.25, resets_at: "2026-10-11T05:00:00Z" },
      seven_day: { utilization: 31, resets_at: "2026-10-14T00:00:00Z" },
      limits: teamUsage.limits
    })).toMatchObject({ fiveHourUsedPercent: 4.3, weeklyUsedPercent: 31, weeklyResetAt: "2026-10-14T00:00:00.000Z", weeklyScope: null });
  });

  it("returns empty windows for unexpected bodies", () => {
    expect(parseClaudeOAuthUsage(null)).toEqual({
      fiveHourUsedPercent: null,
      fiveHourResetAt: null,
      weeklyUsedPercent: null,
      weeklyResetAt: null,
      weeklyScope: null
    });
    expect(parseClaudeOAuthUsage({ five_hour: { utilization: "high" }, limits: "none" }).fiveHourUsedPercent).toBeNull();
  });

  it("labels the plan from the stored subscription and rate tier", () => {
    expect(claudePlanLabel("team", "default_claude_max_5x")).toBe("Team · Max 5x");
    expect(claudePlanLabel("pro", null)).toBe("Pro");
    expect(claudePlanLabel(null, "default_claude_max_20x")).toBe("Max 20x");
    expect(claudePlanLabel(undefined, undefined)).toBeNull();
  });
});

describe("Claude profile usage reader", () => {
  it("reads one profile's usage with its own sign-in and never returns the token", async () => {
    const root = await profileRoot();
    await writeProfile(root, "lab", { email: "lab@example.com" });
    const fetchImpl = usageFetch(200, teamUsage);
    const usage = await readClaudeProfileUsage("lab", { configRoot: root, fetchImpl, now: () => now });
    expect(usage).toEqual({
      status: "CONNECTED",
      email: "lab@example.com",
      plan: "Team · Max 5x",
      fiveHourUsedPercent: 67,
      fiveHourResetAt: "2026-10-11T04:49:59.732Z",
      weeklyUsedPercent: 12,
      weeklyResetAt: "2026-10-16T02:00:00.000Z",
      weeklyScope: "Opus",
      apiKeyVerified: null
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLAUDE_OAUTH_USAGE_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${accessToken}`);
    expect(JSON.stringify(usage)).not.toContain("sk-ant");
  });

  it("reads the main account from the config root", async () => {
    const root = await profileRoot();
    await writeProfile(root, "main", { email: "main@example.com" });
    const usage = await readClaudeProfileUsage("main", { configRoot: root, fetchImpl: usageFetch(200, teamUsage), now: () => now });
    expect(usage).toMatchObject({ status: "CONNECTED", email: "main@example.com" });
  });

  it("reports a missing sign-in without calling Anthropic, and checks an API key profile's key with the free model list only", async () => {
    const root = await profileRoot();
    await writeProfile(root, "keyed", { apiKey: true });
    const fetchImpl = usageFetch(200, { data: [] });
    await expect(readClaudeProfileUsage("absent", { configRoot: root, installationKeyFile: join(root, "missing.key"), fetchImpl, now: () => now }))
      .resolves.toMatchObject({ status: "NOT_CONNECTED", email: null, fiveHourUsedPercent: null, apiKeyVerified: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readClaudeProfileUsage("keyed", { configRoot: root, fetchImpl, now: () => now }))
      .resolves.toMatchObject({ status: "API_KEY", weeklyUsedPercent: null, apiKeyVerified: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(init.headers).toMatchObject({ "x-api-key": "sk-ant-api-fixture" });
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("ignores a symlinked credential file", async () => {
    const root = await profileRoot();
    const real = await writeProfile(root, "real");
    const dir = join(root, "profiles", "linked");
    await mkdir(dir, { recursive: true });
    await symlink(join(real, ".credentials.json"), join(dir, ".credentials.json"));
    const fetchImpl = usageFetch(200, teamUsage);
    await expect(readClaudeProfileUsage("linked", { configRoot: root, fetchImpl, now: () => now }))
      .resolves.toMatchObject({ status: "NOT_CONNECTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a lapsed token that Claude renews on its next request as idle, not expired", async () => {
    const root = await profileRoot();
    await writeProfile(root, "ops", { expiresAt: now.getTime() + 30_000, email: "ops@example.com" });
    const fetchImpl = usageFetch(200, teamUsage);
    await expect(readClaudeProfileUsage("ops", { configRoot: root, fetchImpl, now: () => now }))
      .resolves.toMatchObject({ status: "IDLE", email: "ops@example.com", plan: "Team · Max 5x", fiveHourUsedPercent: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an expired sign-in without a refresh token and never sends the stale token", async () => {
    const root = await profileRoot();
    await writeProfile(root, "ops", { expiresAt: now.getTime() + 30_000, refreshToken: false });
    const fetchImpl = usageFetch(200, teamUsage);
    await expect(readClaudeProfileUsage("ops", { configRoot: root, fetchImpl, now: () => now }))
      .resolves.toMatchObject({ status: "EXPIRED", plan: "Team · Max 5x", fiveHourUsedPercent: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("finds the installation API key for the api and main accounts only, and checks it with the free model list", async () => {
    const root = await profileRoot();
    const installationKeyFile = join(root, "space-claude.key");
    await writeFile(installationKeyFile, "sk-ant-api-fixture\n");
    await writeProfile(root, "api", { credentials: false });
    await writeProfile(root, "crew", { credentials: false });
    const checks: { url: string; headers: Record<string, string> }[] = [];
    let keyStatus = 200;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      checks.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ data: [] }), { status: keyStatus, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const read = (profileId: string, keyFile = installationKeyFile) =>
      readClaudeProfileUsage(profileId, { configRoot: root, installationKeyFile: keyFile, fetchImpl, now: () => now });
    await expect(read("api")).resolves.toMatchObject({ status: "API_KEY", apiKeyVerified: true });
    await expect(read("main")).resolves.toMatchObject({ status: "API_KEY", apiKeyVerified: true });
    await expect(read("crew")).resolves.toMatchObject({ status: "NOT_CONNECTED", apiKeyVerified: null });
    await expect(read("api", join(root, "missing.key"))).resolves.toMatchObject({ status: "NOT_CONNECTED" });
    // The API account bills its key even when a subscription login is stored next to it.
    await writeProfile(root, "api");
    await expect(read("api")).resolves.toMatchObject({ status: "API_KEY", apiKeyVerified: true });
    // The key only ever goes to Anthropic's free model list, as x-api-key, never as a bearer token or to the usage endpoint.
    expect(checks).toHaveLength(3);
    for (const check of checks) {
      expect(check.url).toBe("https://api.anthropic.com/v1/models?limit=1");
      expect(check.headers).toMatchObject({ "x-api-key": "sk-ant-api-fixture", "anthropic-version": "2023-06-01" });
      expect(check.headers.authorization).toBeUndefined();
    }
    keyStatus = 401;
    await expect(read("api")).resolves.toMatchObject({ status: "API_KEY", apiKeyVerified: false });
    keyStatus = 500;
    await expect(read("api")).resolves.toMatchObject({ status: "API_KEY", apiKeyVerified: null });
  });

  it("reports the Space Gateway account as ready only with a private gateway key", async () => {
    const root = await profileRoot();
    const gatewayKeyFile = join(root, "claude-code.key");
    const fetchImpl = usageFetch(200, teamUsage);
    const read = () => readClaudeProfileUsage("space-gateway", { configRoot: root, gatewayKeyFile, fetchImpl, now: () => now });
    await expect(read()).resolves.toMatchObject({ status: "NOT_CONNECTED" });
    await writeFile(gatewayKeyFile, "sk-sgw-fixture\n", { mode: 0o600 });
    await chmod(gatewayKeyFile, 0o600);
    await expect(read()).resolves.toMatchObject({ status: "GATEWAY", fiveHourUsedPercent: null });
    await chmod(gatewayKeyFile, 0o644);
    await expect(read()).resolves.toMatchObject({ status: "NOT_CONNECTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps rejected and failed usage requests to statuses", async () => {
    const root = await profileRoot();
    await writeProfile(root, "lab");
    const read = (fetchImpl: typeof fetch) => readClaudeProfileUsage("lab", { configRoot: root, fetchImpl, now: () => now });
    await expect(read(usageFetch(401, {}))).resolves.toMatchObject({ status: "EXPIRED" });
    await expect(read(usageFetch(429, {}))).resolves.toMatchObject({ status: "ERROR" });
    await expect(read(vi.fn(async () => { throw new Error("offline"); }))).resolves.toMatchObject({ status: "ERROR" });
  });

  it("rejects profile ids that could leave the profiles directory", async () => {
    for (const profileId of ["../main", "Lab", "", "a/b"]) {
      await expect(readClaudeProfileUsage(profileId, { configRoot: "/nonexistent" })).rejects.toThrow("Invalid Claude account profile.");
    }
  });
});

describe("Claude usage account provider", () => {
  const profiles = [
    { profileId: "main", displayName: "ntheo" },
    { profileId: "api", displayName: "api" }
  ];

  it("lists every configured profile with remaining percentages", async () => {
    const readUsage = vi.fn(async (profileId: string) => profileId === "main"
      ? {
          status: "CONNECTED" as const,
          email: "main@example.com",
          plan: "Team · Max 5x",
          fiveHourUsedPercent: 67,
          fiveHourResetAt: "2026-10-11T04:49:59.732Z",
          weeklyUsedPercent: 12.5,
          weeklyResetAt: "2026-10-16T02:00:00.000Z",
          weeklyScope: "Opus"
        }
      : {
          status: "NOT_CONNECTED" as const,
          email: null,
          plan: null,
          fiveHourUsedPercent: null,
          fiveHourResetAt: null,
          weeklyUsedPercent: null,
          weeklyResetAt: null,
          weeklyScope: null
        });
    const provider = createClaudeUsageAccountProvider({ listProfiles: async () => profiles, readUsage, now: () => now });
    const list = await provider();
    expect(list).toMatchObject({ source: "space-claude-profiles", isStale: false, error: null, pagination: { totalItems: 2 } });
    expect(list.data).toEqual([
      {
        id: "main",
        label: "ntheo",
        email: "main@example.com",
        plan: "Team · Max 5x",
        status: "CONNECTED",
        fiveHourRemainingPercent: 33,
        fiveHourResetAt: "2026-10-11T04:49:59.732Z",
        weeklyRemainingPercent: 87.5,
        weeklyResetAt: "2026-10-16T02:00:00.000Z",
        weeklyScope: "Opus",
        sampledAt: now.toISOString()
      },
      expect.objectContaining({ id: "api", status: "NOT_CONNECTED", fiveHourRemainingPercent: null, weeklyRemainingPercent: null })
    ]);
    await provider();
    expect(readUsage).toHaveBeenCalledTimes(2);
  });

  it("shows an idle account as signed in with its last sample, counting lapsed windows as full", async () => {
    let clock = now.getTime();
    let status: "CONNECTED" | "IDLE" = "CONNECTED";
    const readUsage = vi.fn(async (profileId: string) => {
      const connected = profileId === "lab" && status === "CONNECTED";
      return {
        status: profileId === "lab" ? status : "IDLE" as const,
        email: `${profileId}@example.com`,
        plan: "Team · Max 5x",
        fiveHourUsedPercent: connected ? 67 : null,
        fiveHourResetAt: connected ? "2026-10-11T04:49:59.732Z" : null,
        weeklyUsedPercent: connected ? 12 : null,
        weeklyResetAt: connected ? "2026-10-16T02:00:00.000Z" : null,
        weeklyScope: connected ? "Opus" : null
      };
    });
    const provider = createClaudeUsageAccountProvider({
      listProfiles: async () => [{ profileId: "lab", displayName: "lab" }, { profileId: "dev", displayName: "dev" }],
      readUsage,
      now: () => new Date(clock)
    });
    const first = await provider();
    // Never sampled while signed in: still signed in, just without quota data.
    expect(first.data[1]).toMatchObject({ id: "dev", status: "CONNECTED", fiveHourRemainingPercent: null, weeklyRemainingPercent: null, sampledAt: null });
    status = "IDLE";
    clock = Date.parse("2026-10-11T06:00:00.000Z");
    const idle = await afterRefresh(provider);
    expect(idle.data[0]).toEqual({
      id: "lab",
      label: "lab",
      email: "lab@example.com",
      plan: "Team · Max 5x",
      status: "CONNECTED",
      fiveHourRemainingPercent: 100,
      fiveHourResetAt: null,
      weeklyRemainingPercent: 88,
      weeklyResetAt: "2026-10-16T02:00:00.000Z",
      weeklyScope: "Opus",
      sampledAt: now.toISOString()
    });
  });

  it("passes the Space Gateway account through", async () => {
    const provider = createClaudeUsageAccountProvider({
      listProfiles: async () => [{ profileId: "space-gateway", displayName: "Space Gateway (pooled Claude)" }],
      readUsage: async () => ({
        status: "GATEWAY" as const, email: null, plan: null, fiveHourUsedPercent: null, fiveHourResetAt: null,
        weeklyUsedPercent: null, weeklyResetAt: null, weeklyScope: null
      }),
      now: () => now
    });
    expect((await provider()).data[0]).toMatchObject({ id: "space-gateway", status: "GATEWAY", sampledAt: now.toISOString() });
  });

  const window = (usedPercent: number | null, resetAt: string | null) => ({ usedPercent, resetAt, windowMinutes: 300 });
  const record = (label: string, patch: Partial<GatewayAccountRecord>): GatewayAccountRecord => ({
    id: `gw_account:${label}`, provider: "CLAUDE", label: `${label}@spaceapp.dev`, alias: null, email: `${label}@spaceapp.dev`, planType: "max5x",
    status: "ACTIVE", statusReason: null, priority: 100, warmupEnabled: false, resetCreditsAvailable: null,
    primaryWindow: window(null, null), secondaryWindow: window(null, null), lastRefreshAt: null, lastUsedAt: null, createdAt: now.toISOString(),
    externalAccountId: null, credentialsEncrypted: "x", credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, blockedUntil: null, ...patch
  });
  const idle = (email: string | null) => ({
    status: "IDLE" as const, email, plan: "Team · Max 5x", fiveHourUsedPercent: null, fiveHourResetAt: null,
    weeklyUsedPercent: null, weeklyResetAt: null, weeklyScope: null
  });

  it("attaches the gateway's Claude pool to the gateway profile only, read once", async () => {
    const gatewayAccounts = vi.fn(async () => [record("crew", {
      status: "RATE_LIMITED", blockedUntil: "2026-10-11T03:30:00.000Z",
      primaryWindow: window(100, "2026-10-11T03:30:00.000Z"), secondaryWindow: window(29, "2026-10-16T02:00:00.000Z")
    })]);
    const provider = createClaudeUsageAccountProvider({
      listProfiles: async () => [...profiles.slice(0, 1), { profileId: "space-gateway", displayName: "Space Gateway (pooled)" }],
      readUsage: async (profileId) => profileId === "space-gateway"
        ? { status: "GATEWAY" as const, email: null, plan: null, fiveHourUsedPercent: null, fiveHourResetAt: null, weeklyUsedPercent: null, weeklyResetAt: null, weeklyScope: null }
        : { status: "CONNECTED" as const, email: "main@example.test", plan: "Team", fiveHourUsedPercent: 36, fiveHourResetAt: null, weeklyUsedPercent: 17, weeklyResetAt: null, weeklyScope: null },
      gatewayAccounts,
      now: () => now
    });
    const list = await provider();
    expect(list.data[0]).not.toHaveProperty("pool");
    expect(list.data[1]).toMatchObject({ id: "space-gateway", status: "GATEWAY", pool: [{
      label: "crew", signInRequired: false, fiveHourRemainingPercent: 0, fiveHourResetAt: "2026-10-11T03:30:00.000Z",
      weeklyRemainingPercent: 71, weeklyResetAt: "2026-10-16T02:00:00.000Z"
    }] });
    expect(gatewayAccounts).toHaveBeenCalledTimes(1);
  });

  it("keeps the gateway profile without a pool when the gateway cannot be read", async () => {
    const provider = createClaudeUsageAccountProvider({
      listProfiles: async () => [{ profileId: "space-gateway", displayName: "Space Gateway (pooled)" }],
      readUsage: async () => ({ status: "GATEWAY" as const, email: null, plan: null, fiveHourUsedPercent: null, fiveHourResetAt: null,
        weeklyUsedPercent: null, weeklyResetAt: null, weeklyScope: null }),
      gatewayAccounts: async () => { throw new Error("gateway database unavailable"); },
      now: () => now
    });
    expect((await provider()).data[0]).not.toHaveProperty("pool");
  });

  it("reads the gateway pool as the gateway holds it", () => {
    const pool = claudeGatewayPool([
      // At 100% of the 5-hour window (seen live 2026-10-12): back at the window's reset.
      record("crew", { status: "RATE_LIMITED", blockedUntil: "2026-10-11T03:30:00.000Z",
        primaryWindow: window(100, "2026-10-11T03:30:00.000Z"), secondaryWindow: window(29, "2026-10-16T02:00:00.000Z") }),
      // Blocked by a short rate limit while its sample still shows room: held back until the gateway releases it.
      record("dev", { status: "RATE_LIMITED", blockedUntil: "2026-10-11T01:05:00.000Z", primaryWindow: window(40, "2026-10-11T04:00:00.000Z") }),
      // A window whose reset has passed is full again.
      record("lab", { primaryWindow: window(100, "2026-10-11T00:50:00.000Z"), alias: "Lab" }),
      record("ops", { status: "REAUTH_REQUIRED" }),
      record("old", { status: "DEACTIVATED" }),
      record("paused", { status: "PAUSED" }),
      { ...record("codex", {}), provider: "CODEX" }
    ], now.getTime());
    expect(pool).toEqual([
      { label: "crew", signInRequired: false, fiveHourRemainingPercent: 0, fiveHourResetAt: "2026-10-11T03:30:00.000Z",
        weeklyRemainingPercent: 71, weeklyResetAt: "2026-10-16T02:00:00.000Z" },
      { label: "dev", signInRequired: false, fiveHourRemainingPercent: 0, fiveHourResetAt: "2026-10-11T01:05:00.000Z",
        weeklyRemainingPercent: null, weeklyResetAt: null },
      { label: "Lab", signInRequired: false, fiveHourRemainingPercent: 100, fiveHourResetAt: null, weeklyRemainingPercent: null, weeklyResetAt: null },
      { label: "ops", signInRequired: true, fiveHourRemainingPercent: null, fiveHourResetAt: null, weeklyRemainingPercent: null, weeklyResetAt: null }
    ]);
  });

  // Seen live 2026-10-13: crew, dev, lab and ops showed "No data" although the gateway, signed in to the same
  // accounts, had sampled their usage minutes earlier.
  it("shows an idle profile with the gateway's sample of the account it is signed in to", async () => {
    const gatewayAccounts = vi.fn(async () => [
      record("crew", { primaryWindow: window(27, "2026-10-11T02:33:00.000Z"), secondaryWindow: window(29, "2026-10-16T02:00:00.000Z") }),
      // Only the weekly window sampled; the profile's own email differs in case.
      record("dev", { email: "Dev@SpaceApp.dev", secondaryWindow: window(60, "2026-10-16T02:00:00.000Z") }),
      // Rate limited by the gateway while its sample still shows room: out until the gateway releases it.
      record("lab", { status: "RATE_LIMITED", blockedUntil: "2026-10-11T01:05:00.000Z", primaryWindow: window(40, "2026-10-11T04:00:00.000Z") }),
      record("ops", { status: "REAUTH_REQUIRED" }),
      record("paused", { status: "PAUSED", primaryWindow: window(10, "2026-10-11T04:00:00.000Z") })
    ]);
    const provider = createClaudeUsageAccountProvider({
      listProfiles: async () => ["crew", "dev", "lab", "ops", "paused", "solo", "anon"].map((profileId) => ({ profileId, displayName: profileId })),
      readUsage: async (profileId) => idle(profileId === "anon" ? null : `${profileId}@spaceapp.dev`),
      gatewayAccounts,
      now: () => now
    });
    const list = await provider();
    expect(list.data.map((account) => [account.id, account.status, account.fiveHourRemainingPercent, account.fiveHourResetAt,
      account.weeklyRemainingPercent, account.weeklyResetAt, account.weeklyScope, account.sampledAt])).toEqual([
      ["crew", "CONNECTED", 73, "2026-10-11T02:33:00.000Z", 71, "2026-10-16T02:00:00.000Z", null, now.toISOString()],
      ["dev", "CONNECTED", null, null, 40, "2026-10-16T02:00:00.000Z", null, now.toISOString()],
      ["lab", "CONNECTED", 0, "2026-10-11T01:05:00.000Z", null, null, null, now.toISOString()],
      // The gateway must sign in to ops again and no longer samples the paused account: nothing current to show.
      ["ops", "CONNECTED", null, null, null, null, null, null],
      ["paused", "CONNECTED", null, null, null, null, null, null],
      ["solo", "CONNECTED", null, null, null, null, null, null],
      ["anon", "CONNECTED", null, null, null, null, null, null]
    ]);
    expect(list.data[0]).toMatchObject({ email: "crew@spaceapp.dev", plan: "Team · Max 5x" });
    expect(gatewayAccounts).toHaveBeenCalledTimes(1);
    expect(list.data.some((account) => "pool" in account)).toBe(false);
  });

  it("reports whether the api profile's key works and whether Space Gateway falls back to a Claude API key", async () => {
    const keyAccount = record("key", { email: null, label: "Claude API key …kkkk", planType: "api", source: "API_KEY" });
    const readUsage = async () => ({ ...idle(null), status: "API_KEY" as const, plan: null, apiKeyVerified: true });
    const make = (accounts: GatewayAccountRecord[], claudeApiKeyFallback: boolean) => createClaudeUsageAccountProvider({
      listProfiles: async () => [{ profileId: "api", displayName: "api" }, { profileId: "space-gateway", displayName: "Space Gateway (pooled)" }],
      readUsage: async (profileId) => profileId === "api" ? readUsage() : { ...idle(null), status: "GATEWAY" as const, plan: null },
      gatewayAccounts: async () => accounts, gatewaySettings: async () => ({ claudeApiKeyFallback }), now: () => now
    });
    const on = await make([record("crew", { primaryWindow: window(20, "2026-10-11T04:00:00.000Z") }), keyAccount], true)();
    expect(on.data[0]).toMatchObject({ id: "api", status: "API_KEY", apiKeyVerified: true, gatewayFallback: "ON" });
    expect(on.data[0]).not.toHaveProperty("apiKeyUsage");
    // The key is not a quota account: the gateway profile's pool lists the subscription accounts only.
    expect(on.data[1]!.pool!.map((member) => member.label)).toEqual(["crew"]);
    expect((await make([record("crew", {}), keyAccount], false)()).data[0]).toMatchObject({ gatewayFallback: "OFF" });
    expect((await make([record("crew", {}), { ...keyAccount, status: "PAUSED" }], true)()).data[0]).toMatchObject({ gatewayFallback: "NOT_ADDED" });
    expect((await make([record("crew", {})], true)()).data[0]).toMatchObject({ gatewayFallback: "NOT_ADDED" });
    const unreadable = createClaudeUsageAccountProvider({ listProfiles: async () => [{ profileId: "api", displayName: "api" }], readUsage,
      gatewayAccounts: async () => { throw new Error("down"); }, gatewaySettings: async () => { throw new Error("down"); }, now: () => now });
    const card = (await unreadable()).data[0]!;
    expect(card).toMatchObject({ status: "API_KEY", apiKeyVerified: true });
    expect(card).not.toHaveProperty("gatewayFallback");
  });

  it("tells what Space Gateway sent through the key: nothing, or how much and when", async () => {
    const keyAccount = record("key", { email: null, label: "Claude API key …kkkk", planType: "api", source: "API_KEY", lastUsedAt: "2026-10-11T00:40:00.000Z" });
    const lastRequest = { at: "2026-10-11T00:59:00.000Z", succeeded: true };
    const gatewayAccountUsage = vi.fn(async (accountId: string) => ({ requests: accountId === keyAccount.id ? 3 : 99, costUsd: 0.4321, lastRequest }));
    const provider = createClaudeUsageAccountProvider({
      listProfiles: async () => [{ profileId: "api", displayName: "api" }, { profileId: "crew", displayName: "crew" }],
      readUsage: async (profileId) => profileId === "api" ? { ...idle(null), status: "API_KEY" as const, plan: null, apiKeyVerified: true } : idle("crew@spaceapp.dev"),
      gatewayAccounts: async () => [record("crew", { primaryWindow: window(20, "2026-10-11T04:00:00.000Z") }), keyAccount],
      gatewaySettings: async () => ({ claudeApiKeyFallback: true }), gatewayAccountUsage, now: () => now
    });
    const list = await provider();
    expect(list.data[0]).toMatchObject({ id: "api", apiKeyUsage: { requests: 3, costUsd: 0.4321, lastUsedAt: "2026-10-11T00:40:00.000Z", lastRequest } });
    // Only the key account's totals are read, once, and only for the API-key profile.
    expect(gatewayAccountUsage).toHaveBeenCalledTimes(1);
    expect(gatewayAccountUsage).toHaveBeenCalledWith(keyAccount.id);
    expect(list.data[1]).not.toHaveProperty("apiKeyUsage");
    const unused = createClaudeUsageAccountProvider({
      listProfiles: async () => [{ profileId: "api", displayName: "api" }],
      readUsage: async () => ({ ...idle(null), status: "API_KEY" as const, plan: null, apiKeyVerified: true }),
      gatewayAccounts: async () => [{ ...keyAccount, lastUsedAt: null }], gatewaySettings: async () => ({ claudeApiKeyFallback: false }),
      gatewayAccountUsage: async () => ({ requests: 0, costUsd: 0 }), now: () => now
    });
    expect((await unused()).data[0]).toMatchObject({ gatewayFallback: "OFF", apiKeyUsage: { requests: 0, costUsd: 0, lastUsedAt: null } });
  });

  it.each(["success", "error", "missing", "unavailable"])("reads the latest completed API request with outcome %s", async (status) => {
    const at = "2026-10-11T00:59:00.000Z";
    const repository = {
      usageTotals: vi.fn(async () => ({ requests: 3, costUsd: 0.4321, inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 })),
      listRequestLogs: vi.fn(async () => {
        if (status === "unavailable") throw new Error("logs unavailable");
        return status === "missing" ? [] : [{ requestedAt: at, status } as GatewayRequestLog];
      })
    };
    expect(await claudeGatewayApiKeyUsage(repository, "key", now.getTime())).toMatchObject({
      requests: 3, costUsd: 0.4321,
      lastRequest: status === "missing" || status === "unavailable" ? null : { at, succeeded: status === "success" }
    });
    expect(repository.listRequestLogs).toHaveBeenCalledWith({ limit: 1, accountId: "key", filter: { from: "2026-10-11T00:55:00.000Z" } });
  });

  it("gives the api profile this month's Anthropic bill and the monthly budget set in Space Gateway", async () => {
    const keyAccount = record("key", { email: null, label: "Claude API key …kkkk", planType: "api", source: "API_KEY" });
    const make = (anthropicMonthlyBudgetUsd: number | null, spent: number | null) => createClaudeUsageAccountProvider({
      listProfiles: async () => [{ profileId: "api", displayName: "api" }, { profileId: "crew", displayName: "crew" }],
      readUsage: async (profileId) => profileId === "api" ? { ...idle(null), status: "API_KEY" as const, plan: null, apiKeyVerified: true } : idle("crew@spaceapp.dev"),
      gatewayAccounts: async () => [keyAccount], gatewaySettings: async () => ({ claudeApiKeyFallback: true, anthropicMonthlyBudgetUsd }),
      anthropicMonthUsd: async () => spent, now: () => now
    });
    const list = await make(500, 42.5)();
    expect(list.data[0]).toMatchObject({ id: "api", apiKeyMonth: { spentUsd: 42.5, budgetUsd: 500 } });
    expect(list.data[1]).not.toHaveProperty("apiKeyMonth");
    expect((await make(null, 7)()).data[0]).toMatchObject({ apiKeyMonth: { spentUsd: 7, budgetUsd: null } });
    expect((await make(null, null)()).data[0]).not.toHaveProperty("apiKeyMonth");
  });

  it("sums this UTC month's bill: Anthropic's posted days, the gateway's estimate for days not posted yet", () => {
    const day = (date: string, reported: boolean, organizationUsd: number, gatewayEstimateUsd: number) =>
      ({ day: date, reported, organizationUsd, workspaceUsd: 0, gatewayEstimateUsd, gatewayBilledUsd: 0, models: [] });
    const status = { configured: true, keyHint: "…abcd", savedAt: null, lastSyncAt: null, lastError: null, upstream: [] };
    const report = { status, days: [day("2026-10-11", false, 0, 3), day("2026-10-10", true, 20, 9), day("2026-09-30", true, 100, 0)] };
    expect(anthropicMonthSpendUsd(report, now.getTime())).toBe(23);
    expect(anthropicMonthSpendUsd({ status: { ...status, configured: false }, days: [] }, now.getTime())).toBeNull();
  });

  it("answers an old sample at once and collects a fresh one in the background", async () => {
    let clock = now.getTime();
    let release: (() => void) | null = null;
    let fiveHourUsedPercent = 10;
    const readUsage = vi.fn(async () => {
      if (clock !== now.getTime()) await new Promise<void>((resolve) => { release = resolve; });
      return { ...idle("crew@spaceapp.dev"), status: "CONNECTED" as const, fiveHourUsedPercent, fiveHourResetAt: "2026-10-11T04:00:00.000Z" };
    });
    const provider = createClaudeUsageAccountProvider({ listProfiles: async () => [{ profileId: "crew", displayName: "crew" }], readUsage, now: () => new Date(clock) });
    expect((await provider()).data[0]).toMatchObject({ fiveHourRemainingPercent: 90 });
    clock += 30 * 60_000;
    fiveHourUsedPercent = 40;
    // The wrapper now hangs; the menu still gets the last sample without waiting for it.
    expect((await provider()).data[0]).toMatchObject({ fiveHourRemainingPercent: 90 });
    expect(readUsage).toHaveBeenCalledTimes(2);
    release!();
    await vi.waitFor(async () => expect((await provider()).data[0]).toMatchObject({ fiveHourRemainingPercent: 60 }));
  });

  it("prefers the gateway's current sample over an idle profile's own older one", async () => {
    let clock = now.getTime();
    let status: "CONNECTED" | "IDLE" = "CONNECTED";
    const gatewayAccounts = vi.fn(async () => [record("lab", {
      primaryWindow: window(80, "2026-10-11T04:49:59.732Z"), secondaryWindow: window(20, "2026-10-16T02:00:00.000Z")
    })]);
    const provider = createClaudeUsageAccountProvider({
      listProfiles: async () => [{ profileId: "lab", displayName: "lab" }],
      readUsage: async () => status === "CONNECTED"
        ? { ...idle("lab@spaceapp.dev"), status: "CONNECTED" as const, fiveHourUsedPercent: 67, fiveHourResetAt: "2026-10-11T04:49:59.732Z",
            weeklyUsedPercent: 12, weeklyResetAt: "2026-10-16T02:00:00.000Z", weeklyScope: "Opus" }
        : idle("lab@spaceapp.dev"),
      gatewayAccounts,
      now: () => new Date(clock)
    });
    // Signed in with a live token: the profile's own reading, and the gateway is not consulted.
    expect((await provider()).data[0]).toMatchObject({ fiveHourRemainingPercent: 33, weeklyRemainingPercent: 88, weeklyScope: "Opus", sampledAt: now.toISOString() });
    expect(gatewayAccounts).not.toHaveBeenCalled();
    status = "IDLE";
    clock = Date.parse("2026-10-11T01:11:00.000Z");
    expect((await afterRefresh(provider)).data[0]).toMatchObject({
      status: "CONNECTED", fiveHourRemainingPercent: 20, fiveHourResetAt: "2026-10-11T04:49:59.732Z", weeklyRemainingPercent: 80,
      weeklyScope: null, sampledAt: "2026-10-11T01:11:00.000Z"
    });
    expect(gatewayAccounts).toHaveBeenCalledTimes(1);
  });

  it("marks a profile unavailable when the wrapper output is invalid", async () => {
    const provider = createClaudeUsageAccountProvider({
      listProfiles: async () => profiles.slice(0, 1),
      readUsage: async () => ({ status: "CONNECTED", accessToken } as never),
      now: () => now
    });
    const list = await provider();
    expect(list.data[0]).toMatchObject({ id: "main", status: "ERROR", email: null });
    expect(JSON.stringify(list)).not.toContain("sk-ant");
  });

  it("keeps a recent sample and reports stale data once it is too old to serve", async () => {
    let clock = now.getTime();
    let fail = false;
    const provider = createClaudeUsageAccountProvider({
      listProfiles: async () => {
        if (fail) throw new Error("database unavailable");
        return profiles.slice(1);
      },
      readUsage: async () => { throw new Error("wrapper failed"); },
      now: () => new Date(clock)
    });
    expect((await provider()).data).toHaveLength(1);
    fail = true;
    clock += 3 * 60_000;
    expect(await afterRefresh(provider)).toMatchObject({ isStale: false, data: [expect.objectContaining({ id: "api", status: "ERROR" })] });
    clock += 8 * 60_000;
    const stale = await provider();
    expect(stale).toMatchObject({ isStale: true, data: [], error: "Claude usage data is temporarily unavailable." });
  });
});
