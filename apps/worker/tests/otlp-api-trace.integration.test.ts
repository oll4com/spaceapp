import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { InMemoryStreamingBotRepository, InMemoryStreamingRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import type { DummyTurnInput } from "@space/contracts";
import { expect, it } from "vitest";
import { createApp } from "../../api/src/app.js";
import { getApiConfig } from "../../api/src/config.js";
import { StreamingBotService } from "../../api/src/streaming-bot-service.js";
import { StreamingCredentialStore } from "../../api/src/streaming-credential-store.js";
import { StreamingService } from "../../api/src/streaming-service.js";
import { TemporalCodexAppServerTurnStarter } from "../../api/src/turns.js";
import { createWorkerTracing } from "../src/worker-tracing.js";
import { otlpWorkflowBundle } from "./support/otlp-test-harness.js";

interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  status: { code: number };
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
}
interface TraceBody {
  resourceSpans: Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }>;
}

const promptSentinel = "PRIVATE_PROMPT_SENTINEL /home/private/input.txt https://private.invalid/?token=private-secret";
const outputSentinel = "PRIVATE_OUTPUT_SENTINEL /home/private/result.txt token=private-result";
const errorSentinel = "PRIVATE_ERROR_SENTINEL /home/private/failure.txt token=private-error";

/** Allow an optional proof mirror only at an unauthenticated loopback HTTP origin. */
function jaegerTraceUrl(): string | null {
  const value = process.env.SPACE_TEST_JAEGER_ENDPOINT;
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("SPACE_TEST_JAEGER_ENDPOINT must be an unauthenticated loopback HTTP origin.");
  }
  return `${url.origin}/v1/traces`;
}

/** Capture actual OTLP bytes and track optional, sentinel-guarded local Jaeger mirroring. */
async function startProofCollector() {
  const mirror = jaegerTraceUrl();
  const bodies: TraceBody[] = [];
  const mirrorRequests: Promise<void>[] = [];
  const mirrorErrors: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => { body += part; });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/traces") { response.writeHead(404).end(); return; }
      try {
        bodies.push(JSON.parse(body) as TraceBody);
        // Even the optional local UI gets only this fixture's sanitized spans.
        if (mirror && !/PRIVATE_(?:PROMPT|OUTPUT|ERROR)_SENTINEL/.test(body)) {
          mirrorRequests.push(fetch(mirror, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(3000) })
            .then(async result => { if (!result.ok) throw new Error(`Jaeger rejected OTLP: ${result.status}`); await result.arrayBuffer(); })
            .catch(error => { mirrorErrors.push(error); }));
        }
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      } catch { response.writeHead(400).end(); }
    });
  });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Collector did not bind to loopback TCP.");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    bodies,
    spans: () => bodies.flatMap(body => body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))),
    async checkMirror() { await Promise.all(mirrorRequests); expect(mirrorErrors).toEqual([]); },
    close: () => new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); })
  };
}

/** Streaming's Unix-root guard also accepts a current-drive rooted Windows path. */
function credentialPath(directory: string): string {
  if (process.platform !== "win32") return directory;
  if (parse(directory).root.toLowerCase() !== parse(process.cwd()).root.toLowerCase()) {
    throw new Error("Test TEMP and checkout must share a drive for the Unix-root credential guard.");
  }
  const rooted = directory.slice(parse(directory).root.length - 1).replaceAll("\\", "/");
  if (resolve(rooted) !== resolve(directory)) throw new Error("Fixture credential path changed its physical target.");
  return rooted;
}

