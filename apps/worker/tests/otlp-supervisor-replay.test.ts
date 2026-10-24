// A Room Agent supervisor history recorded by the 1.1.6 workflow code (no
// tracing interceptor) through the production API coordinator: one completed
// mission, one stopped while running, one failed child and background polls.
// It must replay on the current workflow code, traced and untraced, and replay
// must export nothing. The JSON is the protobufjs object form of the history.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { temporal } from "@temporalio/proto";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { createWorkerTracing } from "../src/worker-tracing.js";

const workflowInterceptorModule = fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url));
const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));
const historyPath = new URL("./fixtures/histories/room-agent-supervisor-1.1.6.json", import.meta.url);
const workflowId = "room-supervisor:room:replay-fixture";

describe("Room Agent supervisor replay", () => {
  it("replays a 1.1.6 supervisor history on the current code, traced and untraced, without exporting", async () => {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    const history = temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(historyPath, "utf8")));
    const events = history.events ?? [];
    expect(events.filter((event) => event.childWorkflowExecutionFailedEventAttributes)).toHaveLength(1);
    expect(events.filter((event) => event.childWorkflowExecutionCanceledEventAttributes)).toHaveLength(1);
    const recorded: ServerSpan[] = [];
    const spans: SpanExporter = {
      record: (span) => { recorded.push(span); },
      flush: async () => undefined,
      close: async () => undefined,
      stats: () => ({ exported: 0, dropped: 0, failed: 0 })
    };
    const tracing = createWorkerTracing(spans, { workflowInterceptorModule });
    const [traced, untraced] = await Promise.all([
      bundleWorkflowCode({ workflowsPath, workflowInterceptorModules: [workflowInterceptorModule], logger: new DefaultLogger("ERROR") }),
      bundleWorkflowCode({ workflowsPath, logger: new DefaultLogger("ERROR") })
    ]);
    await Worker.runReplayHistory({ workflowBundle: traced, ...tracing, interceptors: { ...tracing.interceptors, workflowModules: [] } }, history, workflowId);
    await Worker.runReplayHistory({ workflowBundle: untraced }, history, workflowId);
    expect(recorded).toEqual([]);
  }, 180_000);
});
