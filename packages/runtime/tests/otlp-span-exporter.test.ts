import { afterEach, describe, expect, it, vi } from "vitest";
import * as shared from "@space/observability";
import * as runtime from "../src/otlp-span-exporter.js";
import type { ServerSpan, SpanExporter } from "../src/otlp-span-exporter.js";

const span: ServerSpan = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", parentSpanId: null,
  name: "activity.runTurn", kind: 1, startTimeUnixNano: 1n, endTimeUnixNano: 2n,
  attributes: { "space.attempt": 1 }, error: false,
  links: [{ traceId: "11111111111111111111111111111111", spanId: "2222222222222222" }]
};
const exporters: SpanExporter[] = [];

afterEach(async () => {
  await Promise.all(exporters.splice(0).map(exporter => exporter.close()));
  vi.unstubAllGlobals();
});

describe("runtime OTLP compatibility", () => {
  it("exposes the same transport implementation as the worker package", () => {
    expect(runtime.createOtlpSpanExporter).toBe(shared.createOtlpSpanExporter);
    expect(runtime.otlpSpanExporterFromEnv).toBe(shared.otlpSpanExporterFromEnv);
    expect(runtime.otlpTraceRequest).toBe(shared.otlpTraceRequest);
    expect(runtime.otlpTracesUrl).toBe(shared.otlpTracesUrl);
  });

  it.each(["space-api", "space-worker", "space-memory-maintenance-worker"])("keeps %s as the default scope and supports links and kinds", serviceName => {
    const scope = runtime.otlpTraceRequest([span], serviceName).resourceSpans[0]!.scopeSpans[0]!;
    expect(scope.scope.name).toBe(serviceName);
    expect(scope.spans).toHaveLength(1);
    expect(scope.spans[0]).toMatchObject({ kind: 1, links: span.links });
    expect(runtime.otlpTraceRequest([{ ...span, kind: undefined }], serviceName)
      .resourceSpans[0]!.scopeSpans[0]!.spans[0]!.kind).toBe(2);
  });

  it("keeps the environment factory's service scope and allows an explicit override", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return { ok: true };
    });
    for (const scopeName of [undefined, "custom-worker-scope"]) {
      const exporter = runtime.otlpSpanExporterFromEnv({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" }, "space-worker", scopeName)!;
      exporters.push(exporter);
      exporter.record(span);
      await exporter.flush();
    }
    expect(bodies.map(body => body.resourceSpans[0].scopeSpans[0].scope.name)).toEqual(["space-worker", "custom-worker-scope"]);
  });
});
