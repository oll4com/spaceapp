import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  dummyTurnInputSchema,
  memoryConsolidationRunSchema,
  memoryMaintenanceResultSchema,
  memoryMutationWorkflowResultSchema
} from "@space/contracts";
import { noteActivityFailureReason } from "../src/activity-observability.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import { createWorkerTracing } from "../src/worker-tracing.js";

interface WireAttribute { key: string; value: { stringValue?: string; intValue?: string } }
interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  status: { code: number };
  attributes: WireAttribute[];
}
interface TraceRequest {
  resourceSpans: Array<{
    resource: { attributes: WireAttribute[] };
    scopeSpans: Array<{ spans: WireSpan[] }>;
  }>;
}
type CapturedSpan = WireSpan & { service: string; values: Record<string, string | number> };
type Tracing = ReturnType<typeof createWorkerTracing>;

const traceId = "67b34da6a3ce929d0e0e47364bf92f35";
const apiSpanId = "aabbccddeeff1234";
const traceparent = `00-${traceId}-${apiSpanId}-01`;
const now = "2026-01-01T00:00:00.000Z";
const sourceHash = "a".repeat(64);

function values(attributes: WireAttribute[]): Record<string, string | number> {
  return Object.fromEntries(attributes.map(({ key, value }) => [
    key, value.intValue === undefined ? value.stringValue ?? "" : Number(value.intValue)
  ]));
}

function runWorkers<T>(workers: Worker[], run: () => Promise<T>): Promise<T> {
  const [first, ...rest] = workers;
  return first ? first.runUntil(() => runWorkers(rest, run)) : run();
}

