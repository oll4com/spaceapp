import { expect, it } from "vitest";
import { createOtlpSpanExporter, type ServerSpan } from "../src/otlp-span-exporter.js";

const span: ServerSpan = {
  traceId: "1".repeat(32), spanId: "2".repeat(16), parentSpanId: null,
  name: "workflow dummyTurnWorkflow", kind: 1, startTimeUnixNano: 1n, endTimeUnixNano: 2n,
  attributes: {}, error: false, links: [{ traceId: "3".repeat(32), spanId: "4".repeat(16) }]
};

it("exports a later span after the collector was flushed while idle", async () => {
  const requests: string[] = [];
  const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "test",
    flushIntervalMs: 60_000, fetch: async (_url, request) => { requests.push(request.body); return { ok: true }; } });
  try {
    await exporter.flush();
    exporter.record(span);
    await exporter.flush();
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!).resourceSpans[0].scopeSpans[0].spans[0].links).toEqual(span.links);
    expect(exporter.stats()).toEqual({ exported: 1, dropped: 0, failed: 0 });
  } finally { await exporter.close(); }
});

it("closes a bounded queue and counts later records as drops", async () => {
  const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "test",
    flushIntervalMs: 60_000, maxQueue: 2, fetch: async () => ({ ok: false }) });
  exporter.record(span); exporter.record(span); exporter.record(span);
  await exporter.close();
  exporter.record(span);
  expect(exporter.stats()).toEqual({ exported: 0, dropped: 2, failed: 2 });
});
