import { afterEach, describe, expect, it, vi } from "vitest";
import { createOtlpSpanExporter, type OtlpSpanExporterOptions, type ServerSpan, type SpanExporter } from "../src/otlp-span-exporter.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";

function span(overrides: Partial<ServerSpan> = {}): ServerSpan {
  return {
    traceId,
    spanId: "a1b2c3d4e5f60718",
    parentSpanId: parentId,
    name: "workflow roomAgentMissionWorkflow",
    startTimeUnixNano: 1_700_000_000_000_000_000n,
    endTimeUnixNano: 1_700_000_000_250_000_000n,
    attributes: { "space.outcome": "COMPLETED" },
    error: false,
    kind: 1,
    ...overrides
  };
}

const exporters: SpanExporter[] = [];
afterEach(async () => {
  await Promise.all(exporters.splice(0).map(exporter => exporter.close()));
});

function exporter(fetchImpl: NonNullable<OtlpSpanExporterOptions["fetch"]>) {
  const created = createOtlpSpanExporter({
    endpoint: "http://127.0.0.1:4318/",
    serviceName: "space-worker",
    fetch: fetchImpl,
    flushIntervalMs: 60_000
  });
  exporters.push(created);
  return created;
}

describe("shared OTLP span exporter", () => {
  it("exports causal links as OTLP identifiers and leaves unlinked spans unchanged", async () => {
    const fetchImpl = vi.fn<NonNullable<OtlpSpanExporterOptions["fetch"]>>(async () => ({ ok: true }));
    const created = exporter(fetchImpl);
    const link = { traceId: "11111111111111111111111111111111", spanId: "2222222222222222" };
    created.record(span({ links: [link, { traceId: "private prompt", spanId: parentId },
      { traceId, spanId: "0000000000000000" }] }));
    created.record(span({ links: [] }));
    created.record(span({ links: [{ traceId: "00000000000000000000000000000000", spanId: parentId }] }));
    created.record(span());
    await created.flush();

    const [, init] = fetchImpl.mock.calls[0]!;
    const [linked, empty, invalid, unlinked] = JSON.parse(init.body).resourceSpans[0].scopeSpans[0].spans;
    expect(linked.links).toEqual([link]);
    expect(empty).toEqual(unlinked);
    expect(invalid).toEqual(unlinked);
    expect(unlinked).not.toHaveProperty("links");
    expect(init.body).not.toContain("private prompt");
  });

  it("continues exporting after empty initial and later flushes", async () => {
    const fetchImpl = vi.fn<NonNullable<OtlpSpanExporterOptions["fetch"]>>(async () => ({ ok: true }));
    const created = exporter(fetchImpl);
    await created.flush();
    expect(fetchImpl).not.toHaveBeenCalled();

    created.record(span());
    await created.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(created.stats()).toEqual({ exported: 1, dropped: 0, failed: 0 });

    await created.flush();
    created.record(span({ spanId: "2222222222222222" }));
    await created.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(created.stats()).toEqual({ exported: 2, dropped: 0, failed: 0 });
  });
});
