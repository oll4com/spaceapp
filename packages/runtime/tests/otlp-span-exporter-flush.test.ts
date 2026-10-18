import { describe, expect, it } from "vitest";
import { createOtlpSpanExporter, type ServerSpan } from "../src/otlp-span-exporter.js";

const traceId = "0123456789abcdef0123456789abcdef";

const span = (spanId: string): ServerSpan => ({
  traceId,
  spanId,
  parentSpanId: null,
  name: "activity runCodexAppServerTurn",
  startTimeUnixNano: 1_000_000_000n,
  endTimeUnixNano: 2_000_000_000n,
  attributes: { "space.activity_type": "runCodexAppServerTurn" },
  error: false,
  kind: 1
});

describe("OTLP span exporter flush lifecycle", () => {
  it("keeps exporting after an idle flush finds an empty queue", async () => {
    const bodies: string[] = [];
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:4318",
      serviceName: "space-worker",
      fetch: async (_url, init) => {
        bodies.push(init.body);
        return { ok: true };
      }
    });
    // An idle flush resolves immediately; it must not leave the exporter in a
    // state where later flushes become no-ops.
    await exporter.flush();
    exporter.record(span("1111111111111111"));
    await exporter.flush();
    expect(bodies).toHaveLength(1);
    await exporter.close();
  });

  it("returns a real thenable promise even when an idle flush clears inFlight synchronously", async () => {
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:4318",
      serviceName: "space-worker",
      fetch: async () => ({ ok: true })
    });
    const returned = exporter.flush();
    expect(returned).toBeInstanceOf(Promise);
    let thenResolved = false;
    await returned.then(() => {
      thenResolved = true;
    });
    expect(thenResolved).toBe(true);
    await exporter.close();
  });

  it("drains spans recorded while a flush is already in flight", async () => {
    let releaseFetch: (response: { ok: boolean }) => void = () => {};
    const gate = new Promise<{ ok: boolean }>((resolve) => {
      releaseFetch = resolve;
    });
    const bodies: string[] = [];
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:4318",
      serviceName: "space-worker",
      fetch: async (_url, init) => {
        bodies.push(init.body);
        return gate;
      }
    });
    exporter.record(span("1111111111111111"));
    const first = exporter.flush();
    exporter.record(span("2222222222222222"));
    releaseFetch({ ok: true });
    await first;
    expect(bodies).toHaveLength(2);
    await exporter.close();
  });

  it("exports spans recorded after a closed batch without an intervening idle flush", async () => {
    const bodies: string[] = [];
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:4318",
      serviceName: "space-worker",
      fetch: async (_url, init) => {
        bodies.push(init.body);
        return { ok: true };
      }
    });
    exporter.record(span("1111111111111111"));
    await exporter.flush();
    exporter.record(span("2222222222222222"));
    await exporter.flush();
    await exporter.close();
    expect(bodies).toHaveLength(2);
  });
});
