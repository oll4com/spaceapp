import { afterEach, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { workerReadinessSchema } from "@space/contracts";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { categorizeHttpFailure, createHttpObservability, errorCodeFromPayload } from "../src/observability.js";
import { durationToSeconds } from "../src/worker-readiness.js";

const worker = workerReadinessSchema.parse({
  id: "space-worker",
  status: "RUNNING",
  statusReason: "Temporal is reachable and pollers are visible.",
  address: "127.0.0.1:7233",
  namespace: "default",
  taskQueue: "space-agent-turns",
  reachable: true,
  workflowPollerCount: 2,
  activityPollerCount: 3,
  pollerCount: 5,
  workflowBacklogCount: 4,
  activityBacklogCount: 7,
  workflowBacklogAgeSeconds: 1.5,
  activityBacklogAgeSeconds: 42,
  pollerIdentities: ["space-worker@test"],
  lastPollerAccessAt: "2026-10-10T00:00:00.000Z",
  checkedAt: "2026-10-10T00:00:01.000Z"
});

let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function build() {
  app = await createApp({
    store: new InMemorySpaceStore(),
    config: getApiConfig({ SPACE_STORE_MODE: "memory", SPACE_CLI_ENABLED: "false", SPACE_BROWSER_SESSIONS_ENABLED: "false" }),
    workerReadinessChecker: async () => worker,
    auth: { sessionSecret: "metrics-fixture-session-secret-123", devLogin: false, secureCookies: false }
  });
  return app;
}

describe("/metrics", () => {
  it("exposes process, error-code and Temporal queue metrics", async () => {
    const server = await build();
    await server.inject({ url: "/api/rooms" });
    await server.inject({ url: "/no/such/route" });
    await server.inject({ url: "/readyz" });
    const metrics = (await server.inject({ url: "/metrics" })).body;

    expect(metrics).toMatch(/space_process_cpu_seconds_total\{mode="user"\} \d/);
    expect(metrics).toMatch(/space_process_event_loop_lag_seconds\{stat="p99"\} \d/);
    expect(metrics).toContain('space_process_memory_bytes{type="rss"}');
    expect(metrics).toMatch(/space_http_error_responses_total\{code="[A-Z_]+",category="PERMISSION_DENIED",status_class="4xx"\} 1/);
    expect(metrics).toContain('space_http_error_responses_total{code="UNSPECIFIED",category="NOT_FOUND",status_class="4xx"} 1');
    expect(metrics).toContain('space_temporal_task_queue_backlog{queue_type="activity"} 7');
    expect(metrics).toContain('space_temporal_task_queue_backlog_age_seconds{queue_type="activity"} 42');
    expect(metrics).toContain('space_temporal_task_queue_pollers{queue_type="workflow"} 2');
    expect(metrics).toContain("space_temporal_reachable 1");
    expect(metrics).toContain('space_temporal_readiness_checks_total{status="RUNNING"} 1');
    expect(metrics).toContain("# TYPE space_temporal_workflow_starts_total counter");
    expect(metrics).toContain("# TYPE space_recovery_events_total counter");
    // One exposition, one family per name.
    const families = metrics.split("\n").filter((line) => line.startsWith("# TYPE ")).map((line) => line.split(" ")[2]);
    expect(new Set(families).size).toBe(families.length);
  }, 30_000);

  it("serves loopback scrapers and refuses network clients, also through the trusted proxy", async () => {
    const server = await build();
    expect((await server.inject({ url: "/metrics" })).statusCode).toBe(200);
    expect((await server.inject({ url: "/metrics", remoteAddress: "192.168.1.50" })).statusCode).toBe(403);
    const direct = await server.inject({ url: "/metrics", remoteAddress: "93.184.216.34" });
    expect(direct.statusCode).toBe(403);
    expect(direct.json().error.code).toBe("METRICS_FORBIDDEN");
    const proxied = await server.inject({ url: "/metrics", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "93.184.216.34" } });
    expect(proxied.statusCode).toBe(403);
  }, 30_000);

  it("never exports secrets, prompts, paths or user identifiers sent in requests or error messages", async () => {
    const server = await build();
    const secrets = [
      "sk-live-metrics-secret-0123456789",
      "PRIVATE-PROMPT-TEXT",
      "operator@example.test",
      "/home/operator/private-project",
      "user:private-identity"
    ];
    await server.inject({ url: `/api/files/search?query=${encodeURIComponent(secrets[1]!)}&token=${secrets[0]}` });
    await server.inject({ url: `/api/private/${encodeURIComponent(secrets[3]!)}?q=${secrets[1]}` });
    await server.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { authorization: `Bearer ${secrets[0]}`, "x-user": secrets[4]! },
      payload: { email: secrets[2], password: secrets[0], prompt: secrets[1] }
    });
    await server.inject({ method: "POST", url: "/api/turns", payload: { roomId: secrets[4], paneId: secrets[4], prompt: secrets[1] } });
    const metrics = (await server.inject({ url: "/metrics" })).body;
    for (const secret of secrets) expect(metrics, secret).not.toContain(secret);
    expect(metrics).not.toContain("private-project");
  }, 30_000);
});

