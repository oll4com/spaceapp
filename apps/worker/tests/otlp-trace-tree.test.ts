// One connected trace from the API request through each workflow run to every
// activity attempt, with child workflows nested and continuations linked. Real
// production workflows on a Temporal time-skipping test server, stub
// activities, and a fake OTLP/HTTP collector on loopback.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureWorkerLogs } from "../src/worker-log.js";
import { workflowRunSpanId } from "../src/workflow-trace-context.js";
import { apiSpanId, apiTraceId, runTracedScenarios, type ScenarioIds } from "./support/otlp-scenarios.js";
import { attr, startFakeCollector, type CollectedSpan, type FakeCollector } from "./support/otlp-temporal.js";

let env: TestWorkflowEnvironment;
let collector: FakeCollector;
let ids: ScenarioIds;
let spans: CollectedSpan[];
/** Restores worker logging; replaced in beforeAll. */
let restoreLogs: () => void = () => undefined;

beforeAll(async () => {
  restoreLogs = captureWorkerLogs(() => undefined);
  env = await TestWorkflowEnvironment.createTimeSkipping();
  collector = await startFakeCollector();
  ids = await runTracedScenarios(env, { collector });
  spans = collector.spans();
}, 240_000);

afterAll(async () => {
  restoreLogs();
  await collector?.close();
  await env?.teardown();
});

/** Workflow spans exported for `workflowId` (one per run). */
const workflowSpans = (workflowId: string) => spans.filter((span) => span.name.startsWith("workflow ") && attr(span, "space.workflow_id") === workflowId);
/** Spans whose parent is `parent`, in the same trace. */
const childrenOf = (parent: CollectedSpan) => spans.filter((span) => span.traceId === parent.traceId && span.parentSpanId === parent.spanId);
/** The one span in `list`; fails the test otherwise. */
const only = (list: CollectedSpan[]) => {
  expect(list).toHaveLength(1);
  return list[0]!;
};

