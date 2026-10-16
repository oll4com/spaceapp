import { describe, expect, it } from "vitest";
import type { ServerSpan, SpanExporter } from "@space/otel-exporter";
import {
  resolveWorkerSpanExporter,
  WorkerActivitySpanRecorder
} from "../src/otel-span-export.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const secretPrompt = "PRIVATE PROMPT: deploy with token <redacted>";

function fakeExporter(): { exporter: SpanExporter; spans: ServerSpan[] } {
  const spans: ServerSpan[] = [];
  return {
    spans,
    exporter: {
      record: (span) => spans.push(span),
      flush: async () => undefined,
      close: async () => undefined,
      stats: () => ({ exported: spans.length, dropped: 0, failed: 0 })
    }
  };
}

const startInput = (args: readonly unknown[]) => ({
  activityType: "runCodexAppServerTurn",
  activityId: "3",
  workflowType: "codexAppServerTurnWorkflow",
  args,
  startTimeUnixNano: 1_000_000_000n
});

describe("resolveWorkerSpanExporter", () => {
  it("returns null when the endpoint is unset or unsafe", () => {
    expect(resolveWorkerSpanExporter({})).toBeNull();
    expect(resolveWorkerSpanExporter({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://x/y" })).toBeNull();
  });

  it("creates an exporter when the endpoint is set, and closes cleanly", async () => {
    const exporter = resolveWorkerSpanExporter({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" });
    expect(exporter).not.toBeNull();
    await exporter!.close();
  });
});

describe("WorkerActivitySpanRecorder", () => {
  it("records no span when the args carry no valid traceparent", () => {
    const { exporter, spans } = fakeExporter();
    const recorder = new WorkerActivitySpanRecorder(exporter);
    expect(recorder.start(startInput([{ roomId: "room:alpha01" }]))).toBeNull();
    expect(recorder.start(startInput([{ traceparent: "not-a-traceparent" }]))).toBeNull();
    expect(spans).toHaveLength(0);
  });

  it("continues the W3C trace from activity args and exports allowlisted identifiers only", () => {
    const { exporter, spans } = fakeExporter();
    const recorder = new WorkerActivitySpanRecorder(exporter);
    const args = [{
      traceparent,
      roomId: "room:alpha01",
      paneId: "pane:alpha01",
      prompt: secretPrompt,
      password: "hunter2"
    }];
    const open = recorder.start(startInput(args));
    expect(open).not.toBeNull();
    expect(open!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(open!.parentSpanId).toBe("00f067aa0ba902b7");
    expect(open!.spanId).toMatch(/^[0-9a-f]{16}$/);

    recorder.finish(open, {
      endTimeUnixNano: 2_000_000_000n,
      outcome: "COMPLETED",
      reasonCode: null
    });

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("activity.runCodexAppServerTurn");
    expect(span.startTimeUnixNano).toBe(1_000_000_000n);
    expect(span.endTimeUnixNano).toBe(2_000_000_000n);
    expect(span.error).toBe(false);
    expect(span.attributes["roomId"]).toBe("room:alpha01");
    expect(span.attributes["paneId"]).toBe("pane:alpha01");
    expect(span.attributes["activity.id"]).toBe("3");
    expect(span.attributes["temporal.workflow_type"]).toBe("codexAppServerTurnWorkflow");
    expect(span.attributes["prompt"]).toBeUndefined();
    expect(span.attributes["password"]).toBeUndefined();
    expect(JSON.stringify(span.attributes)).not.toContain("hunter2");
  });

  it("marks failed activities as error spans", () => {
    const { exporter, spans } = fakeExporter();
    const recorder = new WorkerActivitySpanRecorder(exporter);
    const open = recorder.start(startInput([{ traceparent }]));
    recorder.finish(open, { endTimeUnixNano: 2_000_000_000n, outcome: "FAILED", reasonCode: "ACTIVITY_TIMEOUT" });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.error).toBe(true);
    expect(spans[0]!.attributes["activity.reason_code"]).toBe("ACTIVITY_TIMEOUT");
  });
});
