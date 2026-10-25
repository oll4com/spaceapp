import { describe, expect, it, vi } from "vitest";
import type { CodexLbSpeedDefaultsResponse } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const sessionSecret = "toolbar-actions-test-secret";
const sampledAt = "2026-07-14T12:00:00.000Z";

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession({ id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role }, sessionSecret);
  return {
    cookie: `space_session=${session}`,
    csrf: createCsrfToken(session, sessionSecret)!
  };
}

const usage = {
  data: [{
    id: "account:one",
    label: "one@example.test",
    fiveHourRemainingPercent: 70,
    weeklyRemainingPercent: 60,
    weeklyResetAt: "2026-07-20T09:30:00.000Z",
    sampledAt
  }],
  pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
  source: "codex-usage-host",
  isStale: false,
  error: null,
  checkedAt: sampledAt
} as const;

const antigravityUsage = {
  data: [{
    id: "in1",
    label: "Indgmopai 1",
    email: "indgmopai1@gmail.com",
    tier: "Google AI Pro",
    status: "CONNECTED" as const,
    gemini: {
      displayName: "Gemini Models",
      description: null,
      fiveHourRemainingPercent: 99.8,
      fiveHourResetAt: "2026-07-14T15:00:00.000Z",
      weeklyRemainingPercent: 99.9,
      weeklyResetAt: "2026-07-20T09:30:00.000Z"
    },
    claude: {
      displayName: "Claude and GPT models",
      description: null,
      fiveHourRemainingPercent: 100,
      fiveHourResetAt: "2026-07-14T15:00:00.000Z",
      weeklyRemainingPercent: 100,
      weeklyResetAt: "2026-07-20T09:30:00.000Z"
    },
    sampledAt
  }],
  pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
  source: "space-gemini-profiles",
  isStale: false,
  error: null,
  checkedAt: sampledAt
};

const cliStats = {
  summary: { running: 2, attached: 1, detached: 1, cleanupEligible: 1 },
  sessions: [
    {
      sessionId: "cli_session:eligible",
      hostId: "main" as const,
      runtimeId: "cli:codex",
      roomId: "room:one",
      paneId: "pane:one",
      pid: 101,
      status: "RUNNING" as const,
      attachmentCount: 0,
      startedAt: "2026-07-14T11:00:00.000Z",
      detachedAt: "2026-07-14T11:50:00.000Z",
      rssBytes: 64 * 1024 * 1024,
      cleanupEligible: true
    },
    {
      sessionId: "cli_session:attached",
      hostId: "root" as const,
      runtimeId: "cli:root",
      roomId: "room:root",
      paneId: "pane:root",
      pid: 202,
      status: "RUNNING" as const,
      attachmentCount: 1,
      startedAt: "2026-07-14T11:00:00.000Z",
      detachedAt: null,
      rssBytes: 32 * 1024 * 1024,
      cleanupEligible: false
    }
  ],
  sampledAt
};

const memory = {
  memory: {
    totalBytes: 1024 * 1024 * 1024,
    usedBytes: 896 * 1024 * 1024,
    availableBytes: 128 * 1024 * 1024,
    usagePercent: 87.5,
    pageCacheBytes: 320 * 1024 * 1024,
    reclaimableBytes: 320 * 1024 * 1024
  },
  swap: { totalBytes: 256 * 1024 * 1024, usedBytes: 64 * 1024 * 1024, usagePercent: 25 },
  pressure: { isUnderPressure: true, availablePercent: 12.5, canDropPageCache: true },
  topProcesses: [],
  topCpuProcesses: [],
  sampledAt
};

const speedDefaults: CodexLbSpeedDefaultsResponse = {
  models: [
    { modelId: "gpt-5.5", displayName: "GPT-5.5", tier: "STANDARD" },
    { modelId: "gpt-5.4", displayName: "GPT-5.4", tier: "FAST" }
  ],
  updatedAt: sampledAt,
  checkedAt: sampledAt
};

