import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { otlpSpanExporterFromEnv, type SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { SPAN_ATTRIBUTE_ALLOWLIST, type OtlpSpanSinks } from "../src/otlp-span-context.js";
import { createOtlpSpanSinks } from "../src/otlp-span-sink.js";
import * as activities from "./support/otlp-test-activities.js";
import { startFakeOtlpCollector, type CollectedSpan, type FakeOtlpCollector } from "./support/otlp-test-collector.js";

/**
 * End-to-end proof for workflow-run spans: a real workflow (with a retrying
 * activity and a child workflow, continued as new once) runs in a Temporal
 * test environment against a fake OTLP collector, wired exactly like the
 * production entrypoints (one shared @space/runtime exporter, the activity
 * observability interceptor, the workflow sandbox interceptors and the
 * non-replay sink). No Docker, no AI provider.
 *
 * Span topology under test: the workflow-run span and the activity spans are
 * siblings — both parent to the span the propagated traceparent names — while
 * a child workflow's span nests under its parent run's span, and a
 * continue-as-new run links back to the run it continues.
 *
 * Local/container note: the first run downloads the ephemeral test server;
 * set SPACE_OTEL_TEST_TMPDIR to a roomy directory if /tmp is a small tmpfs.
 */

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const API_SPAN_ID = "0123456789abcdef";
const TRACEPARENT = `00-${TRACE_ID}-${API_SPAN_ID}-01`;

const workflowsPath = fileURLToPath(new URL("./support/otlp-test-workflows.ts", import.meta.url));
const workflowModules = [fileURLToPath(new URL("../src/otlp-workflow-interceptors.ts", import.meta.url))];

describe("OTLP worker/workflow spans (integration)", () => {
  let testEnv: TestWorkflowEnvironment;
  let collector: FakeOtlpCollector;
  let spanExporter: SpanExporter | null;
  let history: Parameters<typeof Worker.runReplayHistory>[1];

  beforeAll(async () => {
    collector = await startFakeOtlpCollector();
    spanExporter = otlpSpanExporterFromEnv({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.url }, "space-worker");
    expect(spanExporter).not.toBeNull();

    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: "default",
      taskQueue: "otlp-span-test",
      workflowsPath,
      activities,
      sinks: createOtlpSpanSinks(spanExporter),
      interceptors: {
        workflowModules,
        activity: [createActivityObservabilityInterceptors({ spans: spanExporter })]
      }
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("otlpTraceProbeWorkflow", {
        taskQueue: "otlp-span-test",
        workflowId: "otlp-probe-workflow",
        args: [{ traceparent: TRACEPARENT, roomId: "room-1", continueOnce: true }],
        memo: { traceparent: TRACEPARENT }
      });
      await expect(handle.result()).resolves.toBe("echo-ok");
      history = await handle.fetchHistory();
    });

    await spanExporter!.flush();
  }, 600_000);

  afterAll(async () => {
    await spanExporter?.close().catch(() => undefined);
    await testEnv?.teardown().catch(() => undefined);
    await collector?.close().catch(() => undefined);
  });

  function spansNamed(name: string): CollectedSpan[] {
    return collector.spans.filter((span) => span.name === name);
  }

  it("exports workflow and activity spans to /v1/traces in a single trace", () => {
    // Two run segments (initial + continue-as-new): per segment one probe
    // workflow span, one child workflow span, two flaky attempts, one echo.
    expect(spansNamed("workflow/otlpTraceProbeWorkflow")).toHaveLength(2);
    expect(spansNamed("workflow/otlpTraceChildWorkflow")).toHaveLength(2);
    expect(spansNamed("activity flakyProbe")).toHaveLength(4);
    expect(spansNamed("activity echoProbe")).toHaveLength(2);
    expect(collector.spans.every((span) => span.traceId === TRACE_ID)).toBe(true);
    expect(collector.spans.every((span) => span.kind === 1)).toBe(true);
  });

  it("parents workflow spans into the tree and activity spans to the propagated span", () => {
    const [firstRun, secondRun] = spansNamed("workflow/otlpTraceProbeWorkflow");
    // The root run's workflow span hangs off the propagated API span; the
    // continue-as-new run is a new root.
    expect(firstRun!.parentSpanId).toBe(API_SPAN_ID);
    expect(secondRun!.parentSpanId).toBeNull();

    for (const runSpan of [firstRun!, secondRun!]) {
      const childSpan = spansNamed("workflow/otlpTraceChildWorkflow").find((span) => span.parentSpanId === runSpan.spanId)!;
      expect(childSpan).toBeDefined();
    }

    // Activity spans parent to the propagated span (the activity
    // observability interceptor reads the traceparent from the activity
    // input), as siblings of the workflow span — never to the workflow span.
    const attempts = spansNamed("activity flakyProbe");
    expect(attempts.every((span) => span.parentSpanId === API_SPAN_ID)).toBe(true);
    expect(attempts.map((span) => span.attributes["space.attempt"]).sort()).toEqual([1, 1, 2, 2]);
    const failed = attempts.filter((span) => span.attributes["space.attempt"] === 1);
    const succeeded = attempts.filter((span) => span.attributes["space.attempt"] === 2);
    expect(failed.every((span) => span.statusCode === 2 && span.attributes["space.outcome"] === "FAILED")).toBe(true);
    expect(succeeded.every((span) => span.statusCode === 0 && span.attributes["space.outcome"] === "COMPLETED")).toBe(true);
    expect(spansNamed("activity echoProbe").every((span) => span.parentSpanId === API_SPAN_ID)).toBe(true);
  });

  it("links the continue-as-new run to the run it continues", () => {
    const [firstRun, secondRun] = spansNamed("workflow/otlpTraceProbeWorkflow");
    expect(secondRun!.links).toEqual([
      expect.objectContaining({
        traceId: TRACE_ID,
        spanId: firstRun!.spanId,
        attributes: expect.objectContaining({ "space.link.type": "continue_as_new" })
      })
    ]);
    expect(firstRun!.attributes["space.outcome"]).toBe("CONTINUED_AS_NEW");
    expect(secondRun!.attributes["space.outcome"]).toBe("COMPLETED");
  });

  it("exports allowlisted attributes only — no prompts, messages or user text", () => {
    for (const span of collector.spans) {
      for (const key of Object.keys(span.attributes)) {
        expect(SPAN_ATTRIBUTE_ALLOWLIST.has(key), `span ${span.name} attribute ${key}`).toBe(true);
      }
      for (const link of span.links) {
        for (const key of Object.keys(link.attributes)) {
          expect(SPAN_ATTRIBUTE_ALLOWLIST.has(key), `link attribute ${key}`).toBe(true);
        }
      }
    }
    const everything = collector.rawBodies.join("\n");
    expect(everything).not.toContain("secret prompt");
    expect(everything).not.toContain("secret message");
  });

  it("emits no spans when the recorded history is replayed", async () => {
    let sinkCalls = 0;
    const countingSinks: import("@temporalio/worker").InjectedSinks<OtlpSpanSinks> = {
      otlp: {
        exportWorkflowSpan: {
          callDuringReplay: false,
          fn: () => { sinkCalls += 1; }
        }
      }
    };
    const spansBefore = collector.spans.length;
    await Worker.runReplayHistory(
      {
        workflowsPath,
        interceptors: { workflowModules },
        sinks: countingSinks
      },
      history
    );
    expect(sinkCalls).toBe(0);
    expect(collector.spans.length).toBe(spansBefore);
  }, 300_000);
});
