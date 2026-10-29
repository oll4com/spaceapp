import { describe, expect, it } from "vitest";
import type { SetupAvailability, SetupFeatureId } from "@space/contracts";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "../src/index.js";

const ownerId = "user:owner";
const time = "2026-10-07T16:30:00.000Z";
const available = new Proxy({}, { get: () => "AVAILABLE" }) as Record<SetupFeatureId, SetupAvailability>;
const requestedFeatureIds: SetupFeatureId[] = [
  "agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"
];

async function readyStore() {
  const store = new InMemorySpaceStore();
  store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
  const claim = store.claimOwnerSetup({
    tokenHash: "a".repeat(64), email: "owner@example.com", passwordHash: "hash", now: time
  });
  const coordinator = new SetupExecutionCoordinator(store, () => new Date(time));
  const draft = await coordinator.updateDraft(ownerId, null, {
    persona: "everyday", level: "minimal", requestedFeatureIds, connectionChoices: []
  });
  const plan = await coordinator.createPlan(ownerId, draft.revision, available, {});
  const run = await coordinator.startRun(ownerId, plan.id, plan.planDigest, "request:completion");
  const fingerprints: Partial<Record<SetupFeatureId, string>> = {};
  for (let attempt = 0; attempt < plan.actions.length; attempt++) {
    const task = await coordinator.leaseNextTask(ownerId, run.id, "worker:completion", 30_000);
    expect(task).not.toBeNull();
    fingerprints[task!.featureId] = "a".repeat(64);
    await coordinator.completeTask(ownerId, run.id, task!.id, "worker:completion", {
      checkVersion: "check:v1", subjectFingerprint: "a".repeat(64), evidenceRef: `proof:task-${attempt}`
    });
  }
  return { store, coordinator, draft, plan, run, fingerprints, starterRoomId: claim.onboarding.starterRoomId! };
}

describe("atomic first-setup completion", () => {
  it("allows an explicit verified reconfiguration while retaining the original onboarding record", async () => {
    const f = await readyStore();
    const input = { ownerId, expectedStateRevision: (await f.coordinator.getState(ownerId)).revision,
      runId: f.run.id, draftRevision: f.draft.revision, planDigest: f.plan.planDigest,
      currentFingerprints: f.fingerprints, completedAt: time };
    const original = f.store.completeSetupExecution(input);
    const draft = await f.coordinator.updateDraft(ownerId, f.draft.revision, {
      persona: "developer", level: "balanced", requestedFeatureIds: [...requestedFeatureIds, "dock:clipboard"], connectionChoices: []
    });
    const plan = await f.coordinator.createPlan(ownerId, draft.revision, available, {});
    const run = await f.coordinator.startRun(ownerId, plan.id, plan.planDigest, "request:reconfigure");
    for (let i = 0; i < plan.actions.length; i++) {
      const task = await f.coordinator.leaseNextTask(ownerId, run.id, "worker:completion", 30_000);
      await f.coordinator.completeTask(ownerId, run.id, task!.id, "worker:completion", {
        checkVersion: "check:v1", subjectFingerprint: "a".repeat(64), evidenceRef: `proof:reconfiguration-${i}`
      });
    }
    const finished = f.store.completeSetupExecution({ ...input,
      expectedStateRevision: (await f.coordinator.getState(ownerId)).revision, runId: run.id,
      draftRevision: draft.revision, planDigest: plan.planDigest,
      currentFingerprints: { ...f.fingerprints, "dock:clipboard": "a".repeat(64) }, reconfigure: true
    });
    expect(finished).toEqual(original);
    expect((await f.coordinator.getState(ownerId)).completion?.runId).toBe(run.id);
  });

  it("records completion with onboarding only for the latest state and all current receipts", async () => {
    const { store, coordinator, draft, plan, run, fingerprints, starterRoomId } = await readyStore();
    const before = await coordinator.getState(ownerId);
    expect((await coordinator.checkReadiness(ownerId, run.id, fingerprints)).ready).toBe(true);
    const finished = await store.completeSetupExecution({
      ownerId, expectedStateRevision: before.revision, runId: run.id,
      draftRevision: draft.revision, planDigest: plan.planDigest,
      currentFingerprints: fingerprints, completedAt: time
    });
    expect(finished).toMatchObject({ onboardingVersion: 2, isComplete: true, starterRoomId, completedAt: time });
    expect((await coordinator.getState(ownerId)).completion).toMatchObject({ runId: run.id, planDigest: plan.planDigest });
    expect(() => store.completeSetupExecution({
      ownerId, expectedStateRevision: before.revision, runId: run.id,
      draftRevision: draft.revision, planDigest: plan.planDigest,
      currentFingerprints: fingerprints, completedAt: time
    })).toThrow(/already complete|revision/i);
  });

  it("rejects a stale finish after another tab changes the draft", async () => {
    const { store, coordinator, draft, plan, run, fingerprints } = await readyStore();
    const before = await coordinator.getState(ownerId);
    await coordinator.updateDraft(ownerId, draft.revision, {
      persona: "creator", level: "balanced", requestedFeatureIds, connectionChoices: []
    });
    expect(() => store.completeSetupExecution({
      ownerId, expectedStateRevision: before.revision, runId: run.id,
      draftRevision: draft.revision, planDigest: plan.planDigest,
      currentFingerprints: fingerprints, completedAt: time
    })).toThrow(/revision|stale|changed/i);
    expect(store.getOwnerOnboarding().isComplete).toBe(false);
  });
});
