import { describe, expect, it, vi } from "vitest";
import { createOtlpSpanExporter, type ServerSpan } from "../src/otlp-span-exporter.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

function span(index: number): ServerSpan {
  return {
    traceId,
    spanId: index.toString(16).padStart(16, "0"),
    parentSpanId: "00f067aa0ba902b7",
    name: "test workflow",
    startTimeUnixNano: 1_700_000_000_000_000_000n,
    endTimeUnixNano: 1_700_000_000_010_000_000n,
    attributes: { "space.status": "COMPLETED" },
    error: false
  };
}

describe("bounded shared OTLP exporter regression cases", () => {
  it("continues exporting after an empty interval flush", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:4318",
      serviceName: "space-worker",
      fetch: fetchImpl,
      flushIntervalMs: 60000
    });
    try {
      await exporter.flush();
      exporter.record(span(1));
      await exporter.flush();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(exporter.stats()).toEqual({ exported: 1, dropped: 0, failed: 0 });
    } finally {
      await exporter.close();
    }
    exporter.record(span(2));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not drain a large queue through repeated slow failures during close", async () => {
    let finish!: (response: { ok: boolean }) => void;
    const fetchImpl = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finish = resolve; }));
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:4318",
      serviceName: "space-worker",
      fetch: fetchImpl,
      batchSize: 2, maxQueue: 8,
      flushIntervalMs: 60000
    });
    exporter.record(span(1));
    exporter.record(span(2)); // first batch starts
    exporter.record(span(3));
    exporter.record(span(4));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    finish({ ok: false });
    await exporter.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await exporter.close();
    expect(exporter.stats()).toEqual({ exported: 0, dropped: 2, failed: 2 });
  });
});
