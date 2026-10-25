import { SystemHealthMonitor } from "../src/system-health-service.js";
import { SystemHealthCollector } from "../src/system-health-collector.js";
import { RecentRequestWindow } from "../src/recent-request-window.js";
import { InMemorySystemHealthRepository } from "@space/db";
import { systemHealthSnapshotSchema, systemHealthHistorySchema } from "@space/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  systemAnalyticsCliSessionsResponseSchema,
  systemAnalyticsModelsResponseSchema,
  systemAnalyticsOverviewResponseSchema,
  systemAnalyticsProcessesResponseSchema,
  systemAnalyticsResourcesResponseSchema,
  toolbarModelStatsSchema
} from "@space/contracts";
import { InMemorySystemAnalyticsRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { createCsrfToken, signSession } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { SystemAnalyticsService } from "../src/system-analytics-service.js";

const sessionSecret = "system-analytics-api-test-secret";
const sampledAt = "2026-08-11T08:00:00.000Z";
const apps: FastifyInstance[] = [];

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    "x-space-csrf-token": createCsrfToken(session, sessionSecret)!
  };
}

async function setup() {
  const store = new InMemorySpaceStore();
  const repository = new InMemorySystemAnalyticsRepository();
  const analytics = new SystemAnalyticsService({
    repository,
    store,
    liveSessions: async () => [],
    now: () => new Date(sampledAt),
    coreCount: 4,
    stateRoot: "/nonexistent/system-analytics-opencode",
    codexHome: "/nonexistent/system-analytics-codex",
    readProcessTable: async () => [{
      pid: 200,
      parentPid: 1,
      rssBytes: 64 * 1024 * 1024,
      virtualBytes: 256 * 1024 * 1024,
      swapBytes: 0,
      uptimeSeconds: 120,
      threadCount: 4,
      cpuOneCorePercent: 12.5,
      state: "S",
      name: "space-api",
      commandLine: "node apps/api/dist/server.js"
    }],
    readMeminfo: async () => [
      "MemTotal: 8388608 kB",
      "MemAvailable: 4194304 kB",
      "Cached: 1048576 kB",
      "Shmem: 65536 kB",
      "SwapTotal: 2097152 kB",
      "SwapFree: 1572864 kB"
    ].join("\n"),
    readProcStat: async () => "cpu  100 0 100 800 0 0 0 0 0 0\n"
  });
  // Route tests use fixture data only; native CLI ingestion is covered in collector tests.
  vi.spyOn(analytics, "ingestModels").mockResolvedValue();
  vi.spyOn(analytics, "backfill").mockResolvedValue();
  const toolbarModelStatsCollector = vi.fn(async ({ windowMinutes }: { roomId: string; windowMinutes: number }) => ({
    windowMinutes,
    sampledAt,
    models: [],
    sources: [],
    errors: []
  }));
  const app = await createApp({
    store,
    config: getApiConfig({}),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    systemAnalyticsService: analytics,
    healthMonitor: new SystemHealthMonitor({ repository: new InMemorySystemHealthRepository(),
      collector: new SystemHealthCollector({ read: async () => { throw new Error("fixture unavailable"); }, filesystem: async () => { throw new Error("fixture unavailable"); } }),
      requests: () => new RecentRequestWindow().snapshot(), checks: [] }),
    toolbarModelStatsCollector
  });
  apps.push(app);
  return { app, toolbarModelStatsCollector, repository };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("System analytics API", () => {
  it("aggregates retained model and provider tokens within daily, weekly and monthly windows", async () => {
    const { app, repository } = await setup();
    await repository.upsertModelEvents([1, 3, 15, 31].map((daysAgo) => {
      const at = new Date(Date.parse(sampledAt) - daysAgo * 86400000 + 1000).toISOString();
      return {
        eventKey: `history:${daysAgo}`, source: "codex", runtimeId: "cli:codex", providerId: "codex",
        modelId: "history-model", roomId: null, paneId: null, sessionId: null, turnId: `turn:${daysAgo}`,
        status: "COMPLETED" as const, coverage: "NATIVE" as const, turnCount: 1, startedAt: at, endedAt: at,
        tokensIn: 100, tokensOut: 20, tokensReasoning: 5, ttftMs: null, durationMs: null, updatedAt: at
      };
    }));
    for (const [range, count] of [["24h", 1], ["7d", 2], ["30d", 3]] as const) {
      const response = await app.inject({ method: "GET", url: `/api/admin/system-analytics/models?range=${range}`, headers: authHeaders("ADMIN") });
      expect(response.statusCode).toBe(200);
      const data = systemAnalyticsModelsResponseSchema.parse(response.json());
      expect(data.range).toBe(range);
      expect(data.models.find(model => model.modelId === "history-model")).toMatchObject({ tokensIn: count * 100, tokensOut: count * 20, tokensReasoning: count * 5 });
      expect(data.providers.find(provider => provider.providerId === "codex")).toMatchObject({ tokensIn: count * 100, tokensOut: count * 20 });
    }
  });

  it("returns schema-valid global analytics to ADMIN users", async () => {
    const { app } = await setup();
    const headers = authHeaders("ADMIN");
    const requests = [
      { url: "/api/admin/system-analytics/health", schema: systemHealthSnapshotSchema },
      { url: "/api/admin/system-analytics/health/history?range=30d", schema: systemHealthHistorySchema },
      { url: "/api/admin/system-analytics/overview?range=1h", schema: systemAnalyticsOverviewResponseSchema },
      { url: "/api/admin/system-analytics/models?range=7d", schema: systemAnalyticsModelsResponseSchema },
      { url: "/api/admin/system-analytics/resources?range=30d", schema: systemAnalyticsResourcesResponseSchema },
      { url: "/api/admin/system-analytics/processes?page=1&pageSize=10&sort=rss", schema: systemAnalyticsProcessesResponseSchema },
      { url: "/api/admin/system-analytics/cli-sessions?range=10m", schema: systemAnalyticsCliSessionsResponseSchema }
    ];

    for (const request of requests) {
      const response = await app.inject({ method: "GET", url: request.url, headers });
      expect(response.statusCode, request.url).toBe(200);
      expect(() => request.schema.parse(response.json()), request.url).not.toThrow();
    }
  });

  it("rejects every analytics surface for non-admin users", async () => {
    const { app } = await setup();
    const headers = authHeaders("OPERATOR");
    const urls = [
      "/api/admin/system-analytics/health",
      "/api/admin/system-analytics/health/history",
      "/api/admin/system-analytics/overview",
      "/api/admin/system-analytics/models",
      "/api/admin/system-analytics/resources",
      "/api/admin/system-analytics/processes",
      "/api/admin/system-analytics/cli-sessions"
    ];

    for (const url of urls) {
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode, url).toBe(403);
      expect(response.json().error.code, url).toBe("ADMIN_REQUIRED");
    }
  });

  it("collects toolbar model telemetry globally without requiring roomId", async () => {
    const { app, toolbarModelStatsCollector } = await setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/toolbar-model-stats?windowMinutes=10",
      headers: authHeaders("ADMIN")
    });

    expect(response.statusCode).toBe(200);
    expect(() => toolbarModelStatsSchema.parse(response.json())).not.toThrow();
    expect(toolbarModelStatsCollector).toHaveBeenCalledWith({ roomId: "global", windowMinutes: 10 });
  });

  it("accepts state and thread-count process sorting through the API contract", async () => {
    const { app } = await setup();
    const headers = authHeaders("ADMIN");
    for (const sort of ["state", "threads"]) {
      for (const direction of ["asc", "desc"]) {
        const url = `/api/admin/system-analytics/processes?page=1&pageSize=10&sort=${sort}&direction=${direction}`;
        const response = await app.inject({ method: "GET", url, headers });
        expect(response.statusCode, url).toBe(200);
        expect(() => systemAnalyticsProcessesResponseSchema.parse(response.json()), url).not.toThrow();
      }
    }
  });

  it("drops the sampling ps invocation from the process table", async () => {
    const { isProcessSamplerRow } = await import("../src/system-analytics-service.js");
    const sampler = {
      pid: 4242,
      parentPid: process.pid,
      rssBytes: 1024,
      virtualBytes: 2048,
      swapBytes: 0,
      uptimeSeconds: 0,
      threadCount: 1,
      cpuOneCorePercent: 12.5,
      state: "R",
      name: "ps",
      commandLine: "/bin/ps -ww -eo pid=,ppid=,rss=,vsz=,etimes=,nlwp=,pcpu=,stat=,comm=,args="
    };

    expect(isProcessSamplerRow(sampler)).toBe(true);
    expect(isProcessSamplerRow({ ...sampler, parentPid: 1 })).toBe(true);
    expect(isProcessSamplerRow({ ...sampler, name: "node" })).toBe(false);
    expect(isProcessSamplerRow({ ...sampler, parentPid: 1, commandLine: "ps -ef" })).toBe(false);
  });

  it("orders processes by state and thread count", async () => {
    const analytics = new SystemAnalyticsService({
      repository: new InMemorySystemAnalyticsRepository(),
      store: new InMemorySpaceStore(),
      liveSessions: async () => [],
      now: () => new Date(sampledAt),
      coreCount: 4,
      stateRoot: "/nonexistent/system-analytics-sort",
      codexHome: "/nonexistent/system-analytics-sort-codex",
      readProcessTable: async () => [
        { pid: 3, parentPid: 1, rssBytes: 1024, virtualBytes: 2048, swapBytes: 0, uptimeSeconds: 30, threadCount: 30, cpuOneCorePercent: 1, state: "S", name: "zeta", commandLine: "zeta" },
        { pid: 1, parentPid: 1, rssBytes: 1024, virtualBytes: 2048, swapBytes: 0, uptimeSeconds: 10, threadCount: 10, cpuOneCorePercent: 1, state: "R", name: "alpha", commandLine: "alpha" },
        { pid: 2, parentPid: 1, rssBytes: 1024, virtualBytes: 2048, swapBytes: 0, uptimeSeconds: 20, threadCount: 20, cpuOneCorePercent: 1, state: "D", name: "mid", commandLine: "mid" }
      ],
      readMeminfo: async () => [
        "MemTotal: 8388608 kB",
        "MemAvailable: 4194304 kB",
        "SwapTotal: 2097152 kB",
        "SwapFree: 1572864 kB"
      ].join("\n"),
      readProcStat: async () => "cpu  100 0 100 800 0 0 0 0 0 0\n"
    });
    const byThreads = await analytics.processes({ page: 1, pageSize: 10, sort: "threads", direction: "desc" });
    expect(byThreads.data.map((process) => process.threadCount)).toEqual([30, 20, 10]);
    const byState = await analytics.processes({ page: 1, pageSize: 10, sort: "state", direction: "asc" });
    expect(byState.data.map((process) => process.state)).toEqual(["D", "R", "S"]);
  });
});
