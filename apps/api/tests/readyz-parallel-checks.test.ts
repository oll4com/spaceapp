import Fastify from "fastify";
import { expect, it } from "vitest";
import { workerReadinessSchema } from "@space/contracts";
import { registerHealthRoutes } from "../src/health-routes.js";

// Promote b-20261104-014005-3cec (4/11): the checks ran one after another, so a healthy API answered /readyz in
// 2.6-3.9 s on a loaded host and the deploy's 2-second tries never saw an answer. Here every check answers only once
// all of them have started, so checks run in turn would each fall back to their 2.5 s timeout value instead.
it("starts every readiness check before any of them answers", async () => {
  const started = new Set<string>();
  let open!: () => void;
  const allStarted = new Promise<void>((resolve) => { open = resolve; });
  const gated = <T>(name: string, value: T) => {
    started.add(name);
    if (started.size === 5) open();
    return allStarted.then(() => value);
  };
  const app = Fastify();
  registerHealthRoutes(app, {
    apiStartedAt: "2026-11-04T00:00:00.000Z",
    config: {
      cliEnabled: true, cliRootEnabled: true, browserSessionsEnabled: true, browserHostTransport: "unix",
      temporalAddress: "127.0.0.1:7233", temporalNamespace: "default", temporalTaskQueue: "space-agent-turns"
    } as never,
    appVersionReader: {} as never,
    store: { checkReadiness: () => gated("database", undefined) } as never,
    appDiagnosticsService: {
      getStatus: async () => ({ isEnabled: false, captureId: null, usage: { totalBytes: 0 }, quotaBytes: 0, recorder: { status: "IDLE" } })
    } as never,
    browserSessionManager: {
      browserHostHealth: () => gated("browserHost", {
        buildCommit: "abc", captureMetrics: null, status: { enabled: true, sandbox: { state: "NO_SANDBOX", reason: "lab", checkedAt: null } }, capacity: { maxSessions: 1, maxLiveWorkloads: 4 } // a 2-4 GB browser container's cap (light browser step 6)
      })
    } as never,
    workerReadinessChecker: () => gated("worker", workerReadinessSchema.parse({
      id: "space-worker", status: "RUNNING", statusReason: "ok", address: "127.0.0.1:7233", namespace: "default",
      taskQueue: "space-agent-turns", reachable: true, workflowPollerCount: 1, activityPollerCount: 1, pollerCount: 2,
      workflowBacklogCount: 0, activityBacklogCount: 0, pollerIdentities: [], lastPollerAccessAt: null,
      checkedAt: "2026-11-04T00:00:00.000Z"
    })),
    cliTerminalManager: { hostPing: (runtime?: string) => gated(runtime ?? "cliHost", true) } as never,
    routeOptions: {}
  });
  try {
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.json().dependencies).toMatchObject({
      database: "RUNNING", worker: "RUNNING", cliHost: "RUNNING", cliAdminHost: "RUNNING", browserHost: "RUNNING",
      browserSandbox: "NO_SANDBOX" // where the INT5-C-F3 ladder ends, run-spaceapp doctor names it
    });
  } finally {
    await app.close();
  }
}, 20_000);