describe("worker OTLP span tree", () => {
  it("posts every span to <endpoint>/v1/traces from all three worker processes", () => {
    expect(new Set(collector.paths)).toEqual(new Set(["POST /v1/traces"]));
    expect(new Set(spans.map((span) => span.service))).toEqual(new Set(["space-worker", "space-memory-maintenance-worker", "space-memory-mutation-worker"]));
  });

  it("parents the workflow span on the API span and puts one span per activity attempt under it", () => {
    const workflow = only(workflowSpans(ids.turnWorkflowId));
    expect(workflow).toMatchObject({ traceId: apiTraceId, parentSpanId: apiSpanId, name: "workflow codexAppServerTurnWorkflow", kind: 1, service: "space-worker" });
    expect(attr(workflow, "space.outcome")).toBe("COMPLETED");
    expect(attr(workflow, "space.trace_id")).toBe("req:otlpturn0001");

    const attempts = childrenOf(workflow).sort((left, right) => Number(attr(left, "space.attempt")) - Number(attr(right, "space.attempt")));
    expect(attempts.map((span) => [span.name, attr(span, "space.attempt"), attr(span, "space.outcome")])).toEqual([
      ["activity runCodexAppServerTurn", 1, "FAILED"],
      ["activity runCodexAppServerTurn", 2, "COMPLETED"]
    ]);
    expect(attr(attempts[0]!, "space.reason_code")).toBe("CODEX_APP_SERVER_TURN_TIMEOUT");
    expect(attr(attempts[0]!, "space.category")).toBe("TIMEOUT");
    expect(attempts[0]!.status.code).toBe(2);
    expect(attr(attempts[1]!, "space.reason_code")).toBeUndefined();
    expect(new Set(attempts.map((span) => span.spanId)).size).toBe(2);
    // Every span of this request is in the API's trace.
    expect(spans.filter((span) => attr(span, "space.workflow_id") === ids.turnWorkflowId).every((span) => span.traceId === apiTraceId)).toBe(true);
  });

  it("nests the child consolidation workflow under the maintenance run, across all three workers", () => {
    const maintenance = only(workflowSpans(ids.maintenanceWorkflowId));
    expect(maintenance.parentSpanId).toBeUndefined();
    expect(maintenance.service).toBe("space-memory-maintenance-worker");
    const consolidation = only(workflowSpans(ids.consolidationWorkflowId));
    expect(consolidation).toMatchObject({ traceId: maintenance.traceId, parentSpanId: maintenance.spanId });
    expect(attr(consolidation, "space.parent_workflow_id")).toBe(ids.maintenanceWorkflowId);

    expect(childrenOf(maintenance).map((span) => span.name).sort()).toEqual([
      "activity createScheduledMemoryAudit",
      "activity reconcileStaleSpaceAgentSessions",
      "activity refreshAllMonthsMemoryGraphSnapshot",
      "activity refreshMemoryGraphSnapshot",
      "workflow memoryConsolidationWorkflow"
    ]);
    const consolidationChildren = childrenOf(consolidation);
    expect(consolidationChildren.map((span) => `${span.service} ${span.name}`).sort()).toEqual([
      "space-memory-maintenance-worker activity finalizeMemoryRepair",
      "space-memory-maintenance-worker activity prepareMemoryConsolidation",
      "space-memory-mutation-worker activity executePersistedMemoryChangeSet"
    ]);
  });

  it("parents API-started memory mutation and room action workflows on the API span", () => {
    const mutation = only(workflowSpans(ids.mutationWorkflowId));
    expect(mutation).toMatchObject({ traceId: apiTraceId, parentSpanId: apiSpanId, service: "space-memory-mutation-worker" });
    expect(childrenOf(mutation).map((span) => span.name)).toEqual(["activity executePersistedMemoryChangeSet"]);
    const action = only(workflowSpans(ids.actionWorkflowId));
    expect(action).toMatchObject({ traceId: apiTraceId, parentSpanId: apiSpanId, name: "workflow roomAgentActionWorkflow" });
    expect(childrenOf(action).map((span) => span.name)).toEqual(["activity runRoomAgentBackgroundAction"]);
  });

  it("links a continue-as-new run to the run it continues, in the same trace", () => {
    const runs = workflowSpans(ids.dotGoalWorkflowId);
    expect(runs).toHaveLength(2);
    const first = runs.find((span) => attr(span, "space.outcome") === "CONTINUED_AS_NEW")!;
    const second = runs.find((span) => attr(span, "space.outcome") === "COMPLETED")!;
    expect(first).toMatchObject({ traceId: apiTraceId, parentSpanId: apiSpanId });
    expect(second).toMatchObject({ traceId: apiTraceId, parentSpanId: apiSpanId });
    expect(second.spanId).not.toBe(first.spanId);
    expect(second.links).toEqual([{ traceId: apiTraceId, spanId: first.spanId, attributes: [{ key: "space.link", value: { stringValue: "CONTINUE_AS_NEW" } }] }]);
    expect(first.links).toBeUndefined();
    // Activities of each run sit under that run.
    expect(childrenOf(second).map((span) => span.name)).toEqual(["activity dotGoalStep"]);
    expect(childrenOf(first).length).toBeGreaterThan(1);
  });

  it("links a background continuation to the exact turn run it continues", () => {
    const source = only(workflowSpans(ids.turnWorkflowId));
    // The id the continuation derives without asking Temporal is the id the source run exported.
    expect(source.spanId).toBe(workflowRunSpanId({ workflowId: ids.turnWorkflowId }));
    const continuation = only(workflowSpans(ids.continuationWorkflowId));
    expect(continuation).toMatchObject({ traceId: apiTraceId, parentSpanId: apiSpanId });
    expect(continuation.links).toEqual([{ traceId: apiTraceId, spanId: source.spanId, attributes: [{ key: "space.link", value: { stringValue: "BACKGROUND_CONTINUATION" } }] }]);
    expect(attr(continuation, "space.continuation_of_run_id")).toBe("agent_run:otlp-1");
  });
});
