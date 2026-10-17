import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpObservability } from "../src/observability.js";
import {
  createOtlpSpanExporter,
  otlpSpanExporterFromEnv,
  otlpTracesUrl,
  type ServerSpan,
  type SpanExporter
} from "@space/runtime";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";

function span(overrides: Partial<ServerSpan> = {}): ServerSpan {
  return {
    traceId,
    spanId: "a1b2c3d4e5f60718",
    parentSpanId: parentId,
    name: "GET /api/rooms/:roomId",
    startTimeUnixNano: 1_700_000_000_000_000_000n,
    endTimeUnixNano: 1_700_000_000_250_000_000n,
    attributes: { "http.request.method": "GET", "http.route": "/api/rooms/:roomId", "http.response.status_code": 200 },
    error: false,
    ...overrides
  };
}

const exporters: SpanExporter[] = [];
afterEach(async () => {
  await Promise.all(exporters.splice(0).map(exporter => exporter.close()));
});

function exporter(fetchImpl: ReturnType<typeof vi.fn>, options: { batchSize?: number; maxQueue?: number } = {}) {
  const created = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318/", serviceName: "space-api", fetch: fetchImpl, flushIntervalMs: 60_000, ...options });
  exporters.push(created);
  return created;
}

describe("OTLP span export configuration", () => {
  it("is off unless a plain http(s) collector base URL is configured", () => {
    expect(otlpTracesUrl(undefined)).toBeNull();
    expect(otlpTracesUrl("  ")).toBeNull();
    expect(otlpTracesUrl("ftp://collector:4318")).toBeNull();
    expect(otlpTracesUrl("http://user:secret@collector:4318")).toBeNull();
    expect(otlpTracesUrl("http://collector:4318?token=x")).toBeNull();
    expect(otlpTracesUrl("not a url")).toBeNull();
    expect(otlpTracesUrl("http://127.0.0.1:4318/")).toBe("http://127.0.0.1:4318/v1/traces");
    expect(otlpTracesUrl("https://otel.example/base//")).toBe("https://otel.example/base/v1/traces");
    expect(otlpSpanExporterFromEnv({}, "space-api")).toBeNull();
    expect(otlpSpanExporterFromEnv({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "javascript:alert(1)" }, "space-api")).toBeNull();
  });
});

describe("OTLP span exporter", () => {
  it("posts OTLP/HTTP JSON server spans with only route-level attributes", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const created = exporter(fetchImpl);
    created.record(span());
    created.record(span({ spanId: "1111111111111111", parentSpanId: null, error: true, attributes: { "http.response.status_code": 503 } }));
    await created.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4318/v1/traces");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    const body = JSON.parse(init.body);
    expect(body.resourceSpans[0].resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "space-api" } }]);
    const [first, second] = body.resourceSpans[0].scopeSpans[0].spans;
    expect(first).toEqual({
      traceId,
      spanId: "a1b2c3d4e5f60718",
      parentSpanId: parentId,
      name: "GET /api/rooms/:roomId",
      kind: 2,
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000250000000",
      attributes: [
        { key: "http.request.method", value: { stringValue: "GET" } },
        { key: "http.route", value: { stringValue: "/api/rooms/:roomId" } },
        { key: "http.response.status_code", value: { intValue: "200" } }
      ],
      status: { code: 0 }
    });
    expect(second.parentSpanId).toBeUndefined();
    expect(second.status).toEqual({ code: 2 });
    expect(created.stats()).toEqual({ exported: 2, dropped: 0, failed: 0 });
  });

  it("sends full batches without waiting for the interval and flushes the rest on close", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const created = exporter(fetchImpl, { batchSize: 2 });
    created.record(span({ spanId: "0000000000000001" }));
    created.record(span({ spanId: "0000000000000002" }));
    created.record(span({ spanId: "0000000000000003" }));
    await created.close();
    const sizes = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body).resourceSpans[0].scopeSpans[0].spans.length);
    expect(sizes).toEqual([2, 1]);
    expect(created.stats().exported).toBe(3);
  });

  it("drops and counts spans instead of growing past the queue bound", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const created = exporter(fetchImpl, { batchSize: 100, maxQueue: 2 });
    for (let index = 0; index < 5; index += 1) created.record(span({ spanId: `000000000000000${index + 1}` }));
    await created.flush();
    expect(created.stats()).toEqual({ exported: 2, dropped: 3, failed: 0 });
  });

  it("counts rejected or unreachable deliveries as failed and never throws", async () => {
    const rejecting = exporter(vi.fn(async () => ({ ok: false })));
    rejecting.record(span());
    await expect(rejecting.flush()).resolves.toBeUndefined();
    expect(rejecting.stats()).toEqual({ exported: 0, dropped: 0, failed: 1 });

    const unreachable = exporter(vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    unreachable.record(span());
    await expect(unreachable.flush()).resolves.toBeUndefined();
    expect(unreachable.stats()).toEqual({ exported: 0, dropped: 0, failed: 1 });
  });

  it("ignores spans whose ids are not W3C trace and span ids", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const created = exporter(fetchImpl);
    created.record(span({ traceId: "not-a-trace" }));
    created.record(span({ spanId: "xyz" }));
    await created.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("HTTP observability with span export", () => {
  it("exports one server span per request, continuing an inbound traceparent", async () => {
    const recorded: ServerSpan[] = [];
    const spanExporter: SpanExporter = {
      record: span => void recorded.push(span),
      flush: async () => undefined,
      close: async () => undefined,
      stats: () => ({ exported: recorded.length, dropped: 0, failed: 0 })
    };
    const observability = createHttpObservability({ serviceName: "space-api", spanExporter });
    const app = Fastify();
    app.addHook("onRequest", async request => observability.onRequest(request));
    app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
    app.get("/api/rooms/:roomId", async () => ({ ok: true }));
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/rooms/room:secret-name?filter=private",
        headers: { traceparent: `00-${traceId}-${parentId}-01` }
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
      observability.close();
    }

    expect(recorded).toHaveLength(1);
    const [exported] = recorded;
    expect(exported!.traceId).toBe(traceId);
    expect(exported!.parentSpanId).toBe(parentId);
    expect(exported!.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(exported!.spanId).not.toBe(parentId);
    expect(exported!.name).toBe("GET /api/rooms/:roomId");
    expect(exported!.endTimeUnixNano).toBeGreaterThanOrEqual(exported!.startTimeUnixNano);
    expect(exported!.error).toBe(false);
    expect(Object.keys(exported!.attributes).sort()).toEqual([
      "http.request.method", "http.response.status_code", "http.route", "space.request_id"
    ]);
    // Only the route template leaves the process: no raw path, room id or query.
    expect(JSON.stringify({ name: exported!.name, attributes: exported!.attributes })).not.toMatch(/secret-name|filter|private/);
    expect(observability.renderPrometheus()).toContain('space_otlp_spans_total{outcome="exported"} 1');
  });

  it("adds no span work or metric lines when export is off", () => {
    const observability = createHttpObservability({ serviceName: "space-api", spanExporter: null });
    try {
      expect(observability.renderPrometheus()).not.toContain("space_otlp_spans_total");
    } finally {
      observability.close();
    }
  });
});
