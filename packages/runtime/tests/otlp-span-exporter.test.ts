import { expect, it, vi } from "vitest";
import { createOtlpSpanExporter, type ServerSpan } from "../src/otlp-span-exporter.js";
const span: ServerSpan = { traceId: "11111111111111112222222222222222", spanId: "1111111111111111", parentSpanId: null,
  name: "workflow", kind: 1, attributes: {}, error: false, startTimeUnixNano: 1n, endTimeUnixNano: 2n };
it("still drains after idle flushes and reports bounded drops during an unresponsive POST", async () => {
  let calls = 0;
  const send = vi.fn((_url, init) => { calls++; return new Promise<{ ok: boolean }>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })); });
  const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "space-worker", fetch: send,
    timeoutMs: 20, flushIntervalMs: 60_000, batchSize: 1, maxQueue: 2 });
  try {
    await exporter.flush(); await exporter.flush();
    exporter.record(span); // in flight
    exporter.record(span); exporter.record(span); exporter.record(span); // two queued, one dropped
    expect(calls).toBe(1); expect(exporter.stats().dropped).toBe(1);
    // record() must not await a collector; timeout eventually releases every batch.
    await exporter.flush(); expect(exporter.stats()).toEqual({ exported: 0, failed: 3, dropped: 1 });
    await exporter.flush(); exporter.record(span); await exporter.flush(); expect(calls).toBe(4);
  } finally { await exporter.close(); }
});
