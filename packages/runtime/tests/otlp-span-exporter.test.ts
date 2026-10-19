import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOtlpSpanExporter,
  otlpSpanExporterFromEnv,
  otlpTraceRequest,
  type OtlpSpanExporterOptions,
  type ServerSpan,
  type SpanExporter
} from "../src/otlp-span-exporter.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "a1b2c3d4e5f60718";
const linkedTraceId = "b8b5824c3d8c40f9b248a25e443ec0a2";
const linkedSpanId = "00f067aa0ba902b7";

function span(overrides: Partial<ServerSpan> = {}): ServerSpan {
  return {
    traceId,
    spanId,
    parentSpanId: null,
    name: "workflow.roomAgentSupervisorWorkflow",
    startTimeUnixNano: 1_700_000_000_000_000_000n,
    endTimeUnixNano: 1_700_000_000_250_000_000n,
    attributes: { "temporal.workflow_type": "roomAgentSupervisorWorkflow" },
    error: false,
    ...overrides
  };
}

const exporters: SpanExporter[] = [];

function exporter(options: Partial<OtlpSpanExporterOptions> = {}): SpanExporter {
  const created = createOtlpSpanExporter({
    endpoint: "http://127.0.0.1:4318",
    serviceName: "space-worker",
    fetch: vi.fn(async () => ({ ok: true })),
    flushIntervalMs: 60_000,
    ...options
  });
  exporters.push(created);
  return created;
}

afterEach(async () => {
  const closing = exporters.splice(0).map(created => created.close());
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  await Promise.all(closing);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared OTLP payload", () => {
  it("retains the server kind and service-name scope defaults without adding link fields", () => {
    for (const serviceName of ["space-api", "space-worker"]) {
      const request = otlpTraceRequest([span()], serviceName);
      const scope = request.resourceSpans[0]!.scopeSpans[0]!;
      expect(scope.scope).toEqual({ name: serviceName });
      expect(scope.spans[0]).toMatchObject({ kind: 2, status: { code: 0 } });
      expect(scope.spans[0]).not.toHaveProperty("links");
      expect(scope.spans[0]).not.toHaveProperty("parentSpanId");
    }
  });

  it("exports internal spans, a custom scope and continuation links through HTTP", async () => {
    const send = vi.fn<NonNullable<OtlpSpanExporterOptions["fetch"]>>(async () => ({ ok: true }));
    const created = exporter({ fetch: send, scopeName: "space-worker" });
    created.record(span({
      kind: 1,
      parentSpanId: "1111111111111111",
      links: [{ traceId: linkedTraceId, spanId: linkedSpanId }],
      error: true
    }));
    await created.flush();

    const [, init] = send.mock.calls[0]!;
    const resource = JSON.parse(init.body).resourceSpans[0];
    expect(resource.resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "space-worker" } }]);
    expect(resource.scopeSpans[0].scope).toEqual({ name: "space-worker" });
    expect(resource.scopeSpans[0].spans[0]).toMatchObject({
      traceId,
      spanId,
      parentSpanId: "1111111111111111",
      kind: 1,
      links: [{ traceId: linkedTraceId, spanId: linkedSpanId }],
      status: { code: 2 }
    });
    expect(created.stats()).toEqual({ exported: 1, dropped: 0, failed: 0 });
  });

  it("omits malformed and all-zero link ids without losing the valid enclosing span", () => {
    const links = [
      { traceId: "not-a-trace", spanId: linkedSpanId },
      { traceId: linkedTraceId, spanId: "123" },
      { traceId: linkedTraceId.toUpperCase(), spanId: linkedSpanId },
      { traceId: "0".repeat(32), spanId: linkedSpanId },
      { traceId: linkedTraceId, spanId: "0".repeat(16) },
      { traceId: linkedTraceId, spanId: linkedSpanId, privateData: "must-not-leave" }
    ];
    const request = otlpTraceRequest([span({ kind: 1, links })], "space-worker", "space-worker");
    const exported = request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(exported.traceId).toBe(traceId);
    expect(exported.links).toEqual([{ traceId: linkedTraceId, spanId: linkedSpanId }]);
    expect(JSON.stringify(request)).not.toContain("must-not-leave");
    expect(otlpTraceRequest([span({ links: links.slice(0, 5) })], "space-worker")
      .resourceSpans[0]!.scopeSpans[0]!.spans[0]).not.toHaveProperty("links");
  });

  it("retains the environment helper's service-name scope and permits an explicit override", async () => {
    const send = vi.fn<NonNullable<OtlpSpanExporterOptions["fetch"]>>(async () => ({ ok: true }));
    vi.stubGlobal("fetch", send);
    for (const scopeName of [undefined, "space-worker.activities"]) {
      const created = otlpSpanExporterFromEnv(
        { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" }, "space-worker", scopeName
      )!;
      exporters.push(created);
      created.record(span({ kind: 1 }));
      await created.flush();
      const [, init] = send.mock.calls.at(-1)!;
      expect(JSON.parse(init.body).resourceSpans[0].scopeSpans[0].scope)
        .toEqual({ name: scopeName ?? "space-worker" });
    }
  });
});