function only(spans: CapturedSpan[], predicate: (span: CapturedSpan) => boolean): CapturedSpan {
  const matches = spans.filter(predicate);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("OTLP propagation through shipping SpaceApp workflows", () => {
  let environment: TestWorkflowEnvironment;
  let collector: ReturnType<typeof createServer>;
  let endpoint: string;
  let mainBundle: WorkflowBundleWithSourceMap;
  let maintenanceBundle: WorkflowBundleWithSourceMap;
  let mutationBundle: WorkflowBundleWithSourceMap;
  const requests: TraceRequest[] = [];
  const observers = new Set<Tracing>();

  function tracing(serviceName: string): Tracing {
    const observer = createWorkerTracing({ serviceName, env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: endpoint } });
    observers.add(observer);
    return observer;
  }

  async function closeTracing() {
    await Promise.all([...observers].map(observer => observer.close()));
    observers.clear();
  }

  function spans(): CapturedSpan[] {
    return requests.flatMap(request => request.resourceSpans.flatMap(resource => {
      const service = String(values(resource.resource.attributes)["service.name"]);
      return resource.scopeSpans.flatMap(scope => scope.spans.map(span => ({
        ...span, service, values: values(span.attributes)
      })));
    }));
  }

  function createWorker(taskQueue: string, observer: Tracing, bundle: WorkflowBundleWithSourceMap | null,
    activities: Record<string, (...args: any[]) => Promise<unknown>>) {
    // These modules were already bundled below. The remaining host interceptors
    // are independent per worker, including the activity-only mutation worker.
    const { workflowModules: _alreadyBundled, ...hostInterceptors } = observer.interceptors;
    return Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      ...(bundle ? { workflowBundle: bundle } : {}),
      activities,
      interceptors: hostInterceptors,
      sinks: observer.sinks,
      shutdownGraceTime: "2s"
    });
  }

  beforeAll(async () => {
    collector = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as TraceRequest);
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      } catch { response.writeHead(400).end(); }
    });
    await new Promise<void>((resolve, reject) => {
      collector.once("error", reject);
      collector.listen(0, "127.0.0.1", () => resolve());
    });
    endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const observer = tracing("space-production-bundler");
    [mainBundle, maintenanceBundle, mutationBundle] = await Promise.all([
      "../src/workflows.ts",
      "../src/memory-maintenance-workflows.ts",
      "../src/memory-mutation-workflows.ts"
    ].map(path => bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL(path, import.meta.url)),
      workflowInterceptorModules: observer.interceptors.workflowModules
    })));
    await closeTracing();
  }, 120_000);

  afterEach(async () => {
    await closeTracing();
    requests.length = 0;
  });

  afterAll(async () => {
    await environment?.teardown();
    if (collector?.listening) {
      collector.closeAllConnections();
      await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()));
    }
  });

  it("propagates memo-only API context through memory maintenance, consolidation and a separate mutation worker", async () => {
    const suffix = randomUUID();
    const parentId = `production-memory-${suffix}`;
    const childId = `production-consolidation-${suffix}`;
    const changeSetId = `change-set:${suffix}`;
    const refreshed = memoryMaintenanceResultSchema.parse({
      status: "REFRESHED", generatedAt: now, sourceHash, previousSourceHash: null,
      summary: { sourceCount: 1, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 }, durationMs: 1
    });
    const run = memoryConsolidationRunSchema.parse({
      id: `consolidation:${suffix}`, mode: "REPAIR", triggerKind: "SCHEDULED", status: "SUCCEEDED",
      workflowId: childId, dedupeKey: `synthetic-${suffix}`, sourceHash, actorUserId: null,
      progressCompleted: 1, progressTotal: 1, findingCount: 1, appliedOperationCount: 1,
      skippedOperationCount: 0, failedOperationCount: 0, metrics: {}, modelId: null,
      aiVerified: false, aiEvidence: {}, statusReason: null, createdAt: now, startedAt: now,
      completedAt: now, updatedAt: now
    });
    const mutationResult = memoryMutationWorkflowResultSchema.parse({
      status: "APPLIED", changeSetId, resultingSourceHash: sourceHash, reason: null
    });
    const calls: string[] = [];
    const maintenanceActivities = {
      async refreshMemoryGraphSnapshot() { calls.push("snapshot"); return refreshed; },
      async refreshAllMonthsMemoryGraphSnapshot() { calls.push("all-months"); return refreshed; },
      async reconcileStaleSpaceAgentSessions() { calls.push("reconcile"); return { reconciled: 0 }; },
      async createScheduledMemoryAudit() { calls.push("audit"); return run; },
      async prepareMemoryConsolidation(input: { runId: string }) {
        expect(input.runId).toBe(run.id);
        calls.push("prepare");
        return { run, changeSetId };
      },
      async finalizeMemoryRepair(input: { mutationResult: unknown }) {
        expect(input.mutationResult).toEqual(mutationResult);
        calls.push("finalize");
        return run;
      }
    };
    const workers = await Promise.all([
      createWorker(`memory-root-${suffix}`, tracing("space-memory-root"), maintenanceBundle, maintenanceActivities),
      createWorker(MEMORY_MAINTENANCE_TASK_QUEUE, tracing("space-memory-maintenance-worker"), maintenanceBundle, maintenanceActivities),
      createWorker(MEMORY_MUTATION_TASK_QUEUE, tracing("space-memory-mutation-worker"), null, {
        async executePersistedMemoryChangeSet(input: { changeSetId: string; traceId: string }) {
          expect(input.changeSetId).toBe(changeSetId);
          expect(input.traceId).toBe("req:production-memory");
          expect(input).not.toHaveProperty("traceparent");
          calls.push("mutate");
          return mutationResult;
        }
      })
    ]);
    const result = await runWorkers(workers, () => environment.client.workflow.execute("memoryMaintenanceWorkflow", {
      taskQueue: `memory-root-${suffix}`,
      workflowId: parentId,
      workflowExecutionTimeout: "30s",
      args: [{ scheduledAt: now, traceId: "req:production-memory" }],
      memo: { traceparent, spaceTraceId: "req:production-memory" }
    }));
    await closeTracing();
    expect(result).toEqual(refreshed);
    expect(calls).toEqual(["snapshot", "all-months", "reconcile", "audit", "prepare", "mutate", "finalize"]);
    const recorded = spans();
    const parent = only(recorded, span => span.values.workflowType === "memoryMaintenanceWorkflow" && !span.values.activityType);
    const child = only(recorded, span => span.values.workflowType === "memoryConsolidationWorkflow" && !span.values.activityType);
    expect(parent.parentSpanId).toBe(apiSpanId);
    expect(parent.values.workflowId).toBe(parentId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.values.workflowId).toBe(childId);
    const mutation = only(recorded, span => span.values.activityType === "executePersistedMemoryChangeSet");
    expect(mutation.parentSpanId).toBe(child.spanId);
    expect(mutation.service).toBe("space-memory-mutation-worker");
    expect(mutation.values.attempt).toBe(1);
    expect(recorded).toHaveLength(9);
    for (const span of recorded) {
      expect(span.traceId).toBe(traceId);
      expect(span.status.code).toBe(0);
      if (span.values.activityType) {
        expect(span.parentSpanId).toBe(span.values.workflowId === parentId ? parent.spanId : child.spanId);
      }
    }
  }, 45_000);

  it.each([
    ["dummyTurnWorkflow", ["recordDummyTurnStarted", "recordDummyTurnCompleted"], false],
    ["codexAppServerTurnWorkflow", ["runCodexAppServerTurn"], true],
    ["roomAgentActionWorkflow", ["runRoomAgentBackgroundAction"], false],
    ["dotGoalWorkflow", ["dotGoalStep"], false]
  ] as const)("traces production %s with real activity dispatch and memo-only context", async (workflowType, expectedActivities, failed) => {
    const suffix = randomUUID();
    const taskQueue = `production-turn-${suffix}`;
    const workflowId = `${workflowType}-${suffix}`;
    const privateMessage = "synthetic private returned message";
    const turnInput = dummyTurnInputSchema.parse({
      roomId: "room:production-fixture", paneId: "pane:production-fixture", prompt: "synthetic private prompt",
      traceId: "req:production-turn", providerId: "codex", artifactIds: [], permissionMode: null
    });
    const turnResult = {
      workflowId, roomId: turnInput.roomId, paneId: turnInput.paneId, traceId: turnInput.traceId,
      status: failed ? "FAILED" : "COMPLETED", message: privateMessage
    };
    const observer = tracing("space-worker");
    const runningWorker = await createWorker(taskQueue, observer, mainBundle, {
      async recordDummyTurnStarted() { return undefined; },
      async recordDummyTurnCompleted() { return turnResult; },
      async runCodexAppServerTurn() {
        noteActivityFailureReason("PROVIDER_UNAVAILABLE");
        return turnResult;
      },
      async runRoomAgentBackgroundAction() { return turnResult; },
      async dotGoalStep() { return { state: "DONE", runId: null, goalStatus: "COMPLETED" }; }
    });
    const input = workflowType === "dotGoalWorkflow" ? { goalId: "dot_goal:production-fixture" }
      : workflowType === "roomAgentActionWorkflow" ? {
        actionId: "action:production-fixture", traceId: turnInput.traceId,
        bridge: { roomId: turnInput.roomId, missionId: "mission:production-fixture" }
      } : turnInput;
    const result = await runningWorker.runUntil(() => environment.client.workflow.execute(workflowType, {
      taskQueue, workflowId, workflowExecutionTimeout: "30s",
      args: [input], memo: { traceparent, spaceTraceId: turnInput.traceId }
    }));
    await closeTracing();
    expect(result).toEqual(workflowType === "dotGoalWorkflow" ? { goalStatus: "COMPLETED" } : turnResult);
    const recorded = spans();
    const workflow = only(recorded, span => !span.values.activityType);
    expect(workflow.parentSpanId).toBe(apiSpanId);
    expect(workflow.values.workflowType).toBe(workflowType);
    expect(workflow.status.code).toBe(failed ? 2 : 0);
    expect(workflow.values.outcome).toBe(failed ? "FAILED_RESULT" : "COMPLETED");
    const activitySpans = recorded.filter(span => span.values.activityType);
    expect(activitySpans.map(span => span.values.activityType).sort()).toEqual([...expectedActivities].sort());
    for (const span of recorded) expect(span.traceId).toBe(traceId);
    for (const activity of activitySpans) {
      expect(activity.parentSpanId).toBe(workflow.spanId);
      expect(activity.values.attempt).toBe(1);
      expect(activity.status.code).toBe(failed ? 2 : 0);
    }
    if (failed) {
      expect(activitySpans[0]!.values.outcome).toBe("FAILED_RESULT");
      expect(activitySpans[0]!.values.reasonCode).toBe("PROVIDER_UNAVAILABLE");
      expect(activitySpans[0]!.values.category).toBe("UPSTREAM_UNAVAILABLE");
    }
    expect(JSON.stringify(requests)).not.toContain(privateMessage);
    expect(JSON.stringify(requests)).not.toContain(turnInput.prompt);
  }, 30_000);

  it("traces the production memory-mutation workflow itself, not only its cross-queue activity", async () => {
    const taskQueue = `mutation-${randomUUID()}`;
    const changeSetId = "change-set:production-mutation";
    const mutationResult = memoryMutationWorkflowResultSchema.parse({
      status: "APPLIED", changeSetId, resultingSourceHash: sourceHash, reason: null
    });
    const observer = tracing("space-memory-mutation-worker");
    const runningWorker = await createWorker(taskQueue, observer, mutationBundle, {
      async executePersistedMemoryChangeSet() { return mutationResult; }
    });
    expect(await runningWorker.runUntil(() => environment.client.workflow.execute("memoryMutationWorkflow", {
      taskQueue, workflowId: taskQueue, workflowExecutionTimeout: "30s",
      args: [{ changeSetId, traceId: "req:production-mutation" }], memo: { traceparent }
    }))).toEqual(mutationResult);
    await closeTracing();
    const recorded = spans();
    const workflow = only(recorded, span => !span.values.activityType);
    const activity = only(recorded, span => span.values.activityType === "executePersistedMemoryChangeSet");
    expect(workflow.parentSpanId).toBe(apiSpanId);
    expect(workflow.values.workflowType).toBe("memoryMutationWorkflow");
    expect(activity.parentSpanId).toBe(workflow.spanId);
    expect(workflow.traceId).toBe(traceId);
    expect(activity.traceId).toBe(traceId);
    expect(recorded).toHaveLength(2);
  }, 30_000);
});