function verifyProviders(store: InMemorySpaceStore) {
  for (const [providerId, routeProfile, displayName] of [
    ["headroom-gateway", "headroom", "Headroom Gateway"],
    ["direct-246-primary", "direct-primary", "Direct .246 Primary"],
    ["direct-auto-failover", "direct-auto", "Direct Auto Failover"]
  ] as const) {
    if (!store.listProviders().some((provider) => provider.id === providerId)) {
      store.createProvider({
        id: providerId,
        displayName,
        type: "CODEX_LB",
        routeProfile,
        backingProviderId: "codex-lb"
      });
    }
  }
  for (const providerId of ["headroom-gateway", "direct-246-primary"]) {
    store.recordProviderValidation({
      providerId,
      status: "VERIFIED",
      code: "VERIFIED",
      statusReason: "Verified by test.",
      checkedAt: sampledAt,
      maskedKeyPrefix: "spac...test",
      credentialLabel: "space-test",
      modelCount: 1
    });
  }
  store.updateProviderSettings({ defaultProviderId: "headroom-gateway" });
}

async function setup(overrides: CreateAppOptions = {}) {
  const store = (overrides.store as InMemorySpaceStore | undefined) ?? new InMemorySpaceStore();
  verifyProviders(store);
  const cliReaper = overrides.toolbarCliSessionReaper ?? vi.fn(async () => ({
    killedSessions: [{ hostId: "main" as const, cliSessionId: "cli_session:eligible" }],
    skippedCount: 1,
    failedHostCount: 0
  }));
  const cliTerminator = overrides.toolbarCliSessionTerminator ?? vi.fn(async () => true);
  const kernelReclaimer = overrides.toolbarKernelCacheReclaimer ?? vi.fn(async () => ({
    status: "CLEARED" as const,
    reclaimedBytes: 48 * 1024 * 1024,
    message: null
  }));
  const speedDefaultUpdater = overrides.codexLbSpeedDefaultUpdater ?? vi.fn(async (modelId: "gpt-5.5" | "gpt-5.4", tier: "STANDARD" | "FAST") => ({
    ...speedDefaults,
    models: speedDefaults.models.map((model) => model.modelId === modelId ? { ...model, tier } : model) as CodexLbSpeedDefaultsResponse["models"]
  }));
  const app = await createApp({
    ...overrides,
    store,
    config: overrides.config ?? getApiConfig({}),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    antigravityUsageProvider: overrides.antigravityUsageProvider ?? (async () => antigravityUsage),
    toolbarUsageProvider: overrides.toolbarUsageProvider ?? (async () => usage),
    toolbarCliSessionStatsProvider: overrides.toolbarCliSessionStatsProvider ?? (async () => cliStats),
    toolbarHostMemoryProvider: overrides.toolbarHostMemoryProvider ?? (async () => memory),
    toolbarCliSessionReaper: cliReaper,
    toolbarCliSessionTerminator: cliTerminator,
    toolbarKernelCacheReclaimer: kernelReclaimer,
    codexLbSpeedDefaultsProvider: overrides.codexLbSpeedDefaultsProvider ?? (async () => speedDefaults),
    codexLbSpeedDefaultUpdater: speedDefaultUpdater
  });
  return { app, store, cliReaper, cliTerminator, kernelReclaimer, speedDefaultUpdater };
}

