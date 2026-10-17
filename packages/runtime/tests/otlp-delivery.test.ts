import { describe, expect, it, vi } from "vitest";
import { createOtlpSpanExporter, otlpTraceRequest, type ServerSpan } from "../src/otlp-span-exporter.js";
const span: ServerSpan = { traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: null,
  name: "test", startTimeUnixNano: 0n, endTimeUnixNano: 1n, attributes: {}, error: false };
describe("best effort OTLP delivery", () => {
  it("still flushes after an empty interval and ignores writes after closing", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const exporter = createOtlpSpanExporter({ endpoint: "http://localhost", serviceName: "test", fetch: send });
    await exporter.flush();
    exporter.record(span);
    await exporter.flush();
    expect(send).toHaveBeenCalledTimes(1);
    await exporter.close();
    exporter.record(span);
    await exporter.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("bounds a transport that ignores its abort signal", async () => {
    const exporter = createOtlpSpanExporter({ endpoint: "http://localhost", serviceName: "test",
      fetch: () => new Promise(() => {}), timeoutMs: 10 });
    exporter.record(span);
    await exporter.close();
    expect(exporter.stats()).toEqual({ exported: 0, failed: 1, dropped: 0 });
  });
  it("exports validated continuation links", () => {
    const body = otlpTraceRequest([{ ...span, links: [{ traceId: span.traceId, spanId: "c".repeat(16) }, { traceId: "bad", spanId: "bad" }] }], "test");
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.links).toEqual([{ traceId: span.traceId, spanId: "c".repeat(16) }]);
  });
});
