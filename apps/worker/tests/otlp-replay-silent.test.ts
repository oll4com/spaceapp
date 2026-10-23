// Determinism: tracing does no I/O inside the workflow sandbox, spans leave
// only through the `spaceTracing` sink, and replaying a recorded history emits
// no span at all. Histories come from real runs on a time-skipping server.
import { readFile } from "node:fs/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { WorkflowHistory } from "@temporalio/client";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TASK_QUEUE } from "../src/constants.js";
import { captureWorkerLogs } from "../src/worker-log.js";
import { workerTracingOptions, workflowTracingModulePath } from "../src/worker-tracing.js";
import { runTracedScenarios, turn, type ScenarioIds } from "./support/otlp-scenarios.js";
import { bundlerOptions, startFakeCollector, tracedWorker, runTraced, workerSource, type FakeCollector } from "./support/otlp-temporal.js";

let env: TestWorkflowEnvironment;
let collector: FakeCollector;
let ids: ScenarioIds;
/** Restores worker logging; replaced in beforeAll. */
let restoreLogs: () => void = () => undefined;
const histories: Record<string, WorkflowHistory> = {};
let untracedHistory: WorkflowHistory;

/** An exporter that keeps every recorded span in memory, to count replay output. */
function recordingExporter() {
  const recorded: ServerSpan[] = [];
  const exporter: SpanExporter = {
    record: (span) => { recorded.push(span); },
    flush: async () => undefined,
    close: async () => undefined,
    stats: () => ({ exported: 0, dropped: 0, failed: 0 })
  };
  return { recorded, exporter };
}

beforeAll(async () => {
  restoreLogs = captureWorkerLogs(() => undefined);
  env = await TestWorkflowEnvironment.createTimeSkipping();
  collector = await startFakeCollector();
  ids = await runTracedScenarios(env, { collector, only: ["turnWorkflowId", "maintenanceWorkflowId", "consolidationWorkflowId", "dotGoalWorkflowId"] });
  for (const workflowId of [ids.turnWorkflowId, ids.maintenanceWorkflowId, ids.consolidationWorkflowId, ids.dotGoalWorkflowId]) {
    histories[workflowId] = await env.client.workflow.getHandle(workflowId).fetchHistory();
  }
  // A run recorded with export off (as before this change), to replay with export on.
  const untraced = await tracedWorker(env, { collectorUrl: null, service: "space-worker", taskQueue: DEFAULT_TASK_QUEUE, workflows: "workflows.ts",
    activities: { runCodexAppServerTurn: async () => ({ status: "COMPLETED" }) } });
  const workflowId = "workflow:codex-app-server:untraced";
  await runTraced([{ worker: untraced.worker, spans: { close: async () => undefined } as SpanExporter }], () =>
    env.client.workflow.execute("codexAppServerTurnWorkflow", { taskQueue: DEFAULT_TASK_QUEUE, workflowId, args: [{ ...turn, traceId: "req:untraced0001" }] }));
  untracedHistory = await env.client.workflow.getHandle(workflowId).fetchHistory();
}, 240_000);

afterAll(async () => {
  restoreLogs();
  await collector?.close();
  await env?.teardown();
});

/** The workflow module that runs `workflowId`. */
const workflowsFor = (workflowId: string) => workflowId.startsWith("memory-") ? "memory-maintenance-workflows.ts" : "workflows.ts";

describe("workflow tracing and replay", () => {
  it("emits the live runs' workflow spans once", () => {
    const names = collector.spans().filter((span) => span.name.startsWith("workflow ")).map((span) => span.name).sort();
    expect(names).toEqual([
      "workflow codexAppServerTurnWorkflow",
      "workflow dotGoalWorkflow",
      "workflow dotGoalWorkflow",
      "workflow memoryConsolidationWorkflow",
      "workflow memoryMaintenanceWorkflow"
    ]);
  });

  it("replaying each recorded history emits zero spans", async () => {
    for (const [workflowId, history] of Object.entries(histories)) {
      const { recorded, exporter } = recordingExporter();
      await Worker.runReplayHistory({ workflowsPath: workerSource(workflowsFor(workflowId)), bundlerOptions, ...workerTracingOptions(exporter) }, history, workflowId);
      expect(recorded, workflowId).toEqual([]);
    }
  }, 120_000);

  it("would emit during replay if the sink allowed it, so the zero above is a real check", async () => {
    const { exporter } = recordingExporter();
    const calls: unknown[] = [];
    const options = workerTracingOptions(exporter);
    await Worker.runReplayHistory({
      workflowsPath: workerSource("workflows.ts"),
      bundlerOptions,
      interceptors: options.interceptors,
      sinks: { spaceTracing: { workflowRun: { fn: (_info: unknown, span: unknown) => { calls.push(span); }, callDuringReplay: true } } }
    }, histories[ids.turnWorkflowId]!, ids.turnWorkflowId);
    expect(calls).toHaveLength(1);
  }, 60_000);

  it("replays a history recorded with export off without a determinism error", async () => {
    const { recorded, exporter } = recordingExporter();
    await expect(Worker.runReplayHistory({ workflowsPath: workerSource("workflows.ts"), bundlerOptions, ...workerTracingOptions(exporter) },
      untracedHistory, "workflow:codex-app-server:untraced")).resolves.toBeUndefined();
    expect(recorded).toEqual([]);
  }, 60_000);

  it("does no I/O, reads no clock and draws no random numbers in the sandboxed tracing code", async () => {
    for (const file of [workflowTracingModulePath(), workerSource("workflow-trace-context.ts")]) {
      const source = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/\bDate\b|Math\.random|\bfetch\(|setTimeout|setInterval|\bprocess\.|from "node:|require\(|randomBytes|uuid4|\bconsole\./);
      expect(source, file).not.toMatch(/@space\/runtime|@temporalio\/(client|worker|activity)/);
    }
    const tracing = await readFile(workflowTracingModulePath(), "utf8");
    expect(tracing).toMatch(/proxySinks<WorkflowTracingSinks>\(\)/);
    const sink = await readFile(workerSource("workflow-span-sink.ts"), "utf8");
    expect(sink).toMatch(/callDuringReplay: false/);
  });
});
