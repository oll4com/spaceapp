// CORE-006 (1): retained, synthetic histories; normal runs need no Temporal server.
// Regenerate explicitly on the task-owned Docker infrastructure (never live namespaces):
// node scripts/space-load-gate.mjs -- env SPACE_CAPTURE_REPLAY_HISTORIES=1 npm test -w @space/worker -- tests/workflow-replay.test.ts
// Do not regenerate fixtures to make an incompatible workflow change pass.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { temporal } from "@temporalio/proto";
import { bundleWorkflowCode, NativeConnection, Worker } from "@temporalio/worker";
import { expect, it } from "vitest";
import { disposableTemporalUnavailableReason, startDisposableTemporal } from "./support/disposable-temporal.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const fixtureDir = path.join(here, "fixtures", "workflow-replay");
const modules = [
  { name: "workflows", types: ["roomAgentActionWorkflow", "dotGoalWorkflow", "dummyTurnWorkflow"] },
  { name: "memory-mutation-workflows", types: ["memoryMutationWorkflow"] }
];
const workflowId = (type: string) => `core006-fixture-${type}`;

async function bundle(name: string) {
  return bundleWorkflowCode({
    workflowsPath: path.join(repoRoot, "apps/worker/src", `${name}.ts`),
    // The same source aliases as temporal-replay-check.mjs: bundle this checkout,
    // even when node_modules links point at another worktree's built packages.
    webpackConfigHook: (config) => ({ ...config, resolve: { ...config.resolve,
      alias: { ...config.resolve?.alias, "@space/contracts": path.join(repoRoot, "packages/contracts/src") } } })
  });
}

