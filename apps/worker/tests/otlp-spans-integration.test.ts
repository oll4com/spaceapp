import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  SPAN_ATTRIBUTE_ALLOWLIST,
  spanIdFromRunId
} from "../src/otlp-span-context.js";
import { workerOtlp } from "../src/worker-otlp.js";
import * as probeActivities from "./support/otlp-test-activities.js";
import {
  otlpBackgroundContinuationProbeWorkflow,
  otlpContinueAsNewProbeWorkflow,
  otlpFailingProbeWorkflow,
  otlpTraceProbeWorkflow
} from "./support/otlp-test-workflows.js";
import { startOtlpTestCollector, type OtlpTestCollector } from "./support/otlp-test-collector.js";

const workflowsPath = fileURLToPath(new URL("./support/otlp-test-workflows.ts", import.meta.url));

describe("OTLP worker and workflow spans integration", { timeout: 45_000 }, () => {
  let testEnv: TestWorkflowEnvironment;
  let collector: OtlpTestCollector;

  beforeAll(async () => {
    collector = await startOtlpTestCollector();
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
    await collector?.close();
  });

  it("exports a single trace from API request to workflow, retry attempts, and child workflows", async () => {
    collector.clear();
    const taskQueue = "otlp-tree-test-queue";
    const otlp = workerOtlp("space-worker", {
      SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint
    });

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: probeActivities,
      sinks: otlp.workerOptions.sinks,
      interceptors: otlp.workerOptions.interceptors
    });

    const apiTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const apiParentSpanId = "00f067aa0ba902b7";
    const traceparent = `00-${apiTraceId}-${apiParentSpanId}-01`;

    let rootRunId = "";
    await worker.runUntil(async () => {
      const handle = await testEnv.workflowClient.start(otlpTraceProbeWorkflow, {
        taskQueue,
        workflowId: "trace-tree-root-workflow",
        args: [
          {
            traceparent,
            roomId: "room-abc",
            paneId: "pane-1",
            missionId: "mission-42",
            turnId: "turn-7",
            actionId: "action-99",
            secretPrompt: "PROMPT_SHOULD_NEVER_BE_EXPORTED",
            runChildWorkflow: true
          }
        ]
      });
      rootRunId = handle.firstExecutionRunId;
      const result = await handle.result();
      expect(result.status).toBe("COMPLETED");
    });

    await otlp.spanExporter?.flush();
    // Expected spans:
    // 1. Root workflow span
    // 2. Activity flakyProbe attempt 1 (failed)
    // 3. Activity flakyProbe attempt 2 (completed)
    // 4. Child workflow span
    // 5. Activity echoProbe attempt 1 (completed)
    await collector.waitForSpans(5, 5000);

    // Verify all spans share the exact same API trace ID
    for (const span of collector.spans) {
      expect(span.traceId).toBe(apiTraceId);
      expect(span.kind).toBe(1); // SPAN_KIND_INTERNAL
      expect(span.serviceName).toBe("space-worker");
      expect(span.scopeName).toBe("space-worker");

      // Verify strict allowlist on all spans
      for (const attrKey of Object.keys(span.attributes)) {
        expect(SPAN_ATTRIBUTE_ALLOWLIST.has(attrKey)).toBe(true);
      }
      // Ensure secret prompt or arbitrary text never leaked
      const rawAttrs = JSON.stringify(span.attributes);
      expect(rawAttrs).not.toContain("PROMPT_SHOULD_NEVER_BE_EXPORTED");
    }

    const rootWfSpan = collector.spans.find((s) => s.name === "workflow/otlpTraceProbeWorkflow");
    expect(rootWfSpan).toBeDefined();
    expect(rootWfSpan?.parentSpanId).toBe(apiParentSpanId);
    expect(rootWfSpan?.spanId).toBe(spanIdFromRunId(rootRunId));
    expect(rootWfSpan?.attributes["space.workflow_id"]).toBe("trace-tree-root-workflow");
    expect(rootWfSpan?.attributes["space.outcome"]).toBe("COMPLETED");
    expect(rootWfSpan?.status?.code).toBe(0);

    // Flaky activity attempt 1
    const act1Attempt1 = collector.spans.find(
      (s) => s.name === "activity/flakyProbeActivity" && s.attributes["space.attempt"] === 1
    );
    expect(act1Attempt1).toBeDefined();
    expect(act1Attempt1?.parentSpanId).toBe(rootWfSpan?.spanId);
    expect(act1Attempt1?.attributes["space.outcome"]).toBe("FAILED");
    expect(act1Attempt1?.attributes["space.reason_code"]).toBe("SIMULATED_PROBE_ERROR");
    expect(act1Attempt1?.attributes["space.category"]).toBe("INTERNAL");
    expect(act1Attempt1?.status?.code).toBe(2); // Error

    // Flaky activity attempt 2
    const act1Attempt2 = collector.spans.find(
      (s) => s.name === "activity/flakyProbeActivity" && s.attributes["space.attempt"] === 2
    );
    expect(act1Attempt2).toBeDefined();
    expect(act1Attempt2?.parentSpanId).toBe(rootWfSpan?.spanId);
    expect(act1Attempt2?.attributes["space.outcome"]).toBe("COMPLETED");
    expect(act1Attempt2?.status?.code).toBe(0);

    // Child workflow
    const childWfSpan = collector.spans.find((s) => s.name === "workflow/otlpTraceChildWorkflow");
    expect(childWfSpan).toBeDefined();
    expect(childWfSpan?.parentSpanId).toBe(rootWfSpan?.spanId);
    expect(childWfSpan?.attributes["space.outcome"]).toBe("COMPLETED");

    // Echo activity in child workflow
    const childEchoAct = collector.spans.find((s) => s.name === "activity/echoProbeActivity");
    expect(childEchoAct).toBeDefined();
    expect(childEchoAct?.parentSpanId).toBe(childWfSpan?.spanId);
    expect(childEchoAct?.attributes["space.outcome"]).toBe("COMPLETED");

    await otlp.spanExporter?.close();
  });

  it("links continue-as-new executions and background continuations via OTLP span links", async () => {
    collector.clear();
    const taskQueue = "otlp-links-test-queue";
    const otlp = workerOtlp("space-worker", {
      SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint
    });

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: probeActivities,
      sinks: otlp.workerOptions.sinks,
      interceptors: otlp.workerOptions.interceptors
    });

    const traceId = "11223344556677889900aabbccddeeff";
    const parentId = "aabbccddeeff0011";
    const traceparent = `00-${traceId}-${parentId}-01`;

    let firstRunId = "";
    await worker.runUntil(async () => {
      // 1. Continue-as-new test
      const canHandle = await testEnv.workflowClient.start(otlpContinueAsNewProbeWorkflow, {
        taskQueue,
        workflowId: "continue-as-new-test",
        args: [{ iteration: 1, maxIterations: 2, traceparent }]
      });
      firstRunId = canHandle.firstExecutionRunId;
      await canHandle.result();

      // 2. Background continuation test
      const bgHandle = await testEnv.workflowClient.start(otlpBackgroundContinuationProbeWorkflow, {
        taskQueue,
        workflowId: "background-continuation-test",
        args: [
          {
            roomAgentContinuation: {
              sourceRunId: "source-run-abc-999",
              generation: 2
            },
            traceId: "trace:bg-test-1",
            traceparent: `00-${traceId}-1122334455667788-01`
          }
        ]
      });
      await bgHandle.result();
    });

    await otlp.spanExporter?.flush();
    await collector.waitForSpans(4, 5000);

    // Verify continue-as-new spans
    const canSpans = collector.spans.filter((s) => s.name === "workflow/otlpContinueAsNewProbeWorkflow");
    expect(canSpans.length).toBe(2);

    const firstRunSpan = canSpans.find((s) => s.attributes["space.outcome"] === "CONTINUED_AS_NEW");
    expect(firstRunSpan).toBeDefined();
    expect(firstRunSpan?.parentSpanId).toBe(parentId);

    const secondRunSpan = canSpans.find((s) => s.attributes["space.outcome"] === "COMPLETED");
    expect(secondRunSpan).toBeDefined();
    // Continue-as-new run should not have a parent span, but a span link to the previous run
    expect(secondRunSpan?.parentSpanId).toBeUndefined();
    expect(secondRunSpan?.links).toBeDefined();
    expect(secondRunSpan?.links?.length).toBe(1);
    expect(secondRunSpan?.links?.[0]?.spanId).toBe(spanIdFromRunId(firstRunId));
    expect(secondRunSpan?.links?.[0]?.attributes?.["space.link.type"]).toBe("continue_as_new");

    // Verify background continuation span
    const bgSpan = collector.spans.find((s) => s.name === "workflow/otlpBackgroundContinuationProbeWorkflow");
    expect(bgSpan).toBeDefined();
    expect(bgSpan?.links).toBeDefined();
    const bgLink = bgSpan?.links?.find((l) => l.attributes?.["space.link.type"] === "background_continuation");
    expect(bgLink).toBeDefined();
    expect(bgLink?.attributes?.["space.continuation.source_run_id"]).toBe("source-run-abc-999");
    expect(bgLink?.attributes?.["space.continuation.generation"]).toBe(2);

    await otlp.spanExporter?.close();
  });

  it("emits zero spans on workflow history replay (callDuringReplay: false)", async () => {
    collector.clear();
    const taskQueue = "otlp-replay-test-queue";
    const otlp = workerOtlp("space-worker", {
      SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint
    });

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: probeActivities,
      sinks: otlp.workerOptions.sinks,
      interceptors: otlp.workerOptions.interceptors
    });

    let history: unknown;
    await worker.runUntil(async () => {
      const handle = await testEnv.workflowClient.start(otlpTraceProbeWorkflow, {
        taskQueue,
        workflowId: "replay-silence-workflow",
        args: [{ runChildWorkflow: false }]
      });
      await handle.result();
      history = await handle.fetchHistory();
    });

    await otlp.spanExporter?.flush();
    expect(collector.spans.length).toBeGreaterThan(0);

    // Now replay the history with a new worker and assert ZERO spans are exported
    collector.clear();
    const replayOtlp = workerOtlp("space-worker", {
      SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint
    });

    await Worker.runReplayHistory(
      {
        workflowsPath,
        sinks: replayOtlp.workerOptions.sinks,
        interceptors: replayOtlp.workerOptions.interceptors
      },
      history,
      "replay-silence-workflow"
    );

    await replayOtlp.spanExporter?.flush();
    // Zero spans must have been emitted during history replay!
    expect(collector.spans.length).toBe(0);

    await otlp.spanExporter?.close();
    await replayOtlp.spanExporter?.close();
  });

  it("records failure outcome and reason code on non-retryable workflow failure", async () => {
    collector.clear();
    const taskQueue = "otlp-failure-test-queue";
    const otlp = workerOtlp("space-worker", {
      SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint
    });

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: probeActivities,
      sinks: otlp.workerOptions.sinks,
      interceptors: otlp.workerOptions.interceptors
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.workflowClient.start(otlpFailingProbeWorkflow, {
        taskQueue,
        workflowId: "failing-probe-workflow",
        args: [{ reasonCode: "CUSTOM_FAILURE_CODE" }]
      });
      await expect(handle.result()).rejects.toThrow();
    });

    await otlp.spanExporter?.flush();
    await collector.waitForSpans(1, 5000);

    const failSpan = collector.spans.find((s) => s.name === "workflow/otlpFailingProbeWorkflow");
    expect(failSpan).toBeDefined();
    expect(failSpan?.attributes["space.outcome"]).toBe("FAILED");
    expect(failSpan?.attributes["space.reason_code"]).toBe("CUSTOM_FAILURE_CODE");
    expect(failSpan?.status?.code).toBe(2);

    await otlp.spanExporter?.close();
  });

  it("does nothing when SPACE_OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
    collector.clear();
    const taskQueue = "otlp-disabled-test-queue";
    const otlp = workerOtlp("space-worker", {});
    expect(otlp.spanExporter).toBeNull();

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: probeActivities,
      sinks: otlp.workerOptions.sinks,
      interceptors: otlp.workerOptions.interceptors
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.workflowClient.start(otlpTraceProbeWorkflow, {
        taskQueue,
        workflowId: "disabled-probe-workflow",
        args: [{ runChildWorkflow: false }]
      });
      const result = await handle.result();
      expect(result.status).toBe("COMPLETED");
    });

    expect(collector.spans.length).toBe(0);
  });
});