describe("error and readiness helpers", () => {
  it("reads only the stable error code from an error payload", () => {
    expect(errorCodeFromPayload(JSON.stringify({ error: { code: "TOOL_UNAVAILABLE", message: "rg missing at /home/x token=sk-1" } }))).toBe("TOOL_UNAVAILABLE");
    expect(errorCodeFromPayload(JSON.stringify({ ok: false, error: { code: "TIMEOUT" } }))).toBe("TIMEOUT");
    expect(errorCodeFromPayload(JSON.stringify({ error: "Not Found", message: "Route GET:/x not found" }))).toBeNull();
    expect(errorCodeFromPayload(JSON.stringify({ error: { code: "sk-live-secret" } }))).toBeNull();
    expect(errorCodeFromPayload("not json")).toBeNull();
    expect(errorCodeFromPayload(Buffer.from("{}"))).toBeNull();
    expect(categorizeHttpFailure(null, 404)).toBe("NOT_FOUND");
    expect(categorizeHttpFailure("TOOL_UNAVAILABLE", 503)).toBe("TOOL_UNAVAILABLE");
    expect(categorizeHttpFailure("INTERNAL_ERROR", 500)).toBe("INTERNAL");
    expect(categorizeHttpFailure(null, 429)).toBe("RATE_LIMITED");
  });

  it("converts Temporal durations and counts CLI disconnects and reconnects", () => {
    expect(durationToSeconds({ seconds: "12", nanos: 500_000_000 })).toBe(12.5);
    expect(durationToSeconds(null)).toBeNull();
    const observability = createHttpObservability({ serviceName: "space-api" });
    try {
      for (const event of ["SOCKET_DISCONNECTED", "RECONNECT_SCHEDULED", "RECONNECT_SUCCEEDED", "RECONNECT_STOPPED"]) {
        observability.observeCliTerminalEvent({ source: "CLIENT", event, outcome: "RETRY", reason: "SOCKET_CLOSE" });
      }
      observability.observeCliTerminalEvent({ source: "SERVER", event: "SOCKET_DETACHED", outcome: "INFO", reason: "CLIENT_DETACH" });
      observability.observeCliTerminalEvent({ source: "SERVER", event: "SOCKET_ATTACHED", outcome: "SUCCESS", reason: "AUTO_RESUME" });
      observability.observeCliTerminalEvent({ source: "SERVER", event: "SOCKET_ATTACHED", outcome: "SUCCESS", reason: "INITIAL_ATTACH" });
      const text = observability.renderPrometheus();
      expect(text).toContain('space_cli_terminal_disconnects_total{source="CLIENT"} 1');
      expect(text).toContain('space_cli_terminal_disconnects_total{source="SERVER"} 1');
      expect(text).toContain('space_cli_terminal_reconnects_total{source="CLIENT",outcome="SCHEDULED"} 1');
      expect(text).toContain('space_cli_terminal_reconnects_total{source="CLIENT",outcome="SUCCEEDED"} 1');
      expect(text).toContain('space_cli_terminal_reconnects_total{source="CLIENT",outcome="STOPPED"} 1');
      expect(text).toContain('space_cli_terminal_reconnects_total{source="SERVER",outcome="REATTACHED"} 1');
    } finally {
      observability.close();
    }
  });
});
