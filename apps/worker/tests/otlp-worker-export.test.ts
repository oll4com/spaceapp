// Every Temporal worker entry point builds its tracing from
// SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: unset keeps today's behaviour (activity
// records and metrics only, no workflow interceptor), set adds workflow spans.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { otlpSpanExporterFromEnv } from "@space/runtime";
import { describe, expect, it } from "vitest";
import { workerTracingOptions, workflowTracingModulePath } from "../src/worker-tracing.js";

const entries = {
  "worker.ts": /otlpSpanExporterFromEnv\(process\.env, "space-worker"\)/,
  "memory-maintenance-worker.ts": /otlpSpanExporterFromEnv\(process\.env, service\)/,
  "memory-mutation-worker.ts": /otlpSpanExporterFromEnv\(process\.env, service\)/
};

describe("worker OTLP export wiring", () => {
  it("adds no workflow interceptor or sink when export is off", () => {
    expect(otlpSpanExporterFromEnv({}, "space-worker")).toBeNull();
    const options = workerTracingOptions(null);
    expect(options.sinks).toBeUndefined();
    expect(options.interceptors?.workflowModules).toBeUndefined();
    expect(options.interceptors?.activity).toHaveLength(1);
  });

  it("adds the workflow interceptor module and a replay-silent sink when export is on", async () => {
    const spans = otlpSpanExporterFromEnv({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" }, "space-worker");
    expect(spans).not.toBeNull();
    const options = workerTracingOptions(spans);
    expect(options.interceptors?.workflowModules).toEqual([workflowTracingModulePath()]);
    expect(existsSync(workflowTracingModulePath())).toBe(true);
    const sink = (options.sinks as { spaceTracing: { workflowRun: { callDuringReplay: boolean } } }).spaceTracing.workflowRun;
    expect(sink.callDuringReplay).toBe(false);
    expect(options.interceptors?.activity).toHaveLength(1);
    await spans!.close();
  });

  it("wires every worker entry point the same way", async () => {
    for (const [entry, exporter] of Object.entries(entries)) {
      const source = await readFile(new URL(`../src/${entry}`, import.meta.url), "utf8");
      expect(source, entry).toMatch(exporter);
      expect(source, entry).toMatch(/\.\.\.workerTracingOptions\(spans\)/);
      expect(source, entry).not.toMatch(/createActivityObservabilityInterceptors/);
    }
  });

  it("ships the interceptor module in the worker build", async () => {
    const tsconfig = JSON.parse(await readFile(new URL("../tsconfig.json", import.meta.url), "utf8")) as { include?: string[] };
    expect(tsconfig.include).toContain("src/**/*.ts");
  });
});
