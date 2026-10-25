import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexEnvironment } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import {
  calculateCpuUsagePercent,
  createHostStatsProvider,
  parseMeminfo,
  parseProcStat,
  summarizeCliHostStats
} from "../src/host-stats.js";
import { CORE_SERVICE_RESTART_COMMAND } from "../src/service-restarts.js";

const csrfHeaderName = "x-space-csrf-token";
const apiStartedAt = "2026-07-14T09:00:00.000Z";

function baseEnvironment(): CodexEnvironment {
  return {
    codexHome: "/var/lib/spaceapp-user/.codex",
    stateDbPath: "/var/lib/spaceapp-user/.codex/state_5.sqlite",
    config: {
      modelProvider: "codex-lb",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh"
    },
    mcpServers: [],
    skillCount: 0,
    pluginCount: 0,
    memories: {
      generateMemories: null,
      useMemories: null
    },
    features: {
      plugins: null,
      memories: null
    },
    checkedAt: "2026-07-14T09:00:00.000Z"
  };
}

function codexParity(): CreateAppOptions["codexParity"] {
  return {
    async listHistory() {
      return { data: [], totalItems: 0, visibleItems: 0, checkedAt: "2026-07-14T09:00:00.000Z" };
    },
    async getHistoryThread() {
      throw new Error("not used");
    },
    async getThread() {
      throw new Error("not used");
    },
    async renameThread() {
      throw new Error("not used");
    },
    async getEnvironment() {
      return baseEnvironment();
    }
  };
}

