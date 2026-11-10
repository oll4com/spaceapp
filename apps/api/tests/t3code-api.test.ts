import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { T3CODE_LEGACY_ROUTES } from "../src/t3code/legacy.js";
import { parseT3CodeUnitState, type T3CodeServiceController } from "../src/t3code/service-control.js";

// createApp is heavy; under shared-host load it can exceed the 10 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sessionSecret = "test-session-secret-min-32-chars-long!";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

function authHeaders(role: "OPERATOR" | "ADMIN" = "ADMIN", id = role === "ADMIN" ? "user:operator" : "user:member") {
  const session = signSession({ id, email: `${id.slice(5)}@space.local`, role }, sessionSecret);
  return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)!, origin: "http://localhost:80" };
}

// A real Unix-socket peer standing in for the private bridge. Thread sessions
// follow the upstream shell projection shape.
async function fakeUpstream(threads: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "t3code-api-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const requests: { url?: string; headers: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/t3/environment") res.end(JSON.stringify({ environmentId: "env-real", serverVersion: "0.0.44" }));
    else if (req.url === "/api/orchestration/shell") res.end(JSON.stringify({ projects: [], threads }));
    else { res.writeHead(404); res.end("{}"); }
  });
  const socketPath = join(root, "bridge.sock");
  server.listen(socketPath); await once(server, "listening");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { socketPath, requests };
}

function fakeController(overrides: Partial<T3CodeServiceController> = {}) {
  const calls: string[] = [];
  const controller: T3CodeServiceController = {
    state: async () => ({ serviceEnabled: true, serviceActive: true, socketActive: true, pid: 4242 }),
    restart: async () => { calls.push("restart"); },
    setEnabled: async (enabled) => { calls.push(enabled ? "enable" : "disable"); },
    ...overrides
  };
  return { controller, calls };
}

async function createTestApp(env: Record<string, string>, controller?: T3CodeServiceController) {
  const config = getApiConfig({ SPACE_RUNTIME_STORE: "memory", ...env });
  const app = await createApp({ config, auth: { sessionSecret, sessionTtlSeconds: 3600 }, t3CodeServiceController: controller });
  cleanup.push(() => app.close());
  return app;
}

describe("T3 Code legacy retirement and feature flag scope", () => {
  it("answers every retired supervision route with 410 T3CODE_LEGACY_API_RETIRED", async () => {
    const app = await createTestApp({ SPACE_T3CODE_ENABLED: "true" });
    for (const route of T3CODE_LEGACY_ROUTES) {
      const url = route.url.replace(":paneId", "pane:abcdef123").replace(":approvalId", "approval-1");
      const response = await app.inject({ method: route.method, url, headers: authHeaders(), payload: route.method === "GET" ? undefined : {} });
      expect(response.statusCode, `${route.method} ${url}`).toBe(410);
      expect(response.json().error.code).toBe("T3CODE_LEGACY_API_RETIRED");
    }
  });

  it("limits SPACE_T3CODE_ENABLED=false to the T3 namespace", async () => {
    const app = await createTestApp({ SPACE_T3CODE_ENABLED: "false" });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/csrf", headers: authHeaders() })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/rooms", headers: authHeaders() })).statusCode).toBe(200);
    const gateway = await app.inject({ method: "GET", url: "/api/t3code/panes/pane:abcdef123/app/", headers: authHeaders() });
    expect(gateway.statusCode).toBe(404);
    expect(gateway.json().error.code).toBe("T3CODE_DISABLED");
    const binding = await app.inject({ method: "GET", url: "/api/t3code/panes/pane:abcdef123/app/__space/status", headers: authHeaders() });
    expect(binding.json().error.code).toBe("T3CODE_DISABLED");
  });
});

