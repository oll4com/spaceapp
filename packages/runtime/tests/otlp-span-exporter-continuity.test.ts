import { describe, expect, it, vi } from "vitest";
import { createOtlpSpanExporter, otlpTraceRequest, type ServerSpan } from "../src/otlp-span-exporter.js";

const span: ServerSpan = {
  traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef", parentSpanId: null,
  name: "workflow example", kind: 1, startTimeUnixNano: 1n, endTimeUnixNano: 2n, attributes: {}, error: false
};

describe("OTLP exporter continuity", () => {
  it("exports after an empty flush and after subsequent idle flushes", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "test", fetch: send });
    try {
      await exporter.flush();
      exporter.record(span);
      await exporter.flush();
      await exporter.flush();
      exporter.record(span);
      await exporter.flush();
      expect(send).toHaveBeenCalledTimes(2);
      expect(exporter.stats().exported).toBe(2);
    } finally { await exporter.close(); }
  });

  it("drains spans recorded during an in-flight request", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await pending; return { ok: true }; });
    const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "test", fetch: send, batchSize: 1 });
    try {
      exporter.record(span);
      await Promise.resolve();
      const first = exporter.flush();
      exporter.record(span);
      release();
      await first;
      expect(exporter.stats().exported).toBe(2);
    } finally { release(); await exporter.close(); }
  });

  it("serializes only bounded valid span-link identifiers", () => {
    const request = otlpTraceRequest([{ ...span, links: [
      { traceId: span.traceId, spanId: span.spanId },
      { traceId: "0".repeat(32), spanId: span.spanId },
      { traceId: "private prompt", spanId: span.spanId }
    ] }], "test");
    expect(request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.links).toEqual([{ traceId: span.traceId, spanId: span.spanId }]);
  });
});
