import { describe, expect, it } from "vitest";
import { createOtlpSpanExporter, otlpTraceRequest, type ServerSpan } from "../src/otlp-span-exporter.js";

const span: ServerSpan = { traceId: "11111111111111111111111111111111", spanId: "2222222222222222",
  parentSpanId: null, name: "test", startTimeUnixNano: 1n, endTimeUnixNano: 2n, attributes: {}, error: false };

describe("OTLP continuation links and delivery", () => {
  it("keeps delivering after an idle flush", async () => {
    const batches: unknown[] = [];
    const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "test",
      fetch: async (_url, init) => { batches.push(JSON.parse(init.body)); return { ok: true }; }, flushIntervalMs: 60_000 });
    try {
      await exporter.flush();
      exporter.record(span);
      await exporter.flush();
      await exporter.flush();
      exporter.record(span);
      await exporter.flush();
      expect(batches).toHaveLength(2);
      expect(exporter.stats().exported).toBe(2);
    } finally { await exporter.close(); }
  });

  it("serializes only valid link IDs, without copying arbitrary link fields", () => {
    const link = { traceId: "33333333333333333333333333333333", spanId: "4444444444444444", prompt: "PRIVATE" };
    const request = otlpTraceRequest([{ ...span, links: [link, { traceId: "0".repeat(32), spanId: link.spanId }] }], "test");
    expect(request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.links).toEqual([{ traceId: link.traceId, spanId: link.spanId }]);
    expect(JSON.stringify(request)).not.toContain("PRIVATE");
  });
});
