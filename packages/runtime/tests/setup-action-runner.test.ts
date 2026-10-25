import { describe, expect, it } from "vitest";
import type { SetupAvailability, SetupFeatureId, SetupTask } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";
import { SetupExecutionCoordinator } from "../src/setup-execution.js";
import { SetupActionRunner, type SetupActionAdapter } from "../src/setup-action-runner.js";

const ownerId = "user:setup-runner";
const availability = new Proxy({}, { get: () => "AVAILABLE" }) as Record<SetupFeatureId, SetupAvailability>;
const choices: SetupFeatureId[] = [
  "agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"
];
const receipt = { checkVersion: "check:v1", subjectFingerprint: "a".repeat(64), evidenceRef: "proof:task-completed" };

async function fixture() {
  const store = new InMemorySpaceStore();
  let now = Date.parse("2026-10-07T12:00:00.000Z");
  const coordinator = new SetupExecutionCoordinator(store, () => new Date(now));
  const draft = await coordinator.updateDraft(ownerId, null, {
    persona: "everyday", level: "minimal", requestedFeatureIds: choices, connectionChoices: []
  });
  const plan = await coordinator.createPlan(ownerId, draft.revision, availability, {});
  const run = await coordinator.startRun(ownerId, plan.id, plan.planDigest, "request:runner-proof");
  return { coordinator, run, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe("trusted first setup action runner", () => {
  // Review 2026-10-21 #8: a READY run whose checks expired before finish checks only those again, in the same run; work
  // whose effect is still there is not done again.
  it("checks expired results of a ready run again in the same run without repeating completed work", async () => {
    const { coordinator, run, advance } = await fixture();
    const applied = new Set<string>();
    const adapter: SetupActionAdapter = {
      inspect: async (task) => applied.has(task.id) ? { outcome: "VERIFIED", receipt } : { outcome: "NOT_APPLIED", evidenceRef: "proof:not-applied" },
      apply: async (task) => { applied.add(task.id); }
    };
    const runner = new SetupActionRunner(coordinator, () => adapter);
    await runner.pump(ownerId, run.id);
    const ready = await coordinator.getState(ownerId);
    const taskIds = ready.tasks.filter((task) => task.runId === run.id).map((task) => task.id);
    // Still current: nothing to check again.
    await expect(coordinator.revalidateStaleTasks(ownerId, run.id, taskIds, ready.runs[0]!.revision))
      .rejects.toMatchObject({ code: "SETUP_RETRY_SCOPE_INVALID" });
    advance(15 * 60_000);
    await expect(coordinator.revalidateStaleTasks(ownerId, run.id, taskIds, ready.runs[0]!.revision - 1))
      .rejects.toMatchObject({ code: "SETUP_REVISION_CONFLICT" });
    await coordinator.revalidateStaleTasks(ownerId, run.id, taskIds, ready.runs[0]!.revision);
    const queued = await coordinator.getState(ownerId);
    expect(queued.runs[0]!.id).toBe(run.id);
    expect(queued.runs[0]!.status).toBe("RUNNING");
    expect(queued.receipts).toHaveLength(0);
    // Only a READY run checks again; a running or failed one goes through its own steps and retries.
    await expect(coordinator.revalidateStaleTasks(ownerId, run.id, taskIds, queued.runs[0]!.revision))
      .rejects.toMatchObject({ code: "SETUP_RUN_NOT_READY" });
    let applies = 0;
    await new SetupActionRunner(coordinator, () => ({ ...adapter, apply: async (task) => { applies++; applied.add(task.id); } }))
      .pump(ownerId, run.id);
    const again = await coordinator.getState(ownerId);
    expect(again.runs[0]!.status).toBe("READY");
    expect(applies).toBe(0);
    expect(again.receipts).toHaveLength(taskIds.length);
    expect(again.receipts.every((item) => Date.parse(item.expiresAt) > Date.parse("2026-10-07T12:15:00.000Z"))).toBe(true);
    // The renewed results are current again.
    await expect(coordinator.revalidateStaleTasks(ownerId, run.id, taskIds, again.runs[0]!.revision))
      .rejects.toMatchObject({ code: "SETUP_RETRY_SCOPE_INVALID" });
  });

  it("inspects, applies and verifies every selected action before Ready", async () => {
    const { coordinator, run } = await fixture();
    const applied = new Set<string>();
    const adapter: SetupActionAdapter = {
      inspect: async (task) => applied.has(task.id) ? { outcome: "VERIFIED", receipt } : { outcome: "NOT_APPLIED", evidenceRef: "proof:not-applied" },
      apply: async (task) => { applied.add(task.id); }
    };
    const runner = new SetupActionRunner(coordinator, () => adapter);
    await runner.pump(ownerId, run.id);
    const state = await coordinator.getState(ownerId);
    expect(state.runs[0].status).toBe("READY");
    expect(state.tasks.filter((task) => task.runId === run.id)).toHaveLength(applied.size);
    expect(state.receipts).toHaveLength(applied.size);
  });

  it("reuses a verified external action without applying it again", async () => {
    const { coordinator, run } = await fixture();
    let applications = 0;
    const adapter: SetupActionAdapter = {
      inspect: async () => ({ outcome: "VERIFIED", receipt }),
      apply: async () => { applications++; }
    };
    await new SetupActionRunner(coordinator, () => adapter).pump(ownerId, run.id);
    expect(applications).toBe(0);
    expect((await coordinator.getState(ownerId)).runs[0].status).toBe("READY");
  });

  it("fails closed when an adapter cannot inspect reality", async () => {
    const { coordinator, run } = await fixture();
    let applications = 0;
    const adapter: SetupActionAdapter = {
      inspect: async () => ({ outcome: "UNKNOWN" }),
      apply: async () => { applications++; }
    };
    await new SetupActionRunner(coordinator, () => adapter).pump(ownerId, run.id);
    const state = await coordinator.getState(ownerId);
    expect(applications).toBe(0);
    expect(state.runs[0].status).toBe("FAILED");
    expect(state.tasks[0].errorCode).toBe("ACTION_STATE_UNKNOWN");
    expect(state.receipts).toHaveLength(0);
  });

  it("inspects an expired lease before retrying its action", async () => {
    const { coordinator, run, advance } = await fixture();
    const leased = await coordinator.leaseNextTask(ownerId, run.id, "worker:crashed", 1_000);
    expect(leased).not.toBeNull();
    advance(1_100);
    const observations: string[] = [];
    const applied = new Set<string>();
    const adapter: SetupActionAdapter = {
      inspect: async (task: SetupTask) => {
        observations.push(task.id);
        return applied.has(task.id) ? { outcome: "VERIFIED", receipt } : { outcome: "NOT_APPLIED", evidenceRef: "proof:not-applied" };
      },
      apply: async (task) => { applied.add(task.id); }
    };
    await new SetupActionRunner(coordinator, () => adapter).pump(ownerId, run.id);
    expect(observations.filter((id) => id === leased!.id).length).toBeGreaterThanOrEqual(2);
    expect((await coordinator.getState(ownerId)).runs[0].status).toBe("READY");
  });

  it("reconciles a run already marked failed after a process restart", async () => {
    const { coordinator, run, advance } = await fixture();
    await coordinator.leaseNextTask(ownerId, run.id, "worker:crashed", 1_000);
    await coordinator.leaseNextTask(ownerId, run.id, "worker:second-crash", 1_000);
    advance(1_100);
    await coordinator.leaseNextTask(ownerId, run.id, "worker:detect-expiry", 1_000);
    expect((await coordinator.getState(ownerId)).runs[0].status).toBe("FAILED");
    expect((await coordinator.getState(ownerId)).tasks.filter((task) => task.errorCode === "LEASE_EXPIRED_RECONCILE")).toHaveLength(2);
    const applied = new Set<string>();
    const adapter: SetupActionAdapter = {
      inspect: async (task) => applied.has(task.id) ? { outcome: "VERIFIED", receipt } : { outcome: "NOT_APPLIED", evidenceRef: "proof:not-applied" },
      apply: async (task) => { applied.add(task.id); }
    };
    await new SetupActionRunner(coordinator, () => adapter).pump(ownerId, run.id);
    expect((await coordinator.getState(ownerId)).runs[0].status).toBe("READY");
  });
});
