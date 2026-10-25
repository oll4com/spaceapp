import { describe, expect, it } from "vitest";
import { createOtlpSpanExporter, type ServerSpan, type SpanExporter } from "@space/runtime";
import { observeActivityExecution } from "../src/activity-observability.js";
import { workerTracingOptions, workflowTraceSinks } from "../src/worker-tracing.js";
import { traceIdentifiers } from "../src/trace-propagation.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
describe("worker tracing boundaries", () => {
  it("does not install workflow tracing or sinks when export is disabled", () => {
    const options = workerTracingOptions(null);
    expect(options.sinks).toBeUndefined();
    expect(options.interceptors!.workflowModules).toBeUndefined();
    expect(options.interceptors!.activity).toHaveLength(1);
  });

  it("exports only allowlisted identifier keys even when given hostile sink data", () => {
    const recorded: ServerSpan[] = [];
    const exporter = { record: (span: ServerSpan) => { recorded.push(span); } } as SpanExporter;
    const sink = workflowTraceSinks(exporter).spaceTracing.finish;
    expect(sink.callDuringReplay).toBe(false);
    sink.fn({ workflowType: "testWorkflow", workflowId: "workflow:test", runId: "run:test" } as never, {
      traceparent, parentTraceparent: null, previousTraceparent: "https://private.example",
      startedAt: 1000, finishedAt: 1250, outcome: "FAILED", reasonCode: "private error message",
      identifiers: { roomId: "room:test", paneId: "/private/path", prompt: "SECRET", url: "https://private.example", output: "SECRET" }
    });
    expect(Object.keys(recorded[0]!.attributes).sort()).toEqual([
      "space.duration_ms", "space.outcome", "space.roomId", "space.temporal_run_id", "space.workflow_id", "space.workflow_type"
    ]);
    expect(recorded[0]!.links).toBeUndefined();
    expect(JSON.stringify(recorded, (_, value) => typeof value === "bigint" ? String(value) : value)).not.toMatch(/private|SECRET|prompt|output/);
    expect(traceIdentifiers([{ prompt: "SECRET", input: { goalId: "goal:test", url: "https://private.example" } }])).toEqual({ goalId: "goal:test" });
  });

  it("finishes work while the collector is stalled, bounds the queue and times out delivery", async () => {
    let aborted = 0;
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:1", serviceName: "test-worker", batchSize: 1, maxQueue: 2, timeoutMs: 40,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => { aborted++; reject(new Error("timeout")); });
      })
    });
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        await expect(observeActivityExecution({ activityType: "test", activityId: "activity:test", attempt,
          workflowType: "testWorkflow", workflowExecution: { workflowId: "workflow:test", runId: "run:test" },
          currentAttemptScheduledTimestampMs: Date.now()
        }, [], async () => "completed", { spans: exporter, traceparent })).resolves.toBe("completed");
      }
      // Work completed before the pending first HTTP POST was aborted.
      expect(aborted).toBe(0);
      expect(exporter.stats().dropped).toBe(2);
      await exporter.flush();
      expect(exporter.stats()).toEqual({ exported: 0, dropped: 2, failed: 3 });
      expect(aborted).toBe(3);
    } finally { await exporter.close(); }
  });
});