describe("T3 Code ADMIN service controls", () => {
  it("denies non-admin users before any service operation", async () => {
    const { controller, calls } = fakeController();
    const upstream = await fakeUpstream([]);
    const app = await createTestApp({ SPACE_T3CODE_SOCKET: upstream.socketPath }, controller);
    for (const [method, url, payload] of [["GET", "/api/admin/t3code/service", undefined], ["POST", "/api/admin/t3code/restart", {}],
      ["PATCH", "/api/admin/t3code/enabled", { enabled: false }]] as const) {
      const response = await app.inject({ method, url, payload, headers: authHeaders("OPERATOR") });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("ADMIN_REQUIRED");
    }
    expect(calls).toEqual([]);
  });

  it("reports real unit, runtime and active-run counts without thread content", async () => {
    const { controller } = fakeController();
    const upstream = await fakeUpstream([
      { id: "t1", title: "private title", session: { status: "running", activeTurnId: "turn-1" } },
      { id: "t2", session: { status: "ready", activeTurnId: null } }, { id: "t3", session: null },
      // T3 0.1.0 threads carry activeRunId instead of a provider session.
      { id: "t4", activeRunId: "run-1" }, { id: "t5", activeRunId: null }
    ]);
    const app = await createTestApp({ SPACE_T3CODE_SOCKET: upstream.socketPath }, controller);
    const response = await app.inject({ method: "GET", url: "/api/admin/t3code/service", headers: authHeaders() });
    expect(response.statusCode).toBe(200);
    const { status } = response.json();
    expect(status).toMatchObject({ featureEnabled: true, serviceEnabled: true, serviceActive: true, pid: 4242, ready: true, serverVersion: "0.0.44", activeRuns: 2 });
    expect(JSON.stringify(status)).not.toContain("private title");
    expect(upstream.requests.every((request) => request.headers["x-space-user-id"] === "user:operator" &&
      /^pane:[A-Za-z0-9_-]{6,80}$/.test(String(request.headers["x-space-pane-id"])))).toBe(true);
  });

  it("requires confirmation before interrupting active runs and refuses a concurrent second click", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { controller, calls } = fakeController({ restart: async () => { calls.push("restart"); await gate; } });
    const upstream = await fakeUpstream([{ id: "t1", session: { status: "running", activeTurnId: "turn-1" } }]);
    const app = await createTestApp({ SPACE_T3CODE_SOCKET: upstream.socketPath }, controller);
    const unconfirmed = await app.inject({ method: "POST", url: "/api/admin/t3code/restart", headers: authHeaders(), payload: {} });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json().error).toMatchObject({ code: "T3_ACTIVE_RUNS", details: { activeRuns: 1 } });
    expect(calls).toEqual([]);
    const first = app.inject({ method: "POST", url: "/api/admin/t3code/restart", headers: authHeaders(), payload: { confirmActiveRuns: true } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await app.inject({ method: "POST", url: "/api/admin/t3code/restart", headers: authHeaders(), payload: { confirmActiveRuns: true } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("T3_SERVICE_OPERATION_PENDING");
    release();
    expect((await first).statusCode).toBe(200);
    expect(calls).toEqual(["restart"]);
  });

  it("asks for confirmation when the run count cannot be read on a running service", async () => {
    const { controller, calls } = fakeController();
    const app = await createTestApp({ SPACE_T3CODE_SOCKET: "/nonexistent/space-t3code-test.sock" }, controller);
    const response = await app.inject({ method: "PATCH", url: "/api/admin/t3code/enabled", headers: authHeaders(), payload: { enabled: false } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "T3_ACTIVE_RUNS", details: { activeRuns: null } });
    expect(calls).toEqual([]);
  });

  it("refuses service changes when the installation flag is off", async () => {
    const { controller, calls } = fakeController();
    const app = await createTestApp({ SPACE_T3CODE_ENABLED: "false" }, controller);
    for (const [method, url, payload] of [["POST", "/api/admin/t3code/restart", {}], ["PATCH", "/api/admin/t3code/enabled", { enabled: true }]] as const) {
      const response = await app.inject({ method, url, payload, headers: authHeaders() });
      expect(response.json().error.code).toBe("T3CODE_DISABLED");
    }
    expect(calls).toEqual([]);
  });

  it("reports a failed restart as an error instead of success", async () => {
    const { controller } = fakeController({ restart: async () => { throw new Error("systemctl failed"); } });
    const upstream = await fakeUpstream([]);
    const app = await createTestApp({ SPACE_T3CODE_SOCKET: upstream.socketPath }, controller);
    const response = await app.inject({ method: "POST", url: "/api/admin/t3code/restart", headers: authHeaders(), payload: {} });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("T3_SERVICE_RESTART_FAILED");
    const strict = await app.inject({ method: "POST", url: "/api/admin/t3code/restart", headers: authHeaders(), payload: { unit: "space-api.service" } });
    expect(strict.statusCode).toBe(400);
  });

  it("disables and enables only through the fixed controller", async () => {
    const { controller, calls } = fakeController();
    const upstream = await fakeUpstream([]);
    const app = await createTestApp({ SPACE_T3CODE_SOCKET: upstream.socketPath }, controller);
    expect((await app.inject({ method: "PATCH", url: "/api/admin/t3code/enabled", headers: authHeaders(), payload: { enabled: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: "/api/admin/t3code/enabled", headers: authHeaders(), payload: { enabled: true } })).statusCode).toBe(200);
    expect(calls).toEqual(["disable", "enable"]);
  });

  it("parses systemctl unit state", () => {
    expect(parseT3CodeUnitState("Id=space-t3code.service\nActiveState=active\nUnitFileState=enabled\nMainPID=99\n\nId=space-t3code.socket\nActiveState=active\nUnitFileState=enabled\nMainPID=0\n"))
      .toEqual({ serviceEnabled: true, serviceActive: true, socketActive: true, pid: 99 });
    expect(parseT3CodeUnitState("Id=space-t3code.service\nActiveState=inactive\nUnitFileState=disabled\nMainPID=0\n\nId=space-t3code.socket\nActiveState=inactive\nUnitFileState=disabled\nMainPID=0\n"))
      .toEqual({ serviceEnabled: false, serviceActive: false, socketActive: false, pid: null });
  });
});