describe("best-effort export lifecycle", () => {
  it("still exports after the periodic flush ran while the queue was empty", async () => {
    vi.useFakeTimers();
    const send = vi.fn<NonNullable<OtlpSpanExporterOptions["fetch"]>>(async () => ({ ok: true }));
    const created = exporter({ fetch: send, flushIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(send).not.toHaveBeenCalled();

    created.record(span());
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(1);

    await created.flush();
    created.record(span({ spanId: "1111111111111111" }));
    await created.close();
    expect(send).toHaveBeenCalledTimes(2);
    expect(created.stats()).toEqual({ exported: 2, dropped: 0, failed: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a transport that ignores abort, drains later batches and keeps the pending queue bounded", async () => {
    vi.useFakeTimers();
    let firstSignal: AbortSignal | undefined;
    const send = vi.fn<NonNullable<OtlpSpanExporterOptions["fetch"]>>()
      .mockImplementationOnce((_url, init) => {
        firstSignal = init.signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValue({ ok: true });
    const created = exporter({ fetch: send, batchSize: 1, maxQueue: 2, timeoutMs: 25 });

    // record() remains synchronous, including while the first POST is hung.
    expect(created.record(span())).toBeUndefined();
    for (let index = 1; index <= 3; index += 1) {
      expect(created.record(span({ spanId: `000000000000000${index}` }))).toBeUndefined();
    }
    const flushing = created.flush();
    expect(created.flush()).toBe(flushing);
    expect(created.stats()).toEqual({ exported: 0, dropped: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25);
    await expect(flushing).resolves.toBeUndefined();
    expect(firstSignal?.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    expect(created.stats()).toEqual({ exported: 2, dropped: 1, failed: 1 });
    await created.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not count a late timed-out response as an export or interrupt the next flush", async () => {
    vi.useFakeTimers();
    let settleFirst!: (value: { ok: boolean }) => void;
    const send = vi.fn<NonNullable<OtlpSpanExporterOptions["fetch"]>>()
      .mockImplementationOnce(() => new Promise(resolve => { settleFirst = resolve; }))
      .mockResolvedValue({ ok: true });
    const created = exporter({ fetch: send, timeoutMs: 20 });
    created.record(span());
    const flushing = created.flush();
    await vi.advanceTimersByTimeAsync(20);
    await flushing;
    settleFirst({ ok: true });

    created.record(span({ spanId: "2222222222222222" }));
    await created.flush();
    expect(created.stats()).toEqual({ exported: 1, dropped: 0, failed: 1 });
    const snapshot = created.stats();
    snapshot.failed = 100;
    expect(created.stats().failed).toBe(1);
  });

  it("bounds shutdown by the retained batches even when producers keep recording", async () => {
    vi.useFakeTimers();
    const send = vi.fn<NonNullable<OtlpSpanExporterOptions["fetch"]>>(() => new Promise(() => undefined));
    const created = exporter({ fetch: send, batchSize: 1, maxQueue: 2, timeoutMs: 20 });
    created.record(span());
    created.record(span({ spanId: "1111111111111111" }));
    created.record(span({ spanId: "2222222222222222" }));
    const closing = created.close();

    for (let index = 0; index < 3; index += 1) {
      created.record(span());
      await vi.advanceTimersByTimeAsync(20);
    }
    await expect(closing).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(3);
    expect(created.stats()).toEqual({ exported: 0, dropped: 3, failed: 3 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
