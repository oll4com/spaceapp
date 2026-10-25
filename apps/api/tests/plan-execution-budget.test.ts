import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { InMemorySpaceStore, PlanExecutionConflictError } from "@space/runtime";
import type { CodexAppServerSocketControlService, CodexNativeThread } from "@space/codex-app-server";
import { getApiConfig } from "../src/config.js";
import { validateApiConfiguration } from "../src/config-registry.js";
import { T3EnvValidationError } from "../src/t3-env.js";
import { registerPlanExecutionRoutes } from "../src/plan-execution-routes.js";
import {
  DEFAULT_PLAN_STAGE_MAX_ATTEMPTS, PLAN_STAGE_ATTEMPT_LIMIT, PlanExecutionController
} from "../src/plan-execution-controller.js";

/**
 * Runaway-loop budget for managed plan executions. The native runtime is a
 * deterministic fake: no Codex process, provider or model call is involved.
 */
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const constraint = "Constraint: never modify the production database; use the staging copy only.";
const stages = [
  { id: "one", order: 1, title: "Migrate", modelId: "model-a", reasoningEffort: "high", instructions: "Migrate the schema.", completionCriteria: ["Migration tested"] },
  { id: "two", order: 2, title: "Report", modelId: "model-a", reasoningEffort: "high", instructions: "Write the report.", completionCriteria: ["Report written"] }
];

async function fixture(maxStageAttempts?: number) {
  const store = new InMemorySpaceStore();
  const text = `# Plan\n\n${constraint}`;
  const plan = store.upsertClipboardItem({ ownerUserId: "user:owner", source: "PLAN", minimumModel: "model-a", text, steps: stages });
  const execution = await store.planExecutions.create({ ownerUserId: "user:owner", planId: plan.id, paneId: "pane", sessionId: "session",
    threadId: "thread", cwd: "/project", requestId: "request", snapshot: { text, title: null, stages } }, true);
  const thread: CodexNativeThread = { id: "thread", cwd: "/project", modelId: "model-a", reasoningEffort: "high", status: "idle", activeFlags: [], turns: [] };
  const sent: Parameters<CodexAppServerSocketControlService["startTurn"]>[0][] = [];
  const control: CodexAppServerSocketControlService = {
    listModels: async () => [{ id: "model-a", displayName: "model-a", isDefault: false, defaultReasoningEffort: "high", supportedReasoningEfforts: ["high"] }],
    readThread: async () => structuredClone(thread),
    readThreadSettings: async () => ({ ...thread, isTurnActive: thread.status === "active" }),
    updateThreadSettings: async (input) => { thread.modelId = input.model; thread.reasoningEffort = input.reasoningEffort; },
    interruptTurn: async () => { throw Error("The budget must never interrupt a running turn."); },
    startTurn: async (input) => {
      sent.push(input);
      thread.turns.push({ id: `turn-${sent.length}`, status: "inProgress", clientUserMessageIds: [input.clientUserMessageId], userMessageCount: 1, resultText: null, itemsComplete: true });
      thread.status = "active";
      return { turnId: `turn-${sent.length}`, status: "inProgress" };
    }
  };
  control.startManagedTurn = async (input) => {
    const result = await control.startTurn(input);
    return { ...result, observation: { close: () => {}, read: () => {
      const turn = thread.turns.find((t) => t.id === result.turnId);
      return turn && turn.status !== "inProgress" ? { status: "VERIFIED", selection: { source: "NATIVE_ACCEPTED_TURN_CONFIGURATION",
        modelId: input.model!, reasoningEffort: input.reasoningEffort!, threadId: input.threadId, turnId: result.turnId,
        commandId: input.clientUserMessageId, observedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        transport: "CONTINUOUS_NATIVE_NOTIFICATIONS", providerTelemetry: false } } : { status: "OBSERVING", selection: null };
    } } };
  };
  const published: string[] = [];
  const controller = new PlanExecutionController({ repository: store.planExecutions, resolve: async () => control,
    publish: async (event) => { published.push(event.status); }, ...(maxStageAttempts === undefined ? {} : { maxStageAttempts }) });
  cleanup.push(() => controller.close());
  const read = async () => (await store.planExecutions.get("user:owner", execution.id))!;
  /** A runaway native agent: every turn claims more work remains in the same stage. */
  const closeRunningTurn = (outcome: "CONTINUE" | "COMPLETED" | "FAILED_RETRYABLE", criterion = "Migration tested") => {
    const turn = thread.turns.at(-1);
    if (turn?.status !== "inProgress") return false;
    thread.status = "idle";
    if (outcome === "FAILED_RETRYABLE") Object.assign(turn, { status: "failed", resultText: null, retryableFailure: {} });
    else Object.assign(turn, { status: "completed", resultText: JSON.stringify({ outcome, summary: `Checkpoint after ${turn.id}: staging copy migrated, decision D${sent.length} recorded.`,
      evidence: [{ criterion, result: "command test: passed" }] }) });
    return true;
  };
  return { store, plan, execution, thread, sent, control, controller, read, closeRunningTurn, published };
}

async function drive(f: Awaited<ReturnType<typeof fixture>>, outcome: "CONTINUE" | "FAILED_RETRYABLE", maxTicks = 200) {
  for (let tick = 0; tick < maxTicks; tick++) {
    const current = await f.read();
    if (!["RUNNING", "SWITCHING_MODEL", "RESUMING_STAGE", "WAITING_FOR_INPUT", "WAITING_FOR_MODEL"].includes(current.status)) return current;
    // Model-retry backoff is real time; expire it instead of sleeping.
    if (current.status === "WAITING_FOR_MODEL") await f.store.planExecutions.update(current.ownerUserId, current.id, current.revision, { nextRetryAt: new Date(0).toISOString() });
    await f.controller.tick();
    f.closeRunningTurn(outcome);
  }
  throw new Error("The runaway loop was not stopped.");
}

