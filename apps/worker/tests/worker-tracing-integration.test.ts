import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createOtlpSpanExporter, type otlpTraceRequest } from "@space/telemetry";
import { workerTracingOptions } from "../src/worker-tracing.js";
import { runSpanId } from "../src/workflow-trace-context.js";

const traceId = "a".repeat(32), apiSpanId = "b".repeat(16);
const traceparent = `00-${traceId}-${apiSpanId}-01`;
const modulePath = fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url));
type OtlpBatch = ReturnType<typeof otlpTraceRequest>;
type ExportedSpan = OtlpBatch["resourceSpans"][number]["scopeSpans"][number]["spans"][number];
const received: OtlpBatch[] = [];
const collector = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  expect(req.url).toBe("/v1/traces");
  received.push(JSON.parse(body));
  // Optional manual evidence: forward synthetic fixtures to a local Jaeger.
  // Default CI/tests require only this fake collector and Temporal's test server.
  if (process.env.SPACE_TRACE_TEST_JAEGER === "1") {
    const response = await fetch("http://127.0.0.1:4318/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body });
    res.statusCode = response.ok ? 200 : 502;
  }
  res.end();
});
let env: TestWorkflowEnvironment;
let exporter: ReturnType<typeof createOtlpSpanExporter>;
const spans = () => received.flatMap(batch => batch.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans)));
const attrs = (span: ExportedSpan) => Object.fromEntries(span.attributes.map(a => [a.key, a.value.stringValue ?? Number(a.value.intValue)]));

beforeAll(async () => {
  collector.listen(0, "127.0.0.1"); await once(collector, "listening");
  const address = collector.address() as { port: number };
  exporter = createOtlpSpanExporter({ endpoint: `http://127.0.0.1:${address.port}`, serviceName: "space-worker-test", scopeName: "space-temporal", batchSize: 100 });
  env = process.env.SPACE_TRACE_TEST_JAEGER === "1"
    ? await TestWorkflowEnvironment.createLocal()
    : await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);
afterAll(async () => { await env?.teardown(); await exporter?.close(); collector.close(); });

it("joins a real production workflow and each retry to the API span; replay exports nothing", async () => {
  received.length = 0;
  const taskQueue = `trace-${randomUUID()}`;
  let attempts = 0;
  const workflowOptions = { workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), ...workerTracingOptions(exporter, modulePath) };
  const worker = await Worker.create({ ...workflowOptions, connection: env.nativeConnection, taskQueue,
    activities: { recordDummyTurnStarted: async () => { if (++attempts === 1) throw Error("secret error /private https://private"); }, recordDummyTurnCompleted: async () => ({ status: "COMPLETED" }) } });
  const handle = await env.client.workflow.start("dummyTurnWorkflow", { taskQueue, workflowId: randomUUID(), args: [{ traceparent, roomId: "room:1", prompt: "PRIVATE_PROMPT" }] });
  await worker.runUntil(handle.result()); await exporter.flush();
  const trace = spans();
  const workflow = trace.find(s => s.name === "dummyTurnWorkflow");
  expect(workflow).toMatchObject({ traceId, parentSpanId: apiSpanId, kind: 1 });
  const activities = trace.filter(s => s.name.startsWith("recordDummy"));
  expect(activities).toHaveLength(3);
  expect(activities.every(s => s.traceId === traceId && s.parentSpanId === workflow.spanId)).toBe(true);
  expect(activities.filter(s => s.name === "recordDummyTurnStarted").map(attrs).map(a => [a.attempt, a.status])).toEqual([[1, "FAILED"], [2, "COMPLETED"]]);
  expect(JSON.stringify(received)).not.toMatch(/PRIVATE_PROMPT|secret error|\/private|https:\/\/private/);
  const history = await handle.fetchHistory();
  const before = trace.length;
  await Worker.runReplayHistory(workflowOptions, history);
  await exporter.flush();
  expect(spans()).toHaveLength(before);
}, 60_000);

