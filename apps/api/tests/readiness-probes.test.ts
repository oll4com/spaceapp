import { afterEach, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { workerReadinessSchema } from "@space/contracts";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

const runningWorker = workerReadinessSchema.parse({
  id: "space-worker",
  status: "RUNNING",
  statusReason: "Temporal is reachable and pollers are visible.",
  address: "127.0.0.1:7233",
  namespace: "default",
  taskQueue: "space-agent-turns",
  reachable: true,
  workflowPollerCount: 1,
  activityPollerCount: 1,
  pollerCount: 2,
  workflowBacklogCount: 0,
  activityBacklogCount: 0,
  pollerIdentities: ["space-worker@test"],
  lastPollerAccessAt: "2026-10-10T00:00:00.000Z",
  checkedAt: "2026-10-10T00:00:01.000Z"
});

let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(store: InMemorySpaceStore) {
  app = await createApp({
    store,
    config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CLI_ENABLED: "false", SPACE_BROWSER_SESSIONS_ENABLED: "false" }),
    workerReadinessChecker: async () => runningWorker,
    auth: { sessionSecret: "readiness-probe-test-secret", devLogin: false, secureCookies: false }
  });
  return app;
}

describe("liveness and readiness probes", () => {
  it("answers liveness without dependency checks", async () => {
    const server = await build(new InMemorySpaceStore());
    const live = await server.inject({ method: "GET", url: "/livez" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ ok: true, service: "space-api" });
    expect(typeof live.json().uptimeSeconds).toBe("number");
  });

  it("reports in-memory storage as ready", async () => {
    const server = await build(new InMemorySpaceStore());
    const ready = await server.inject({ method: "GET", url: "/readyz?strict=1" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, dependencies: { database: "in-memory", worker: "RUNNING" } });
  });

  it("fails readiness when the database round trip fails, with 503 only in strict mode", async () => {
    const store = new InMemorySpaceStore() as InMemorySpaceStore & { checkReadiness(): Promise<void> };
    store.checkReadiness = async () => { throw new Error("connection refused"); };
    const server = await build(store);

    const compatible = await server.inject({ method: "GET", url: "/readyz" });
    expect(compatible.statusCode).toBe(200);
    expect(compatible.json()).toMatchObject({ ok: false, dependencies: { database: "UNAVAILABLE" } });

    const strict = await server.inject({ method: "GET", url: "/readyz?strict=1" });
    expect(strict.statusCode).toBe(503);
    expect(strict.json().ok).toBe(false);

    const live = await server.inject({ method: "GET", url: "/livez" });
    expect(live.statusCode).toBe(200);
  });

  it("reports a reachable database as RUNNING", async () => {
    const store = new InMemorySpaceStore() as InMemorySpaceStore & { checkReadiness(): Promise<void> };
    let pings = 0;
    store.checkReadiness = async () => { pings += 1; };
    const server = await build(store);
    const ready = await server.inject({ method: "GET", url: "/readyz" });
    expect(ready.json()).toMatchObject({ ok: true, dependencies: { database: "RUNNING" } });
    expect(pings).toBe(1);
  });
});
