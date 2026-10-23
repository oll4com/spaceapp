import { describe, expect, it, vi } from "vitest";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import type { ServerSpan, SpanExporter } from "@space/runtime";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentId}-01`;

function fakeExporter() {
  const recorded: ServerSpan[] = [];
  const exporter: SpanExporter = {
    record: (span) => recorded.push(span),
    flush: async () => {},
    close: async () => {},
    stats: () => ({ exported: recorded.length, dropped: 0, failed: 0 })
  };
  return { exporter, recorded };
}

function info(attempt = 1) {
  return {
    activityType: "runTurn",
    attempt,
    workflowExecution: { workflowId: "workflow:codex-app-server:room:pane:req:abc", runId: "run-1" },
    workflowType: "codexAppServerTurnWorkflow",
    currentAttemptScheduledTimestampMs: Date.now(),
    activityId: "1"
  };
}

describe("activity observability spans", () => {
  it("records one child span per activity attempt under the propagated traceparent", async () => {
    const { exporter, recorded } = fakeExporter();
    const [factory] = createActivityObservabilityInterceptors({ spans: exporter });
    const interceptor = factory!({} as never);
    const next = vi.fn(async () => "ok");
    await interceptor.execute({ args: [{ traceparent }], info: info(2) } as never, next as never);

    expect(recorded).toHaveLength(1);
    const span = recorded[0]!;
    expect(span.traceId).toBe(traceId);
    expect(span.parentSpanId).toBe(parentId);
    expect(span.name).toBe("activity runTurn");
    expect(span.attributes["temporal.activity.attempt"]).toBe(2);
    expect(span.attributes["space.activity.outcome"]).toBe("COMPLETED");
    expect(span.error).toBe(false);
  });

  it("records no span when the activity has no traceparent", async () => {
    const { exporter, recorded } = fakeExporter();
    const [factory] = createActivityObservabilityInterceptors({ spans: exporter });
    const interceptor = factory!({} as never);
    await interceptor.execute({ args: [{}], info: info() } as never, vi.fn(async () => "ok") as never);
    expect(recorded).toHaveLength(0);
  });
});