it("nests child workflows and links continue-as-new and background runs", async () => {
  received.length = 0;
  const taskQueue = `links-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue,
    workflowsPath: fileURLToPath(new URL("./fixtures/trace-workflows.ts", import.meta.url)), ...workerTracingOptions(exporter, modulePath), activities: { tracedActivity: async () => "ok" } });
  await worker.runUntil(async () => {
    expect(await env.client.workflow.execute("traceParent", { taskQueue, workflowId: randomUUID(), args: [{ traceparent, again: true }] })).toBe("ok");
    expect(await env.client.workflow.execute("traceBackground", { taskQueue, workflowId: randomUUID(), args: [{ traceparent }] })).toBe("ok");
  });
  await exporter.flush();
  const all = spans();
  const parents = all.filter(s => s.name === "traceParent");
  expect(parents).toHaveLength(2);
  const continued = parents.find(s => attrs(s).status === "CONTINUED_AS_NEW");
  const final = parents.find(s => attrs(s).status === "COMPLETED");
  expect(final.links).toContainEqual({ traceId, spanId: continued.spanId });
  expect(final.spanId).not.toBe(continued.spanId);
  expect(all.filter(s => s.name === "traceChild").every(s => parents.some(p => p.spanId === s.parentSpanId))).toBe(true);
  const background = all.find(s => s.name === "traceBackground");
  const child = all.find(s => s.name === "traceBackgroundChild");
  expect(child.links).toContainEqual({ traceId, spanId: background.spanId });
  for (const span of all) expect(span.spanId).toBe(span.name === "tracedActivity" ? span.spanId : runSpanId(attrs(span).runId));
}, 60_000);

it("replays a history created before tracing was enabled without exporting spans", async () => {
  received.length = 0;
  const taskQueue = `legacy-${randomUUID()}`;
  const workflowsPath = fileURLToPath(new URL("./fixtures/trace-workflows.ts", import.meta.url));
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath,
    activities: { tracedActivity: async () => "ok" } });
  const handle = await env.client.workflow.start("traceParent", { taskQueue, workflowId: randomUUID(), args: [{ traceparent, again: false }] });
  await worker.runUntil(handle.result());
  const history = await handle.fetchHistory();
  await Worker.runReplayHistory({ workflowsPath, ...workerTracingOptions(exporter, modulePath) }, history);
  await exporter.flush();
  expect(spans()).toEqual([]);
}, 60_000);

it("traces real maintenance/consolidation children and the dedicated mutation workflow", async () => {
  received.length = 0;
  // Use the actual queue constants, including cross-worker activity routing.
  const { MEMORY_MAINTENANCE_TASK_QUEUE } = await import("../src/memory-maintenance-config.js");
  const { MEMORY_MUTATION_TASK_QUEUE } = await import("../src/memory-mutation-config.js");
  const maintenance = await Worker.create({ connection: env.nativeConnection, taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("../src/memory-maintenance-workflows.ts", import.meta.url)), ...workerTracingOptions(exporter, modulePath), activities: {
      refreshMemoryGraphSnapshot: async () => ({ sourceHash: "a".repeat(64) }), refreshAllMonthsMemoryGraphSnapshot: async () => undefined,
      reconcileStaleSpaceAgentSessions: async () => undefined, createScheduledMemoryAudit: async () => ({ id: "audit:1", workflowId: `consolidation-${randomUUID()}` }),
      prepareMemoryConsolidation: async () => ({ changeSetId: "change:1", run: { id: "audit:1" } }), finalizeMemoryRepair: async () => ({ id: "audit:1" })
    } });
  const mutation = await Worker.create({ connection: env.nativeConnection, taskQueue: MEMORY_MUTATION_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("../src/memory-mutation-workflows.ts", import.meta.url)), ...workerTracingOptions(exporter, modulePath),
    activities: { executePersistedMemoryChangeSet: async () => ({ status: "APPLIED" }) } });
  await maintenance.runUntil(mutation.runUntil(async () => {
    await env.client.workflow.execute("memoryMaintenanceWorkflow", { taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, workflowId: randomUUID(), args: [{ scheduledAt: new Date().toISOString(), traceId: "req:maintenance" }], memo: { traceparent } });
    await env.client.workflow.execute("memoryMutationWorkflow", { taskQueue: MEMORY_MUTATION_TASK_QUEUE, workflowId: randomUUID(), args: [{ changeSetId: "change:2", traceId: "req:mutation" }], memo: { traceparent } });
  }));
  await exporter.flush();
  const all = spans();
  const parent = all.find(s => s.name === "memoryMaintenanceWorkflow");
  const child = all.find(s => s.name === "memoryConsolidationWorkflow");
  expect(parent).toMatchObject({ traceId, parentSpanId: apiSpanId });
  expect(child).toMatchObject({ traceId, parentSpanId: parent.spanId });
  const direct = all.find(s => s.name === "memoryMutationWorkflow");
  expect(direct).toMatchObject({ traceId, parentSpanId: apiSpanId });
  expect(all.filter(s => s.name === "executePersistedMemoryChangeSet").map(s => s.parentSpanId).sort()).toEqual([child.spanId, direct.spanId].sort());
}, 60_000);


it("connects an actual HTTP turn request to a production workflow and activities", async () => {
  received.length = 0;
  const { createApp } = await import("../../api/src/app.js");
  const { TemporalTurnStarter } = await import("../../api/src/turns.js");
  const { InMemorySpaceStore } = await import("@space/runtime");
  const address = collector.address() as { port: number };
  vi.stubEnv("SPACE_OTEL_EXPORTER_OTLP_ENDPOINT", `http://127.0.0.1:${address.port}`);
  const taskQueue = `http-trace-${randomUUID()}`;
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Trace fixture", initialPaneCount: 1 }, "trace:seed");
  const pane = store.listPanes(room.id)[0]!;
  const app = await createApp({ store,
    turnStarter: new TemporalTurnStarter({ address: env.address, namespace: "default", taskQueue,
      clientFactory: async () => ({ client: env.client, close: async () => undefined }) }),
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = app.listeningOrigin;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "space@space.local", password: "space-dev" }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().find(value => value.startsWith("space_session="))!.split(";")[0]!;
    const csrf = await fetch(`${base}/api/auth/csrf`, { headers: { cookie } }).then(response => response.json()) as { csrfToken: string };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue,
      workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), ...workerTracingOptions(exporter, modulePath),
      activities: { recordDummyTurnStarted: async () => undefined, recordDummyTurnCompleted: async () => ({ status: "COMPLETED" }) } });
    await worker.runUntil(async () => {
      const response = await fetch(`${base}/api/turns`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-space-csrf-token": csrf.csrfToken },
        body: JSON.stringify({ roomId: room.id, paneId: pane.id, prompt: "PRIVATE_HTTP_PROMPT" }) });
      expect(response.status).toBe(200);
      const turn = await response.json() as { workflowId: string };
      await env.client.workflow.getHandle(turn.workflowId).result();
    });
    await exporter.flush();
    await app.close();
    await expect.poll(() => spans().find(s => s.name === "POST /api/turns"), { timeout: 6000 }).toBeDefined();
    const root = spans().find(s => s.name === "POST /api/turns");
    expect(root.kind).toBe(2);
    const workflow = spans().find(s => s.name === "dummyTurnWorkflow");
    expect(workflow).toMatchObject({ traceId: root.traceId, parentSpanId: root.spanId });
    expect(spans().filter(s => s.name.startsWith("recordDummy"))).toHaveLength(2);
    expect(spans().filter(s => s.name.startsWith("recordDummy")).every(s => s.traceId === root.traceId && s.parentSpanId === workflow.spanId)).toBe(true);
    expect(JSON.stringify(received)).not.toMatch(/PRIVATE_HTTP_PROMPT|space-dev|space_session/);
    if (process.env.SPACE_TRACE_TEST_JAEGER === "1") console.info(`Jaeger trace: http://127.0.0.1:16686/trace/${root.traceId}`);
  } finally { await app.close(); vi.unstubAllEnvs(); }
}, 60_000);
