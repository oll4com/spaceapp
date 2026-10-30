import { describe, expect, it } from "vitest";
import { createOtlpSpanExporter, otlpTraceRequest, type ServerSpan } from "../src/otlp-span-exporter.js";

function span(): ServerSpan {
  return {
    traceId: "11111111111111111111111111111111", spanId: "2222222222222222", parentSpanId: null,
    name: "workflow test", startTimeUnixNano: 1n, endTimeUnixNano: 2n,
    attributes: {}, error: false, kind: 1
  };
}

describe("shared OTLP continuation export", () => {
  it("delivers later spans after an empty flush", async () => {
    const sent: string[] = [];
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:4318", serviceName: "test", flushIntervalMs: 60_000,
      fetch: async (_url, options) => { sent.push(options.body); return { ok: true }; }
    });
    try {
      await exporter.flush();
      exporter.record(span());
      await exporter.flush();
      expect(sent).toHaveLength(1);
      expect(exporter.stats().exported).toBe(1);
      await exporter.flush();
      exporter.record({ ...span(), spanId: "3333333333333333" });
      await exporter.flush();
      expect(sent).toHaveLength(2);
      expect(exporter.stats().exported).toBe(2);
    } finally { await exporter.close(); }
  });

  it("serializes only valid causal link identifiers", () => {
    const valid = { traceId: "33333333333333333333333333333333", spanId: "4444444444444444" };
    const request = otlpTraceRequest([{ ...span(), links: [
      { ...valid, ...{ prompt: "PRIVATE-CONTROL" } },
      { ...valid, spanId: "bad" },
      { ...valid, traceId: "0".repeat(32) },
      { ...valid, spanId: "0".repeat(16) }
    ] }], "test");
    expect(request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.links).toEqual([valid]);
    expect(JSON.stringify(request)).not.toContain("PRIVATE-CONTROL");
  });
});