it("exports an actual HTTP API request, production Temporal workflow and retried activity in one exact parent tree", async () => {
  const collector = await startProofCollector();
  const fixtureRoot = await mkdtemp(join(tmpdir(), "space-otlp-api-"));
  const priorEndpoint = process.env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT = collector.endpoint;
  let environment: TestWorkflowEnvironment | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const tracing = createWorkerTracing("space-worker-api-proof", {
    env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint },
    workflowModule: fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url)),
    exporter: { batchSize: 16, flushIntervalMs: 50, timeoutMs: 1000 }
  });
  try {
    environment = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-otlp-api-client" } });
    const env = environment;
    const taskQueue = `otlp-api-${crypto.randomUUID()}`;
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Synthetic OTLP fixture", initialPaneCount: 1 }, "trace:synthetic-seed");
    const pane = store.listPanes(room.id)[0]!;
    const streamingRepository = new InMemoryStreamingRepository();
    const streamingService = new StreamingService({
      repository: streamingRepository,
      credentialStore: new StreamingCredentialStore(credentialPath(join(fixtureRoot, "streaming"))),
      store
    });
    app = await createApp({
      store,
      config: getApiConfig({
        SPACE_INSTANCE: "dev", SPACE_RUNTIME_STORE: "memory", SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_TEMPORAL_ADDRESS: env.address,
        SPACE_TEMPORAL_TASK_QUEUE: taskQueue,
        SPACE_T3CODE_ENABLED: "false", SPACE_CLI_ENABLED: "false", SPACE_DEMO_PROJECTS_ENABLED: "false",
        SPACE_ROOM_AGENT_MONITOR_ENABLED: "false", SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: "false",
        SPACE_ARTIFACT_ROOT: join(fixtureRoot, "artifacts"), SPACE_APP_DIAGNOSTICS_ROOT: join(fixtureRoot, "diagnostics"),
        SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: join(fixtureRoot, "maintenance", "state.json"),
        SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: join(fixtureRoot, "account-balancer", "state.json"),
        SPACE_STREAMING_SECRET_ROOT: credentialPath(join(fixtureRoot, "streaming"))
      }),
      auth: { sessionSecret: "synthetic-otlp-api-test-session-secret", devLogin: true, secureCookies: false },
      codexTurnStarter: new TemporalCodexAppServerTurnStarter({
        address: env.address, namespace: env.client.options.namespace, taskQueue,
        // This is the real SDK test client; no start/signal method is mocked.
        clientFactory: async () => ({ client: env.client, close: async () => {} })
      }),
      streamingService,
      streamingBotService: new StreamingBotService({ botRepository: new InMemoryStreamingBotRepository(), streamingRepository, store, youtubeDailyBudget: 8000 }),
      startRoomAgentMonitor: false, jobApplyMailTriage: false, mailCopilotSync: false,
      marketingCopilotScheduler: false, marketingCopilotMetrics: false
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = await fetch(`${address}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "space@space.local", password: "space-dev" })
    });
    expect(login.status).toBe(200);
    await login.arrayBuffer();
    const cookie = login.headers.getSetCookie().find(value => value.startsWith("space_session="))?.split(";")[0];
    expect(cookie).toBeTruthy();
    const csrfResponse = await fetch(`${address}/api/auth/csrf`, { headers: { cookie: cookie! } });
    expect(csrfResponse.status).toBe(200);
    const { csrfToken } = await csrfResponse.json() as { csrfToken: string };
    expect(csrfToken).toBeTruthy();
    const attempts: number[] = [];
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.client.options.namespace,
      taskQueue, workflowBundle: await otlpWorkflowBundle(),
      ...tracing.workerOptions,
      identity: "synthetic-otlp-api-worker",
      // The helper bundled the workflow module; only host interceptors go here.
      interceptors: { activity: tracing.workerOptions.interceptors?.activity },
      activities: {
        async runCodexAppServerTurn(input: DummyTurnInput) {
          const activityInfo = Context.current().info;
          attempts.push(activityInfo.attempt);
          expect(input.prompt).toBe(promptSentinel);
          if (activityInfo.attempt === 1) throw new Error(errorSentinel);
          if (!activityInfo.workflowExecution) throw new Error("Synthetic activity has no workflow execution.");
          return { workflowId: activityInfo.workflowExecution.workflowId, roomId: input.roomId, paneId: input.paneId, traceId: input.traceId, status: "COMPLETED", message: outputSentinel };
        }
      }
    });
    let workflowId = "";
    await worker.runUntil(async () => {
      const response = await fetch(`${address}/api/turns`, {
        method: "POST", headers: { "content-type": "application/json", cookie: cookie!, "x-space-csrf-token": csrfToken },
        body: JSON.stringify({ roomId: room.id, paneId: pane.id, prompt: promptSentinel, runtime: "CODEX_APP_SERVER" })
      });
      expect(response.status).toBe(200);
      const queued = await response.json() as { workflowId: string; runId: string; status: string };
      expect(queued.status).toBe("QUEUED");
      workflowId = queued.workflowId;
      const result = await env.client.workflow.getHandle(queued.workflowId, queued.runId).result();
      expect(result).toMatchObject({ status: "COMPLETED", message: outputSentinel });
    });
    expect(attempts).toEqual([1, 2]);
    await tracing.flush();
    // API onClose initiates its bounded exporter flush; wait for observable
    // collector receipt instead of assuming the void close method awaited it.
    await app.close();
    app = undefined;
    const deadline = Date.now() + 8000;
    while (!collector.spans().some(span => span.name === "POST /api/turns") && Date.now() < deadline) await delay(20);
    const allSpans = collector.spans();
    const serverSpan = allSpans.find(span => span.name === "POST /api/turns");
    expect(serverSpan).toBeDefined();
    expect(serverSpan!.kind).toBe(2);
    expect(serverSpan!.parentSpanId).toBeUndefined();
    const workflowSpan = allSpans.find(span => span.name === "workflow.codexAppServerTurnWorkflow");
    expect(workflowSpan).toBeDefined();
    expect(workflowSpan).toMatchObject({ traceId: serverSpan!.traceId, parentSpanId: serverSpan!.spanId, kind: 1, status: { code: 0 } });
    expect(workflowSpan!.attributes).toContainEqual({ key: "temporal.workflow.id", value: { stringValue: workflowId } });
    const activities = allSpans.filter(span => span.name === "activity.runCodexAppServerTurn");
    expect(activities).toHaveLength(2);
    expect(new Set(activities.map(span => span.spanId)).size).toBe(2);
    for (const span of activities) expect(span).toMatchObject({ traceId: serverSpan!.traceId, parentSpanId: workflowSpan!.spanId, kind: 1 });
    const byAttempt = (attempt: number) => activities.find(span => span.attributes.some(attribute => attribute.key === "temporal.activity.attempt" && attribute.value.intValue === String(attempt)));
    expect(byAttempt(1)).toMatchObject({ status: { code: 2 } });
    expect(byAttempt(2)).toMatchObject({ status: { code: 0 } });
    expect(JSON.stringify(collector.bodies)).not.toMatch(/PRIVATE_(?:PROMPT|OUTPUT|ERROR)_SENTINEL|private\.invalid|private\.txt|private-secret|private-result|private-error/);
    await collector.checkMirror();
    process.stdout.write(`OTLP_API_TRACE_PROOF traceId=${serverSpan!.traceId} apiSpanId=${serverSpan!.spanId} workflowSpanId=${workflowSpan!.spanId} activityAttempts=${activities.length}\n`);
  } finally {
    if (priorEndpoint === undefined) delete process.env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT = priorEndpoint;
    await app?.close();
    await tracing.close();
    await environment?.teardown();
    await collector.close();
    const parent = resolve(tmpdir());
    const target = resolve(fixtureRoot);
    if (!target.startsWith(`${parent}${sep}`) || !target.slice(parent.length + 1).startsWith("space-otlp-api-")) {
      throw new Error("Refusing to remove a fixture outside its temporary parent.");
    }
    await rm(target, { recursive: true, force: true });
  }
}, 90_000);