describe("toolbar system action API", () => {
  it("requires ADMIN for all telemetry while keeping payloads bounded", async () => {
    const { app } = await setup();
    const operator = authHeaders("OPERATOR");
    const admin = authHeaders("ADMIN");

    expect((await app.inject({ method: "GET", url: "/api/admin/codex-usage-accounts" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/antigravity-usage-accounts" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/api-provider-accounts" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/cli-sessions", headers: { cookie: operator.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/antigravity-usage-accounts", headers: { cookie: operator.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/api-provider-accounts", headers: { cookie: operator.cookie } })).statusCode).toBe(403);

    const [accounts, agAccounts, apiAccs, cli, hostMemory, providers] = await Promise.all([
      app.inject({ method: "GET", url: "/api/admin/codex-usage-accounts", headers: { cookie: admin.cookie } }),
      app.inject({ method: "GET", url: "/api/admin/antigravity-usage-accounts", headers: { cookie: admin.cookie } }),
      app.inject({ method: "GET", url: "/api/admin/api-provider-accounts", headers: { cookie: admin.cookie } }),
      app.inject({ method: "GET", url: "/api/admin/cli-sessions", headers: { cookie: admin.cookie } }),
      app.inject({ method: "GET", url: "/api/admin/host-memory", headers: { cookie: admin.cookie } }),
      app.inject({ method: "GET", url: "/api/admin/provider-switch-targets", headers: { cookie: admin.cookie } })
    ]);
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().data[0]).toMatchObject({ label: "one@example.test", weeklyRemainingPercent: 60 });
    expect(agAccounts.statusCode).toBe(200);
    expect(agAccounts.json().data[0]).toMatchObject({ email: "indgmopai1@gmail.com", gemini: expect.objectContaining({ weeklyRemainingPercent: 99.9 }) });
    expect(apiAccs.statusCode).toBe(200);
    expect(Array.isArray(apiAccs.json().data)).toBe(true);
    expect(cli.json().summary).toEqual(cliStats.summary);
    expect(hostMemory.json().pressure.canDropPageCache).toBe(true);
    // codex-lb is retired: Codex runs through Space Gateway and there is no route left to switch.
    expect(providers.json().data).toEqual([]);
    await app.close();
  });

  it("lists Claude plan usage for every configured profile through the wrapper reader", async () => {
    const store = new InMemorySpaceStore();
    await store.createCliAccountProfile("cli:claude", { runtimeId: "cli:claude", profileId: "main", displayName: "ntheo" }, "operator:test");
    await store.createCliAccountProfile("cli:claude", { runtimeId: "cli:claude", profileId: "ops", displayName: "ops" }, "operator:test");
    const readClaudeAccountProfileUsage = vi.fn(async (profileId: string) => ({
      status: profileId === "main" ? "CONNECTED" as const : "EXPIRED" as const,
      email: `${profileId}@example.test`,
      plan: "Team · Max 5x",
      fiveHourUsedPercent: profileId === "main" ? 67 : null,
      fiveHourResetAt: profileId === "main" ? "2026-07-14T15:00:00.000Z" : null,
      weeklyUsedPercent: profileId === "main" ? 3 : null,
      weeklyResetAt: profileId === "main" ? "2026-07-20T09:30:00.000Z" : null,
      weeklyScope: profileId === "main" ? "Fable" : null
    }));
    const { app } = await setup({ store, readClaudeAccountProfileUsage });
    const operator = authHeaders("OPERATOR");
    const admin = authHeaders("ADMIN");

    expect((await app.inject({ method: "GET", url: "/api/admin/claude-usage-accounts" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/claude-usage-accounts", headers: { cookie: operator.cookie } })).statusCode).toBe(403);
    expect(readClaudeAccountProfileUsage).not.toHaveBeenCalled();

    const response = await app.inject({ method: "GET", url: "/api/admin/claude-usage-accounts", headers: { cookie: admin.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ source: "space-claude-profiles", isStale: false, pagination: { totalItems: 2 } });
    expect(response.json().data).toEqual([
      expect.objectContaining({ id: "main", label: "ntheo", status: "CONNECTED", fiveHourRemainingPercent: 33, weeklyRemainingPercent: 97, weeklyScope: "Fable" }),
      expect.objectContaining({ id: "ops", label: "ops", status: "EXPIRED", fiveHourRemainingPercent: null })
    ]);
    expect(readClaudeAccountProfileUsage.mock.calls.map(([profileId]) => profileId).sort()).toEqual(["main", "ops"]);
    await app.close();
  });

  it("reaps only server-selected CLI sessions with ADMIN, CSRF, rate limiting, and audit", async () => {
    const { app, store, cliReaper } = await setup();
    const operator = authHeaders("OPERATOR");
    const admin = authHeaders("ADMIN");

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/cli-session-reaps",
      headers: { cookie: operator.cookie, "x-space-csrf-token": operator.csrf },
      payload: {}
    });
    expect(forbidden.statusCode).toBe(403);

    const forged = await app.inject({
      method: "POST",
      url: "/api/admin/cli-session-reaps",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { pids: [202], sessionIds: ["cli_session:attached"] }
    });
    expect(forged.statusCode).toBe(422);
    expect(cliReaper).not.toHaveBeenCalled();

    const reaped = await app.inject({
      method: "POST",
      url: "/api/admin/cli-session-reaps",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });
    expect(reaped.statusCode).toBe(200);
    expect(reaped.json()).toMatchObject({
      status: "COMPLETED",
      killedSessionIds: ["cli_session:eligible"],
      skippedCount: 1,
      estimatedReclaimedBytes: 64 * 1024 * 1024
    });
    expect(cliReaper).toHaveBeenCalledTimes(1);
    expect(store.listAuditEvents().map((event) => event.action)).toContain("admin.cli_sessions.reaped");
    await app.close();
  });

  it("requires CSRF for every destructive toolbar action", async () => {
    const { app, cliReaper, kernelReclaimer } = await setup();
    const admin = authHeaders("ADMIN");

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/admin/cli-session-reaps",
        headers: { cookie: admin.cookie },
        payload: {}
      }),
      app.inject({
        method: "POST",
        url: "/api/admin/memory-reclaims",
        headers: { cookie: admin.cookie },
        payload: {}
      }),
      app.inject({
        method: "POST",
        url: "/api/admin/provider-switches",
        headers: { cookie: admin.cookie },
        payload: { providerId: "direct-246-primary" }
      })
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403]);
    expect(cliReaper).not.toHaveBeenCalled();
    expect(kernelReclaimer).not.toHaveBeenCalled();
    await app.close();
  });

  it("stops detached CLIs of closed panes and invokes the no-argument kernel helper only under pressure", async () => {
    const { app, store, cliReaper, cliTerminator, kernelReclaimer } = await setup();
    const admin = authHeaders("ADMIN");
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/memory-reclaims",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "COMPLETED",
      cli: { killedSessionIds: ["cli_session:eligible"], estimatedReclaimedBytes: 64 * 1024 * 1024, protectedSessionCount: 0 },
      kernelCache: { status: "CLEARED", reclaimedBytes: 48 * 1024 * 1024 }
    });
    expect(cliTerminator).toHaveBeenCalledTimes(1);
    expect(cliTerminator).toHaveBeenCalledWith("cli_session:eligible");
    expect(cliReaper).not.toHaveBeenCalled();
    expect(kernelReclaimer).toHaveBeenCalledWith();
    expect(store.listAuditEvents().map((event) => event.action)).toContain("admin.memory.reclaimed");
    await app.close();
  });

  it("keeps detached CLIs of open panes running, including minimized panes in other rooms", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Background agents", initialPaneCount: 0 });
    const openPane = store.createPane({ roomId: room.id, title: "Long task", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
    store.updatePane(openPane.id, { isMinimized: true });
    const closedPane = store.createPane({ roomId: room.id, title: "Finished", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
    store.updatePane(closedPane.id, { isClosed: true, status: "CLOSED" });
    const detached = (sessionId: string, paneId: string) => ({ ...cliStats.sessions[0]!, sessionId, roomId: room.id, paneId });
    const stats = {
      ...cliStats,
      summary: { running: 2, attached: 0, detached: 2, cleanupEligible: 2 },
      sessions: [detached("cli_session:open-pane", openPane.id), detached("cli_session:closed-pane", closedPane.id)]
    };
    const { app, cliReaper, cliTerminator } = await setup({ store, toolbarCliSessionStatsProvider: async () => stats });
    const admin = authHeaders("ADMIN");
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/memory-reclaims",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().cli).toEqual({ killedSessionIds: ["cli_session:closed-pane"], estimatedReclaimedBytes: 64 * 1024 * 1024, protectedSessionCount: 1 });
    expect(cliTerminator).toHaveBeenCalledTimes(1);
    expect(cliTerminator).toHaveBeenCalledWith("cli_session:closed-pane");
    expect(cliReaper).not.toHaveBeenCalled();
    await app.close();
  });

  it("skips kernel cache clearing outside pressure without weakening CLI cleanup", async () => {
    const lowPressure = {
      ...memory,
      pressure: { isUnderPressure: false, availablePercent: 60, canDropPageCache: false }
    };
    const kernelReclaimer = vi.fn(async () => ({ status: "CLEARED" as const, reclaimedBytes: 1, message: null }));
    const { app, cliTerminator } = await setup({
      toolbarHostMemoryProvider: async () => lowPressure,
      toolbarKernelCacheReclaimer: kernelReclaimer
    });
    const admin = authHeaders("ADMIN");
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/memory-reclaims",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });
    expect(response.json().kernelCache.status).toBe("SKIPPED_LOW_PRESSURE");
    expect(cliTerminator).toHaveBeenCalledTimes(1);
    expect(kernelReclaimer).not.toHaveBeenCalled();
    await app.close();
  });

  it("skips kernel cache clearing when reclaimable page cache is below the safety floor", async () => {
    const smallCache = {
      ...memory,
      memory: {
        ...memory.memory,
        pageCacheBytes: 128 * 1024 * 1024,
        reclaimableBytes: 128 * 1024 * 1024
      }
    };
    const kernelReclaimer = vi.fn(async () => ({ status: "CLEARED" as const, reclaimedBytes: 1, message: null }));
    const { app, cliTerminator } = await setup({
      toolbarHostMemoryProvider: async () => smallCache,
      toolbarKernelCacheReclaimer: kernelReclaimer
    });
    const admin = authHeaders("ADMIN");
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/memory-reclaims",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().kernelCache.status).toBe("SKIPPED_SMALL_CACHE");
    expect(cliTerminator).toHaveBeenCalledTimes(1);
    expect(kernelReclaimer).not.toHaveBeenCalled();
    await app.close();
  });

  it("serializes CLI and memory cleanup behind one shared guard", async () => {
    let releaseReaper: ((value: {
      killedSessions: Array<{ hostId: "main"; cliSessionId: string }>;
      skippedCount: number;
      failedHostCount: number;
    }) => void) | undefined;
    const cliReaper = vi.fn(() => new Promise<{
      killedSessions: Array<{ hostId: "main"; cliSessionId: string }>;
      skippedCount: number;
      failedHostCount: number;
    }>((resolve) => {
      releaseReaper = resolve;
    }));
    const { app } = await setup({ toolbarCliSessionReaper: cliReaper });
    const admin = authHeaders("ADMIN");
    const first = app.inject({
      method: "POST",
      url: "/api/admin/cli-session-reaps",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });
    await vi.waitFor(() => expect(cliReaper).toHaveBeenCalledTimes(1));

    const concurrent = await app.inject({
      method: "POST",
      url: "/api/admin/memory-reclaims",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });
    expect(concurrent.statusCode).toBe(409);

    releaseReaper?.({ killedSessions: [], skippedCount: 0, failedHostCount: 0 });
    expect((await first).statusCode).toBe(200);
    await app.close();
  });

  it("rate limits repeated CLI cleanup actions", async () => {
    const { app, cliReaper } = await setup();
    const admin = authHeaders("ADMIN");
    const responses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      responses.push(await app.inject({
        method: "POST",
        url: "/api/admin/cli-session-reaps",
        headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
        payload: {}
      }));
    }

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 429]);
    expect(cliReaper).toHaveBeenCalledTimes(4);
    await app.close();
  });

  it("refuses a provider route switch: codex-lb is retired and Codex runs through Space Gateway", async () => {
    const { app, store } = await setup();
    const admin = authHeaders("ADMIN");
    const switched = await app.inject({
      method: "POST",
      url: "/api/admin/provider-switches",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { providerId: "direct-246-primary" }
    });

    expect(switched.statusCode).toBe(409);
    expect(switched.body).toContain("Space Gateway");
    expect(store.getProviderSettings().defaultProviderId).toBe("headroom-gateway");
    await app.close();
  });

  it("reads and updates only provider-advertised Codex-LB speed defaults with ADMIN, CSRF, and audit", async () => {
    const { app, store, speedDefaultUpdater } = await setup();
    const operator = authHeaders("OPERATOR");
    const admin = authHeaders("ADMIN");

    expect((await app.inject({
      method: "GET",
      url: "/api/admin/codex-lb-speed-defaults",
      headers: { cookie: operator.cookie }
    })).statusCode).toBe(403);

    const current = await app.inject({
      method: "GET",
      url: "/api/admin/codex-lb-speed-defaults",
      headers: { cookie: admin.cookie }
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual(speedDefaults);

    const withoutCsrf = await app.inject({
      method: "PATCH",
      url: "/api/admin/codex-lb-speed-defaults/gpt-5.5",
      headers: { cookie: admin.cookie },
      payload: { tier: "FAST" }
    });
    expect(withoutCsrf.statusCode).toBe(403);

    const unsupported = await app.inject({
      method: "PATCH",
      url: "/api/admin/codex-lb-speed-defaults/gpt-5.6",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { tier: "FAST" }
    });
    expect(unsupported.statusCode).toBe(409);

    const forged = await app.inject({
      method: "PATCH",
      url: "/api/admin/codex-lb-speed-defaults/gpt-5.5",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { tier: "FAST", path: "/tmp/forged-map.json" }
    });
    expect(forged.statusCode).toBe(422);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/admin/codex-lb-speed-defaults/gpt-5.5",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { tier: "FAST" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().models[0]).toMatchObject({ modelId: "gpt-5.5", tier: "FAST" });
    expect(speedDefaultUpdater).toHaveBeenCalledWith("gpt-5.5", "FAST");
    expect(store.listAuditEvents().map((event) => event.action)).toContain("admin.codex_lb_speed_default.updated");
    await app.close();
  });

  it("serializes concurrent Codex-LB speed default updates", async () => {
    let releaseFirstUpdate!: () => void;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const callOrder: string[] = [];
    const speedDefaultUpdater = vi.fn(async (modelId: "gpt-5.5" | "gpt-5.4", tier: "STANDARD" | "FAST") => {
      callOrder.push(`${modelId}:${tier}:start`);
      if (modelId === "gpt-5.5") await firstUpdateBlocked;
      callOrder.push(`${modelId}:${tier}:finish`);
      return {
        ...speedDefaults,
        models: speedDefaults.models.map((model) => model.modelId === modelId ? { ...model, tier } : model) as CodexLbSpeedDefaultsResponse["models"]
      };
    });
    const { app } = await setup({ codexLbSpeedDefaultUpdater: speedDefaultUpdater });
    const admin = authHeaders("ADMIN");
    const headers = { cookie: admin.cookie, "x-space-csrf-token": admin.csrf };

    const first = app.inject({
      method: "PATCH",
      url: "/api/admin/codex-lb-speed-defaults/gpt-5.5",
      headers,
      payload: { tier: "FAST" }
    });
    await vi.waitFor(() => expect(speedDefaultUpdater).toHaveBeenCalledTimes(1));
    const second = app.inject({
      method: "PATCH",
      url: "/api/admin/codex-lb-speed-defaults/gpt-5.4",
      headers,
      payload: { tier: "STANDARD" }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(speedDefaultUpdater).toHaveBeenCalledTimes(1);

    releaseFirstUpdate();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(callOrder).toEqual([
      "gpt-5.5:FAST:start",
      "gpt-5.5:FAST:finish",
      "gpt-5.4:STANDARD:start",
      "gpt-5.4:STANDARD:finish"
    ]);
    await app.close();
  });

  it("rejects and does not audit a speed update that the helper did not confirm", async () => {
    const { app, store } = await setup({
      codexLbSpeedDefaultUpdater: vi.fn(async () => speedDefaults)
    });
    const admin = authHeaders("ADMIN");
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/codex-lb-speed-defaults/gpt-5.5",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { tier: "FAST" }
    });

    expect(response.statusCode).toBe(409);
    expect(store.listAuditEvents().map((event) => event.action)).not.toContain("admin.codex_lb_speed_default.updated");
    await app.close();
  });

  it("restores the previous speed default when audit persistence fails", async () => {
    const { app, store, speedDefaultUpdater } = await setup();
    vi.spyOn(store, "recordAuditEvent").mockRejectedValueOnce(new Error("audit database unavailable"));
    const admin = authHeaders("ADMIN");

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/codex-lb-speed-defaults/gpt-5.5",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { tier: "FAST" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("database");
    expect(speedDefaultUpdater.mock.calls).toEqual([
      ["gpt-5.5", "FAST"],
      ["gpt-5.5", "STANDARD"]
    ]);
    await app.close();
  });

  it("requires recovery without exposing helper errors when speed rollback fails", async () => {
    let updateAttempt = 0;
    const speedDefaultUpdater = vi.fn(async (modelId: "gpt-5.5" | "gpt-5.4", tier: "STANDARD" | "FAST") => {
      updateAttempt += 1;
      if (updateAttempt === 2) throw new Error("rollback helper unavailable");
      return {
        ...speedDefaults,
        models: speedDefaults.models.map((model) => model.modelId === modelId ? { ...model, tier } : model) as CodexLbSpeedDefaultsResponse["models"]
      };
    });
    const { app, store } = await setup({ codexLbSpeedDefaultUpdater: speedDefaultUpdater });
    vi.spyOn(store, "recordAuditEvent").mockRejectedValueOnce(new Error("audit database unavailable"));
    const admin = authHeaders("ADMIN");

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/codex-lb-speed-defaults/gpt-5.5",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { tier: "FAST" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("recovery is required");
    expect(response.body).not.toContain("database");
    expect(response.body).not.toContain("helper");
    expect(speedDefaultUpdater.mock.calls).toEqual([
      ["gpt-5.5", "FAST"],
      ["gpt-5.5", "STANDARD"]
    ]);
    await app.close();
  });
});
