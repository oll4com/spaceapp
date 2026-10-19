import { describe, expect, it } from "vitest";
import { createOtlpSpanExporter, otlpTraceRequest, type ServerSpan } from "../src/otlp-span-exporter.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

function span(overrides: Partial<ServerSpan> = {}): ServerSpan {
  return {
    traceId,
    spanId: "a1b2c3d4e5f60718",
    parentSpanId: null,
    name: "workflow tracePing",
    startTimeUnixNano: 1_000_000n,
    endTimeUnixNano: 2_000_000n,
    attributes: { "space.workflow_type": "tracePing" },
    error: false,
    kind: 1,
    ...overrides
  };
}

describe("shared OTLP span exporter", () => {
  it("keeps exporting after an empty flush", async () => {
    const bodies: string[] = [];
    const exporter = createOtlpSpanExporter({
      endpoint: "http://collector.invalid:4318",
      serviceName: "space-worker",
      flushIntervalMs: 60_000,
      fetch: async (_url, init) => {
        bodies.push(init.body);
        return { ok: true };
      }
    });

    // The periodic timer flushes an idle queue; that must not poison `inFlight`.
    await exporter.flush();
    exporter.record(span());
    await exporter.flush();

    expect(exporter.stats()).toEqual({ exported: 1, dropped: 0, failed: 0 });
    expect(JSON.parse(bodies[0]).resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
  });

  it("serialises span links for cross-trace continuations", () => {
    const request = otlpTraceRequest([
      span({ links: [{ traceId: "c".repeat(32), spanId: "d".repeat(16) }] })
    ], "space-worker");

    expect(request.resourceSpans[0].scopeSpans[0].spans[0].links).toEqual([
      { traceId: "c".repeat(32), spanId: "d".repeat(16) }
    ]);
  });

  it("omits links when there are none", () => {
    const request = otlpTraceRequest([span()], "space-worker");
    expect(request.resourceSpans[0].scopeSpans[0].spans[0]).not.toHaveProperty("links");
  });
});
