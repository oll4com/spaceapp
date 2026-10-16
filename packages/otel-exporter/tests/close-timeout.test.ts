import { describe, expect, it } from "vitest";
import { createOtlpSpanExporter, type ServerSpan } from "../src/otlp-span-exporter.js";

const span = (i: number): ServerSpan => ({
  traceId: "0".repeat(32),
  spanId: i.toString(16).padStart(16, "0"),
  parentSpanId: null,
  name: "test",
  startTimeUnixNano: 1n,
  endTimeUnixNano: 2n,
  attributes: {},
  error: false,
});

const ENDPOINT = "https://collector.example.com";

describe("close() bounded final flush", () => {
  it("resolves within closeTimeoutMs even when flush() never completes", async () => {
    const exporter = createOtlpSpanExporter({
      endpoint: ENDPOINT,
      serviceName: "test",
      // fetch hangs forever: the collector stopped responding
      fetch: () => new Promise(() => {}),
      timeoutMs: 50,
      closeTimeoutMs: 200,
    });
    exporter.record(span(1));
    const started = Date.now();
    await exporter.close();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
  });

  it("still flushes queued spans when the collector is fast", async () => {
    let posts = 0;
    const exporter = createOtlpSpanExporter({
      endpoint: ENDPOINT,
      serviceName: "test",
      fetch: async () => {
        posts += 1;
        return { ok: true };
      },
      batchSize: 256,
      closeTimeoutMs: 5000,
    });
    exporter.record(span(1));
    exporter.record(span(2));
    await exporter.close();
    expect(posts).toBe(1);
    expect(exporter.stats().exported).toBe(2);
  });
});