describe("managed plan stage attempt budget", () => {
  it("stops a stage that returns CONTINUE forever at the configured limit with a terminal code and audit trail", async () => {
    const f = await fixture(3);
    const final = await drive(f, "CONTINUE");
    expect(f.sent).toHaveLength(3);
    expect(final).toMatchObject({ status: "FAILED", errorCode: PLAN_STAGE_ATTEMPT_LIMIT, pendingCommand: null, completedStageIds: [] });
    expect(final.statusReason).toBe("Stage 1 used its limit of 3 native turns without completing. No further turn was sent. Review the stage, then start a new execution.");
    expect(final.attempts.map((attempt) => attempt.status)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    // Durable, published record of the stop; the plan is not marked complete.
    expect(final.events.at(-1)).toMatchObject({ status: "FAILED" });
    expect(f.published.at(-1)).toBe("FAILED");
    expect(f.store.getClipboardItem("user:owner", f.plan.id)).toMatchObject({ isCompleted: false });
    // Every continuation restates the immutable plan constraints and carries the latest checkpoint.
    for (const [index, turn] of f.sent.entries()) {
      expect(turn.prompt).toContain(constraint);
      expect(turn.prompt).toContain("Completion criteria (return each exact criterion with concrete evidence):\nMigration tested");
      if (index > 0) expect(turn.prompt).toContain(`Previous checkpoint: Checkpoint after turn-${index}: staging copy migrated, decision D${index} recorded.`);
    }
    // Terminal: further ticks send nothing and the execution cannot be resumed.
    await f.controller.tick();
    expect(f.sent).toHaveLength(3);
    await expect(f.store.planExecutions.update(final.ownerUserId, final.id, final.revision, { status: "RUNNING" })).rejects.toBeInstanceOf(PlanExecutionConflictError);
  });

  it("counts retryable native failures, so model retries cannot loop without bound", async () => {
    const f = await fixture(4);
    const final = await drive(f, "FAILED_RETRYABLE");
    expect(f.sent).toHaveLength(4);
    expect(final).toMatchObject({ status: "FAILED", errorCode: PLAN_STAGE_ATTEMPT_LIMIT, retryCount: 4 });
    expect(final.attempts.every((attempt) => attempt.status === "FAILED")).toBe(true);
  });

  it("gives each stage its own budget and leaves completed work untouched", async () => {
    const f = await fixture(3);
    await f.controller.tick(); f.closeRunningTurn("CONTINUE");
    await f.controller.tick(); await f.controller.tick(); f.closeRunningTurn("CONTINUE");
    await f.controller.tick(); await f.controller.tick(); f.closeRunningTurn("COMPLETED");
    await f.controller.tick();
    expect(await f.read()).toMatchObject({ status: "RESUMING_STAGE", activeStageIndex: 1, completedStageIds: ["one"] });
    await f.controller.tick(); f.closeRunningTurn("COMPLETED", "Report written");
    await f.controller.tick();
    expect(await f.read()).toMatchObject({ status: "COMPLETED", completedStageIds: ["one", "two"] });
    expect((await f.read()).errorCode ?? null).toBeNull();
    expect(f.sent).toHaveLength(4);
  });

  it("defaults to twenty native turns per stage", async () => {
    expect(DEFAULT_PLAN_STAGE_MAX_ATTEMPTS).toBe(20);
    const f = await fixture();
    const final = await drive(f, "CONTINUE");
    expect(f.sent).toHaveLength(20);
    expect(final).toMatchObject({ status: "FAILED", errorCode: PLAN_STAGE_ATTEMPT_LIMIT });
  }, 60_000); // about 60 controller ticks; slow on a loaded VM

  it("is configured through SPACE_PLAN_STAGE_MAX_ATTEMPTS and the routes pass it to the controller", async () => {
    expect(getApiConfig({}).planStageMaxAttempts).toBe(20);
    expect(getApiConfig({ SPACE_PLAN_STAGE_MAX_ATTEMPTS: "5" }).planStageMaxAttempts).toBe(5);
    expect(() => getApiConfig({ SPACE_PLAN_STAGE_MAX_ATTEMPTS: "0" })).toThrow(T3EnvValidationError);
    expect(() => getApiConfig({ SPACE_PLAN_STAGE_MAX_ATTEMPTS: "1001" })).toThrow(T3EnvValidationError);
    expect(validateApiConfiguration({ SPACE_PLAN_STAGE_MAX_ATTEMPTS: "many" })).toEqual([
      expect.objectContaining({ key: "planStageMaxAttempts", code: "INVALID_INTEGER" })
    ]);
    const f = await fixture(1);
    await f.controller.close();
    const app = Fastify();
    cleanup.push(() => app.close());
    const routed = registerPlanExecutionRoutes(app, { store: f.store, resolve: async () => f.control, publish: async () => {}, intervalMs: 600_000,
      maxStageAttempts: 1, target: async () => ({ paneId: "pane", sessionId: "session", threadId: "thread", cwd: "/project" }),
      assertStartControl: async () => {} });
    cleanup.push(() => routed.close());
    await routed.tick(); f.closeRunningTurn("CONTINUE");
    await routed.tick(); await routed.tick();
    expect(f.sent).toHaveLength(1);
    expect(await f.read()).toMatchObject({ status: "FAILED", errorCode: PLAN_STAGE_ATTEMPT_LIMIT });
  });
});