async function adminApp(options: CreateAppOptions = {}) {
  const app = await createApp({
    ...options,
    config: options.config ?? getApiConfig({ SPACE_ARTIFACT_ROOT: join(tmpdir(), "space-test-artifacts") }),
    codexParity: options.codexParity ?? codexParity(),
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false,
      ...(options.auth ?? {})
    }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  return { app, cookie, csrfToken: csrf.json().csrfToken as string };
}

describe("Space host stats and safe core restarts", () => {
  it("parses memory and CPU host telemetry with bounded values", () => {
    const memory = parseMeminfo(
      [
        "MemTotal:        2097152 kB",
        "MemAvailable:     524288 kB",
        "SwapTotal:       1048576 kB",
        "SwapFree:         262144 kB"
      ].join("\n")
    );
    expect(memory.memory).toEqual({
      totalBytes: 2_147_483_648,
      usedBytes: 1_610_612_736,
      usagePercent: 75
    });
    expect(memory.swap).toEqual({
      totalBytes: 1_073_741_824,
      usedBytes: 805_306_368,
      usagePercent: 75
    });
    expect(calculateCpuUsagePercent(parseProcStat("cpu  100 0 100 800 0 0 0 0 0 0"), parseProcStat("cpu  150 0 150 900 0 0 0 0 0 0"))).toBe(50);
  });

  it("counts running Space-managed main and root CLI sessions without process scanning", () => {
    const summary = summarizeCliHostStats([
      {
        ok: true,
        hostId: "main",
        health: {
          hostPid: 101,
          startedAt: "2026-07-14T08:00:00.000Z",
          buildCommit: "abc",
          sessions: [
            { status: "RUNNING", attachmentCount: 1 },
            { status: "RUNNING", attachmentCount: 0 },
            { status: "EXITED", attachmentCount: 0 }
          ]
        }
      },
      {
        ok: true,
        hostId: "root",
        health: {
          hostPid: 102,
          startedAt: "2026-07-14T08:00:00.000Z",
          buildCommit: "abc",
          sessions: [{ status: "RUNNING", attachmentCount: 2 }]
        }
      }
    ]);
    expect(summary).toEqual({
      active: 3,
      attached: 2,
      detached: 1,
      status: "OK"
    });
  });

  it("fails soft on slow CLI host sockets and caches host stats", async () => {
    let mainHealthCalls = 0;
    let meminfoReads = 0;
    const provider = createHostStatsProvider({
      apiStartedAt,
      cacheTtlMs: 10_000,
      timeoutMs: 1,
      readMeminfo: async () => {
        meminfoReads += 1;
        return "MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n";
      },
      readProcStat: async () => "cpu  100 0 100 800 0 0 0 0 0 0\n",
      cliHosts: [
        {
          hostId: "main",
          enabled: true,
          health: async () => {
            mainHealthCalls += 1;
            return {
              hostPid: 101,
              startedAt: apiStartedAt,
              buildCommit: "abc",
              sessions: [{ status: "RUNNING", attachmentCount: 0 }]
            };
          }
        },
        {
          hostId: "root",
          enabled: true,
          health: async () => new Promise(() => undefined)
        }
      ],
      now: () => new Date("2026-07-14T09:00:10.000Z")
    });

    const [first, second] = await Promise.all([provider(), provider()]);

    expect(first).toEqual(second);
    expect(first.cliSessions).toEqual({ active: 1, attached: 0, detached: 1, status: "PARTIAL" });
    expect(first.memory.usagePercent).toBe(50);
    expect(first.swap.usagePercent).toBeNull();
    expect(mainHealthCalls).toBe(1);
    expect(meminfoReads).toBe(1);

    await provider();
    expect(mainHealthCalls).toBe(1);
    expect(meminfoReads).toBe(1);
  });

  it("returns stale host stats immediately while refreshing an expired sample", async () => {
    let currentTimeMs = new Date("2026-07-14T09:00:10.000Z").getTime();
    let meminfoReads = 0;
    let releaseRefresh: (() => void) | null = null;
    const provider = createHostStatsProvider({
      apiStartedAt,
      cacheTtlMs: 10_000,
      readMeminfo: async () => {
        meminfoReads += 1;
        if (meminfoReads === 2) await new Promise<void>((resolve) => (releaseRefresh = resolve));
        return meminfoReads === 1
          ? "MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"
          : "MemTotal: 1024 kB\nMemAvailable: 256 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n";
      },
      readProcStat: async () => "cpu  100 0 100 800 0 0 0 0 0 0\n",
      cliHosts: [],
      now: () => new Date(currentTimeMs)
    });

    const first = await provider();
    currentTimeMs += 10_001;
    const stale = await provider();

    expect(stale).toBe(first);
    expect(stale.memory.usagePercent).toBe(50);
    expect(meminfoReads).toBe(2);

    releaseRefresh?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await provider()).memory.usagePercent).toBe(75);
  });

  it("merges host stats into the Codex environment response", async () => {
    const { app, cookie } = await adminApp({
      hostStatsProvider: async () => ({
        cliSessions: { active: 2, attached: 1, detached: 1, status: "OK" },
        cpu: { usagePercent: 17.2, coreCount: 16 },
        memory: { usedBytes: 8, totalBytes: 10, usagePercent: 80 },
        swap: { usedBytes: 1, totalBytes: 10, usagePercent: 10 },
        apiStartedAt,
        sampledAt: "2026-07-14T09:00:10.000Z"
      })
    });

    const response = await app.inject({ method: "GET", url: "/api/codex/environment", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().hostStats).toMatchObject({
      cliSessions: { active: 2, attached: 1, detached: 1, status: "OK" },
      cpu: { usagePercent: 17.2, coreCount: 16 },
      apiStartedAt
    });
  });

  it("accepts only ADMIN CSRF-protected CORE restart requests and persists cooldown", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-restart-test-"));
    const cooldownPath = join(root, "cooldown.json");
    const store = new InMemorySpaceStore();
    const executed: unknown[] = [];
    const cooldownObservedByRestarter: unknown[] = [];
    const { app, cookie, csrfToken } = await adminApp({
      store,
      serviceRestartCooldownPath: cooldownPath,
      serviceRestarter: async (command) => {
        executed.push(command);
        cooldownObservedByRestarter.push(JSON.parse(await readFile(cooldownPath, "utf8")).scope);
      }
    });

    try {
      const readyBeforeRestart = await app.inject({ method: "GET", url: "/readyz" });
      expect(CORE_SERVICE_RESTART_COMMAND).toEqual({
        command: "/usr/bin/sudo",
        args: ["-n", "/usr/bin/systemctl", "--no-block", "start", "space-core-restart.service"]
      });

      const accepted = await app.inject({
        method: "POST",
        url: "/api/admin/service-restarts",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { scope: "CORE" }
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toMatchObject({
        status: "ACCEPTED",
        scope: "CORE",
        services: ["space-worker.service", "space-api.service", "space-web.service"],
        apiStartedAt: readyBeforeRestart.json().apiStartedAt
      });
      expect(executed).toEqual([CORE_SERVICE_RESTART_COMMAND]);
      expect(cooldownObservedByRestarter).toEqual(["CORE"]);
      expect(JSON.parse(await readFile(cooldownPath, "utf8"))).toMatchObject({ scope: "CORE" });
      expect(store.listAuditEvents().map((event) => event.action)).toContain("admin.service_restart.requested");

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/admin/service-restarts",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { scope: "CORE" }
      });
      expect(duplicate.statusCode).toBe(429);

      const missingCsrf = await app.inject({
        method: "POST",
        url: "/api/admin/service-restarts",
        headers: { cookie },
        payload: { scope: "CORE" }
      });
      expect(missingCsrf.statusCode).toBe(403);

      const invalid = await app.inject({
        method: "POST",
        url: "/api/admin/service-restarts",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { scope: "CORE", command: "restart codex-pane-host too" }
      });
      expect(invalid.statusCode).toBe(422);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-admin service restart requests", async () => {
    const sessionSecret = "test-secret-with-enough-length";
    const app = await createApp({
      codexParity: codexParity(),
      auth: {
        sessionSecret,
        devLogin: false,
        operatorEmail: "operator@example.test",
        operatorPasswordHash: "unused",
        secureCookies: false
      }
    });
    const cookie = `space_session=${signSession({ id: "user:operator", email: "operator@example.test", role: "OPERATOR" }, sessionSecret)}`;
    const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/service-restarts",
      headers: { cookie, [csrfHeaderName]: csrf.json().csrfToken },
      payload: { scope: "CORE" }
    });

    expect(response.statusCode).toBe(403);
  });

  it("allows only one concurrent core restart request", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-restart-race-test-"));
    const cooldownPath = join(root, "cooldown.json");
    let restartCalls = 0;
    const { app, cookie, csrfToken } = await adminApp({
      serviceRestartCooldownPath: cooldownPath,
      serviceRestarter: async () => {
        restartCalls += 1;
      }
    });

    try {
      const request = () =>
        app.inject({
          method: "POST",
          url: "/api/admin/service-restarts",
          headers: { cookie, [csrfHeaderName]: csrfToken },
          payload: { scope: "CORE" }
        });
      const responses = await Promise.all([request(), request()]);

      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 429]);
      expect(restartCalls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