async function capture(bundles: Map<string, Awaited<ReturnType<typeof bundle>>>) {
  const unavailable = disposableTemporalUnavailableReason();
  if (unavailable) throw new Error(unavailable); // Capture must execute, never silently skip.
  const infra = await startDisposableTemporal("replay-history", "space-replay-fixtures");
  let connection: Connection | undefined;
  let native: NativeConnection | undefined;
  const calls: string[] = [];
  let steps = 0;
  const request = { toolId: "room:inspect", action: { type: "inspect" } };
  const actionResult = { id: "space-agent-room-action-bridge", results: [
    { request, status: "EXECUTED", statusReason: "Synthetic replay fixture", paneId: null, missionId: null, evidence: {} }
  ] };
  const turn = { roomId: "room:replay0001", paneId: "pane:replay0001", prompt: "Synthetic replay fixture",
    artifactIds: [], traceId: "req:replay0001", permissionMode: null, collaborationMode: "default" };
  const turnResult = { workflowId: workflowId("dummyTurnWorkflow"), roomId: turn.roomId, paneId: turn.paneId,
    traceId: turn.traceId, status: "COMPLETED", message: "Synthetic replay fixture completed" };
  const mutation = { changeSetId: "memory_change:replay0001", traceId: "req:replay0001" };
  const mutationResult = { status: "APPLIED", changeSetId: mutation.changeSetId, resultingSourceHash: "a".repeat(64), reason: null };
  const cases: Record<string, { input: unknown; result: unknown }> = {
    roomAgentActionWorkflow: { input: { actionId: "room_action:replay0001", traceId: "req:replay0001", bridge: {
      roomId: turn.roomId, missionId: "mission:replay0001", agentPaneId: turn.paneId,
      agentSessionId: "session:replay0001", selectedToolIds: ["room:inspect"], actions: [request]
    } }, result: actionResult },
    dotGoalWorkflow: { input: { goalId: "dot_goal:replay0001" }, result: { goalStatus: "COMPLETED" } },
    dummyTurnWorkflow: { input: turn, result: turnResult },
    memoryMutationWorkflow: { input: mutation, result: mutationResult }
  };
  // Only stubs are registered: no API, filesystem mutation or provider activity is imported.
  const activities = {
    runRoomAgentBackgroundAction: async () => { calls.push("action"); return actionResult; },
    dotGoalStep: async () => { calls.push("step"); return ++steps === 1
      ? { state: "STARTED", runId: "run:replay0001", goalStatus: "RUNNING" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" }; },
    dotGoalObserve: async () => { calls.push("observe"); return { run: "COMPLETED", goalStatus: "COMPLETED" }; },
    recordDummyTurnStarted: async () => { calls.push("turn-start"); return { workflowId: workflowId("dummyTurnWorkflow") }; },
    recordDummyTurnCompleted: async () => { calls.push("turn-complete"); return turnResult; },
    executePersistedMemoryChangeSet: async () => { calls.push("mutation"); return mutationResult; }
  };
  try {
    connection = await Connection.connect({ address: infra.temporalAddress });
    native = await NativeConnection.connect({ address: infra.temporalAddress });
    const client = new Client({ connection, namespace: infra.namespace });
    await mkdir(fixtureDir, { recursive: true });
    for (const module of modules) {
      const worker = await Worker.create({ connection: native, namespace: infra.namespace,
        taskQueue: `core006-${module.name}`, workflowBundle: bundles.get(module.name)!, activities });
      await worker.runUntil(async () => {
        for (const type of module.types) {
          const row = cases[type]!;
          const handle = await client.workflow.start(type, { workflowId: workflowId(type),
            taskQueue: `core006-${module.name}`, args: [row.input], workflowExecutionTimeout: "1 minute" });
          expect(await handle.result()).toEqual(row.result);
          const history = await handle.fetchHistory();
          expect(history.events?.at(-1)?.eventType).toBe(temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED);
          const json = temporal.api.history.v1.History.create(history).toJSON();
          await writeFile(path.join(fixtureDir, `${type}.json`), `${JSON.stringify(json, null, 2)}\n`);
          console.info(`[replay fixture] ${type}: ${history.events!.length} events, COMPLETED`);
        }
      });
    }
    expect(calls).toEqual(["action", "step", "observe", "step", "turn-start", "turn-complete", "mutation"]);
  } finally {
    // Both workers stop through runUntil, including failure. Close only owned resources.
    try { await native?.close(); }
    finally {
      try { await connection?.close(); }
      finally { await infra.stop(); }
    }
    console.info(`[replay fixture] cleaned ${infra.network} and ${infra.containers.join(", ")}`);
  }
}

it("replays the four retained CORE-006 histories against current workflow sources without nondeterminism", async () => {
  const bundles = new Map(await Promise.all(modules.map(async ({ name }) => [name, await bundle(name)] as const)));
  if (process.env.SPACE_CAPTURE_REPLAY_HISTORIES === "1") await capture(bundles);
  for (const module of modules) {
    const histories = await Promise.all(module.types.map(async (type) => {
      const history = JSON.parse(await readFile(path.join(fixtureDir, `${type}.json`), "utf8"));
      expect(history.events[0].workflowExecutionStartedEventAttributes.workflowType.name).toBe(type);
      expect(history.events.at(-1).eventType).toBe("EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED");
      if (type === "dotGoalWorkflow") expect(history.events.some((event: { eventType: string }) => event.eventType === "EVENT_TYPE_TIMER_FIRED")).toBe(true);
      // Fixtures use protobufjs JSON (base64 payloads, long/enum strings).
      // Rehydrate with its matching decoder before handing histories to the SDK.
      return { workflowId: workflowId(type), history: temporal.api.history.v1.History.fromObject(history) };
    }));
    const replayed: string[] = [];
    for await (const result of Worker.runReplayHistories({ workflowBundle: bundles.get(module.name)!,
      replayName: `core006-${module.name}` }, histories)) {
      if (result.error) throw result.error;
      replayed.push(result.workflowId);
    }
    expect(replayed).toEqual(module.types.map(workflowId));
  }
}, 600_000);
