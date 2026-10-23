import { afterEach, describe, expect, it, vi } from "vitest";
import { createOtlpSpanExporter, otlpTraceRequest, type ServerSpan, type SpanExporter } from "../src/otlp-span-exporter.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
/** A valid test span with the given span id. */
const span = (spanId: string, overrides: Partial<ServerSpan> = {}): ServerSpan => ({
  traceId, spanId, parentSpanId: "00f067aa0ba902b7", name: "workflow probe",
  startTimeUnixNano: 1n, endTimeUnixNano: 2n, attributes: { "space.outcome": "COMPLETED" }, error: false, kind: 1, ...overrides
});

const exporters: SpanExporter[] = [];
afterEach(async () => { await Promise.all(exporters.splice(0).map((exporter) => exporter.close())); });
/** An exporter on a fake transport, closed after each test. */
function exporter(fetchImpl: (...args: never[]) => Promise<{ ok: boolean }>, options: { timeoutMs?: number } = {}) {
  const created = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "space-worker", fetch: fetchImpl as never, flushIntervalMs: 60_000, ...options });
  exporters.push(created);
  return created;
}

describe("OTLP exporter delivery", () => {
  it("keeps exporting after a flush found the queue empty (the interval tick of an idle process)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const created = exporter(fetchImpl);
    await created.flush();
    created.record(span("1111111111111111"));
    await created.flush();
    created.record(span("2222222222222222"));
    await created.close();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(created.stats()).toEqual({ exported: 2, failed: 0, dropped: 0 });
  });

  it("sends spans recorded while a POST is in flight when it closes", async () => {
    let release!: () => void;
    const fetchImpl = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { release = () => resolve({ ok: true }); }));
    const created = exporter(fetchImpl);
    created.record(span("1111111111111111"));
    void created.flush();
    created.record(span("2222222222222222"));
    const closing = created.close();
    release();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    release();
    await closing;
    expect(created.stats()).toEqual({ exported: 2, failed: 0, dropped: 0 });
  });

  it("bounds a POST by its timeout even when the transport ignores the abort signal", async () => {
    const fetchImpl = vi.fn(() => new Promise<{ ok: boolean }>(() => undefined));
    const created = exporter(fetchImpl, { timeoutMs: 150 });
    created.record(span("1111111111111111"));
    const started = Date.now();
    await created.flush();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(created.stats()).toEqual({ exported: 0, failed: 1, dropped: 0 });
  });

  it("serialises span links and leaves spans without links unchanged", () => {
    const body = otlpTraceRequest([
      span("1111111111111111", { links: [{ traceId, spanId: "3333333333333333", attributes: { "space.link": "CONTINUE_AS_NEW" } }, { traceId: "bad", spanId: "x" }] }),
      span("2222222222222222")
    ], "space-worker");
    const [linked, plain] = body.resourceSpans[0]!.scopeSpans[0]!.spans as Array<Record<string, unknown>>;
    expect(linked!.links).toEqual([{ traceId, spanId: "3333333333333333", attributes: [{ key: "space.link", value: { stringValue: "CONTINUE_AS_NEW" } }] }]);
    expect(plain).not.toHaveProperty("links");
    expect(Object.keys(plain!)).toEqual(["traceId", "spanId", "parentSpanId", "name", "kind", "startTimeUnixNano", "endTimeUnixNano", "attributes", "status"]);
  });
});
