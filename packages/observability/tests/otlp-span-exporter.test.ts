import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOtlpSpanExporter, otlpSpanExporterFromEnv, otlpTraceRequest, otlpTracesUrl,
  type OtlpSpanExporterOptions, type ServerSpan, type SpanExporter, type SpanLink
} from "../src/index.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "a1b2c3d4e5f60718";
const parentSpanId = "00f067aa0ba902b7";
const endpoint = "http://127.0.0.1:4318/";
const exporters: SpanExporter[] = [];

function span(overrides: Partial<ServerSpan> = {}): ServerSpan {
  return { traceId, spanId, parentSpanId, name: "GET /api/rooms/:roomId",
    startTimeUnixNano: 1_700_000_000_000_000_000n, endTimeUnixNano: 1_700_000_000_250_000_000n,
    attributes: { "http.request.method": "GET", "http.response.status_code": 200 }, error: false, ...overrides };
}

function exporter(options: Partial<OtlpSpanExporterOptions> = {}) {
  const created = createOtlpSpanExporter({ endpoint, serviceName: "space-api", flushIntervalMs: 60_000,
    fetch: async () => ({ ok: true }), ...options });
  exporters.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(exporters.splice(0).map(created => created.close()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared OTLP wire format", () => {
  it("preserves API SERVER defaults and arbitrary attribute conversion", () => {
    const body = otlpTraceRequest([span({ attributes: {
      "http.request.method": "GET", "http.response.status_code": 200,
      "custom.label": "retained", "custom.fraction": 1.25
    } })], "space-api");
    expect(body).toEqual({ resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "space-api" } }] },
      scopeSpans: [{ scope: { name: "space-api" }, spans: [{ traceId, spanId, parentSpanId,
        name: "GET /api/rooms/:roomId", kind: 2,
        startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000250000000",
        attributes: [
          { key: "http.request.method", value: { stringValue: "GET" } },
          { key: "http.response.status_code", value: { intValue: "200" } },
          { key: "custom.label", value: { stringValue: "retained" } },
          { key: "custom.fraction", value: { stringValue: "1.25" } }
        ], status: { code: 0 }
      }] }]
    }] });
  });

  it("emits INTERNAL spans and validated links with an explicit worker scope", () => {
    const valid: SpanLink = { traceId: "11111111111111111111111111111111", spanId: "2222222222222222" };
    const body = otlpTraceRequest([span({ kind: 1, error: true, parentSpanId: null, links: [
      { ...valid, privateAttribute: "must-not-leak" } as SpanLink,
      null as unknown as SpanLink,
      { traceId: "0".repeat(32), spanId }, { traceId, spanId: "0".repeat(16) },
      { traceId: "malformed", spanId }, { traceId, spanId: "ABCDEF0123456789" }
    ] })], "space-worker", "space-worker");
    expect(body.resourceSpans[0]!.resource.attributes[0]!.value.stringValue).toBe("space-worker");
    const scope = body.resourceSpans[0]!.scopeSpans[0]!;
    expect(scope.scope.name).toBe("space-worker");
    expect(scope.spans[0]).toMatchObject({ kind: 1, status: { code: 2 }, links: [valid] });
    expect(scope.spans[0]).not.toHaveProperty("parentSpanId");
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("omits invalid parents and rejects malformed or all-zero primary identifiers", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const created = exporter({ fetch: send });
    for (const invalid of [span({ traceId: "bad" }), span({ traceId: "0".repeat(32) }),
      span({ spanId: "0".repeat(16) }), span({ spanId: "XYZ" }), span({ traceId: traceId.toUpperCase() })]) {
      created.record(invalid);
      expect(otlpTraceRequest([invalid], "space-worker").resourceSpans[0]!.scopeSpans[0]!.spans).toEqual([]);
    }
    await created.flush();
    expect(send).not.toHaveBeenCalled();
    expect(created.stats()).toEqual({ exported: 0, dropped: 0, failed: 0 });
    for (const parent of ["0".repeat(16), "bad", "ABCDEF0123456789"]) {
      expect(otlpTraceRequest([span({ parentSpanId: parent })], "space-api")
        .resourceSpans[0]!.scopeSpans[0]!.spans[0]).not.toHaveProperty("parentSpanId");
    }
  });

  it("keeps export off for absent or unsafe endpoint settings", () => {
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    for (const value of [undefined, "  ", "not a URL", "file:///private", "http://user:secret@collector:4318", "https://collector/?secret=x", "http://collector/#fragment"]) {
      expect(otlpTracesUrl(value)).toBeNull();
      expect(otlpSpanExporterFromEnv({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: value }, "space-worker", "space-worker")).toBeNull();
    }
    expect(send).not.toHaveBeenCalled();
    expect(otlpTracesUrl("https://collector.example/base//")).toBe("https://collector.example/base/v1/traces");
    expect(() => createOtlpSpanExporter({ endpoint: "invalid", serviceName: "space-api" })).toThrow("Invalid OTLP endpoint");
  });

  it("configures service and instrumentation scope through the environment factory", async () => {
    const send = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));
    vi.stubGlobal("fetch", send);
    const created = otlpSpanExporterFromEnv({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }, "space-worker", "worker-interceptors")!;
    exporters.push(created);
    created.record(span({ kind: 1 }));
    await created.flush();
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4318/v1/traces");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body.resourceSpans[0].scopeSpans[0].scope.name).toBe("worker-interceptors");
    expect(body.resourceSpans[0].resource.attributes[0].value.stringValue).toBe("space-worker");
  });
});

