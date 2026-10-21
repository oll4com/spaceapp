import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import { workerTracingOptions } from "../src/worker-tracing.js";

interface Span { name: string; traceId: string; spanId: string; parentSpanId?: string;
  attributes: Array<{ key: string; value: { stringValue?: string } }> }

describe("production workflow trace propagation", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Tracing fixture cleanup failed");
  });
  it("traces turn/action workflows and memory children across three independent workers", async () => {
    const spans: Span[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      const data = JSON.parse(body);
      for (const resource of data.resourceSpans) for (const scope of resource.scopeSpans) spans.push(...scope.spans);
      res.end("{}");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const exporters = ["space-worker", "space-memory-maintenance-worker", "space-memory-mutation-worker"]
      .map(serviceName => createOtlpSpanExporter({ endpoint, serviceName, flushIntervalMs: 60_000 }));
    cleanups.push(() => Promise.all(exporters.map(exporter => exporter.close())));
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    cleanups.push(() => env.teardown());
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const parent = "bbbbbbbbbbbbbbbb";
    const traceparent = `00-${traceId}-${parent}-01`;
    const mainQueue = `main-${randomUUID()}`;
    const output = { status: "COMPLETED", message: "done" };
    let resolveSupervisor!: () => void;
    const supervisorFinished = new Promise<void>(resolve => { resolveSupervisor = resolve; });
    const main = await Worker.create({ connection: env.nativeConnection, taskQueue: mainQueue,
      workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
      ...workerTracingOptions(exporters[0]!), activities: {
        runCodexAppServerTurn: async () => output,
        runRoomAgentBackgroundAction: async () => output,
        checkRoomAgentSupervisorTurn: async () => "READY",
        finishRoomAgentSupervisorTurn: async () => { resolveSupervisor(); },
        discardRoomAgentSupervisorTurn: async () => undefined,
        dotGoalStep: async () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" })
      } });
    const maintenance = await Worker.create({ connection: env.nativeConnection, taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../src/memory-maintenance-workflows.ts", import.meta.url)),
      ...workerTracingOptions(exporters[1]!), activities: {
        refreshMemoryGraphSnapshot: async () => ({ sourceHash: "fixture-hash" }),
        refreshAllMonthsMemoryGraphSnapshot: async () => undefined,
        reconcileStaleSpaceAgentSessions: async () => undefined,
        createScheduledMemoryAudit: async () => ({ id: "audit:1", workflowId: `audit-${randomUUID()}` }),
        prepareMemoryConsolidation: async () => ({ changeSetId: "change:1", run: { id: "audit:1" } }),
        finalizeMemoryRepair: async () => ({ id: "audit:1" })
      } });
    const mutation = await Worker.create({ connection: env.nativeConnection, taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../src/memory-mutation-workflows.ts", import.meta.url)),
      ...workerTracingOptions(exporters[2]!), activities: { executePersistedMemoryChangeSet: async () => ({ status: "APPLIED" }) } });
    let resolveCompleted!: () => void;
    const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
    try {
      await Promise.all([main, maintenance, mutation].map(worker => worker.runUntil(async () => {
        if (worker !== main) {
          // Keep each worker polling while the caller drives the whole graph.
          await completed;
          return;
        }
        try {
          for (const type of ["codexAppServerTurnWorkflow", "roomAgentActionWorkflow"]) {
            const result = await env.client.workflow.execute(type, { taskQueue: mainQueue, workflowId: `${type}-${randomUUID()}`,
              args: [{ roomId: "room:fixture", paneId: "pane:fixture", traceparent }], memo: { traceparent } });
            expect(result).toEqual(output);
          }
          const supervisor = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue: mainQueue, workflowId: `supervisor-${randomUUID()}`, memo: { traceparent },
            args: [{ roomId: "room:fixture", pending: [{ missionId: "mission:fixture", turn: {
              roomId: "room:fixture", paneId: "pane:fixture", prompt: "synthetic", traceId: "req:supervisor", traceparent
            } }] }]
          });
          await supervisorFinished;
          await supervisor.cancel();
          await expect(supervisor.result()).rejects.toThrow();
          expect(await env.client.workflow.execute("dotGoalWorkflow", { taskQueue: mainQueue,
            workflowId: `goal-${randomUUID()}`, args: [{ goalId: "goal:fixture" }], memo: { traceparent } }))
            .toEqual({ goalStatus: "COMPLETED" });
          await env.client.workflow.execute("memoryMaintenanceWorkflow", { taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
            workflowId: `maintenance-${randomUUID()}`, args: [{ traceId: "req:memory" }], memo: { traceparent } });
          await env.client.workflow.execute("memoryMutationWorkflow", { taskQueue: MEMORY_MUTATION_TASK_QUEUE,
            workflowId: `mutation-${randomUUID()}`, args: [{ changeSetId: "change:direct", traceId: "req:memory" }], memo: { traceparent } });
        } finally { finish(); }
      })));
      await Promise.all(exporters.map(exporter => exporter.flush()));
      const workflows = spans.filter(span => span.name === "temporal.workflow");
      const byType = (type: string) => workflows.find(span => span.attributes.some(attr => attr.key === "temporal.workflow_type" && attr.value.stringValue === type))!;
      expect(byType("codexAppServerTurnWorkflow").parentSpanId).toBe(parent);
      expect(byType("roomAgentActionWorkflow").parentSpanId).toBe(parent);
      expect(byType("roomAgentSupervisorWorkflow").parentSpanId).toBe(parent);
      expect(byType("dotGoalWorkflow").parentSpanId).toBe(parent);
      expect(byType("memoryConsolidationWorkflow").parentSpanId).toBe(byType("memoryMaintenanceWorkflow").spanId);
      const crossWorker = spans.find(span => span.attributes.some(attr => attr.key === "temporal.activity_type" && attr.value.stringValue === "executePersistedMemoryChangeSet")
        && span.parentSpanId === byType("memoryConsolidationWorkflow").spanId);
      expect(crossWorker).toBeDefined();
      expect(spans.every(span => span.traceId === traceId)).toBe(true);
    } finally {
      finish();
    }

    function finish() { resolveCompleted(); }
  }, 120_000);
});