describe("bounded best-effort delivery", () => {
  it("drops and counts queue overflow without scheduling extra deliveries", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const created = exporter({ fetch: send, maxQueue: 2, batchSize: 100 });
    for (let index = 0; index < 5; index++) created.record(span());
    await created.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(created.stats()).toEqual({ exported: 2, dropped: 3, failed: 0 });
  });

  it("starts full batches immediately and flushes the remainder on close", async () => {
    const sizes: number[] = [];
    const created = exporter({ batchSize: 2, fetch: async (_url, init) => {
      sizes.push(JSON.parse(init.body).resourceSpans[0].scopeSpans[0].spans.length);
      return { ok: true };
    } });
    created.record(span()); created.record(span()); created.record(span());
    await created.close();
    expect(sizes).toEqual([2, 1]);
    expect(created.stats()).toEqual({ exported: 3, dropped: 0, failed: 0 });
  });

  it("does not await a collector on record and keeps the waiting queue bounded", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const created = exporter({ batchSize: 1, maxQueue: 2, fetch: async () => {
      calls++;
      if (calls === 1) await gate;
      return { ok: true };
    } });
    expect(created.record(span())).toBeUndefined();
    expect(calls).toBe(1);
    created.record(span()); created.record(span()); created.record(span());
    expect(created.stats()).toEqual({ exported: 0, dropped: 1, failed: 0 });
    release();
    await created.flush();
    expect(created.stats()).toEqual({ exported: 3, dropped: 1, failed: 0 });
  });

  it.each(["rejected", "unreachable", "synchronous throw"])("isolates a %s collector failure", async (failure) => {
    const created = exporter({ fetch: () => {
      if (failure === "synchronous throw") throw new Error("transport setup failed");
      return failure === "unreachable" ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve({ ok: false });
    } });
    expect(() => created.record(span())).not.toThrow();
    await expect(created.flush()).resolves.toBeUndefined();
    expect(created.stats()).toEqual({ exported: 0, dropped: 0, failed: 1 });
  });

  it("bounds close and aborts a hung transport even when it ignores cancellation", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const created = exporter({ timeoutMs: 25, fetch: async (_url, init) => {
      signal = init.signal;
      return new Promise<{ ok: boolean }>(() => undefined);
    } });
    created.record(span());
    const closed = created.close();
    await vi.advanceTimersByTimeAsync(24);
    expect(signal.aborted).toBe(false);
    expect(created.stats().failed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(closed).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect(created.stats()).toEqual({ exported: 0, dropped: 0, failed: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exports records arriving after an empty flush or an idle interval", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ ok: true }));
    const created = exporter({ fetch: send, flushIntervalMs: 10 });
    await created.flush();
    await vi.advanceTimersByTimeAsync(10);
    created.record(span());
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(1);
    expect(created.stats().exported).toBe(1);
    await created.close();
    created.record(span());
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);
    expect(created.stats().dropped).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["batchSize", "maxQueue", "timeoutMs", "flushIntervalMs"] as const)("rejects invalid %s limits before starting timers", (option) => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createOtlpSpanExporter({ endpoint, serviceName: "space-api", [option]: value })).toThrow(RangeError);
    }
  });
});
