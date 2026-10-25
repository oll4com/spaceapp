import { describe, expect, it } from "vitest";
import type { SetupAvailability, SetupFeatureId } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";
import { SetupExecutionCoordinator } from "../src/index.js";

const ownerId = "user:setup-owner";
const clock = () => new Date("2026-10-07T12:00:00.000Z");
const available = new Proxy({}, { get: () => "AVAILABLE" }) as Record<SetupFeatureId, SetupAvailability>;
const requestedFeatureIds: SetupFeatureId[] = [
  "agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"
];

async function prepared() {
  const store = new InMemorySpaceStore();
  const setup = new SetupExecutionCoordinator(store, clock);
  const draft = await setup.updateDraft(ownerId, null, {
    persona: "everyday", level: "minimal", requestedFeatureIds, connectionChoices: []
  });
  const plan = await setup.createPlan(ownerId, draft.revision, available, {});
  return { store, setup, draft, plan };
}

describe("durable first-setup coordination", () => {
  it("retains a connection for a selected dependency and rejects unrelated connections", async () => {
    const setup = new SetupExecutionCoordinator(new InMemorySpaceStore(), clock);
    const draft = await setup.updateDraft(ownerId, null, { persona: "creator", level: "full",
      requestedFeatureIds: ["widget:streaming-metrics"],
      connectionChoices: [{ featureId: "dock:streaming", modelId: "authorized-channel" }] });
    const plan = await setup.createPlan(ownerId, draft.revision, available, { "dock:streaming": "a".repeat(64) });
    expect(plan.requestedFeatureIds).toEqual(["widget:streaming-metrics"]);
    expect(plan.effectiveFeatureIds).toEqual(["dock:streaming", "widget:streaming-metrics"]);
    expect(plan.requiredHumanInputs).toEqual([]);
    await expect(setup.updateDraft(ownerId, draft.revision, { persona: "creator", level: "full",
      requestedFeatureIds: ["widget:clock"],
      connectionChoices: [{ featureId: "dock:streaming", modelId: "authorized-channel" }] }))
      .rejects.toMatchObject({ code: "SETUP_UNSELECTED_CONNECTION" });
  });
  it("removes Live human-input blockers only for a server verified current audio subject", async () => {
    const store = new InMemorySpaceStore();
    const setup = new SetupExecutionCoordinator(store, clock);
    const draft = await setup.updateDraft(ownerId, null, { persona: "creator", level: "balanced",
      requestedFeatureIds: [...requestedFeatureIds, "pane:live"], connectionChoices: [
        { featureId: "pane:live", providerId: "local", modelId: "local-qwen3-greek", voiceId: "default" }
      ] });
    const pending = await setup.createPlan(ownerId, draft.revision, available, {});
    expect(pending.requiredHumanInputs.filter(item => item.featureId === "pane:live")).toHaveLength(2);
    const verified = await setup.createPlan(ownerId, draft.revision, available, { "pane:live": "a".repeat(64) });
    expect(verified.requiredHumanInputs.filter(item => item.featureId === "pane:live")).toEqual([]);
    expect(verified.planDigest).not.toBe(pending.planDigest);
  });
  it("asks for Live provider and microphone only when Live is selected", async () => {
    const base = await prepared();
    expect(base.plan.requiredHumanInputs).toEqual([]);
    const store = new InMemorySpaceStore();
    const setup = new SetupExecutionCoordinator(store, clock);
    const draft = await setup.updateDraft(ownerId, null, {
      persona: "creator", level: "full",
      requestedFeatureIds: [...requestedFeatureIds, "pane:live"], connectionChoices: []
    });
    const plan = await setup.createPlan(ownerId, draft.revision, available, {});
    expect(plan.requiredHumanInputs).toEqual(expect.arrayContaining([
      { featureId: "pane:live", kind: "API_CREDENTIAL", reasonCode: "LIVE_PROVIDER_REQUIRED" },
      { featureId: "pane:live", kind: "MICROPHONE", reasonCode: "LIVE_MICROPHONE_CHECK_REQUIRED" }
    ]));
  });
  it("rejects a stale tab without overwriting the latest draft", async () => {
    const { setup, draft } = await prepared();
    const changed = await setup.updateDraft(ownerId, draft.revision, {
      persona: "creator", level: "balanced", requestedFeatureIds, connectionChoices: []
    });
    await expect(setup.updateDraft(ownerId, draft.revision, {
      persona: "developer", level: "full", requestedFeatureIds, connectionChoices: []
    })).rejects.toMatchObject({ code: "SETUP_REVISION_CONFLICT" });
    expect((await setup.getState(ownerId)).draft).toEqual(changed);
  });

  it("creates one immutable dependency plan and one run per idempotency key", async () => {
    const { setup, draft, plan } = await prepared();
    const repeat = await setup.createPlan(ownerId, draft.revision, available, {});
    expect(repeat).toEqual(plan);
    expect(plan.actions.find((action) => action.featureId === "pane:chat")?.dependsOn)
      .toContain(plan.actions.find((action) => action.featureId === "agent:opencode" && action.actionId === "VERIFY_AGENT_TASK")?.id);
    expect(plan.actions.slice(-3).map((action) => action.actionId)).toEqual([
      "APPLY_SETTINGS", "ENSURE_STARTER_ROOM", "WRITE_INSTALLATION_MEMORY"
    ]);
    const first = await setup.startRun(ownerId, plan.id, plan.planDigest, "request:start-1");
    const second = await setup.startRun(ownerId, plan.id, plan.planDigest, "request:start-1");
    expect(second).toEqual(first);
    expect((await setup.getState(ownerId)).runs).toHaveLength(1);
    await expect(setup.startRun(ownerId, plan.id, "0".repeat(64), "request:start-2"))
      .rejects.toMatchObject({ code: "SETUP_PLAN_STALE" });
  });

  it("keeps every selected Full capability behind the settings application barrier", async () => {
    const store = new InMemorySpaceStore();
    const setup = new SetupExecutionCoordinator(store, clock);
    const draft = await setup.updateDraft(ownerId, null, {
      persona: "developer", level: "full",
      requestedFeatureIds: [
        ...requestedFeatureIds,
        "pane:files", "pane:databases", "pane:live", "pane:harness", "pane:vnc",
        "dock:streaming", "widget:streaming-metrics", "dock:media", "pane:youtube",
        "dock:source-control", "dock:cli", "utility:worktrees", "utility:snip",
        "widget:clock", "widget:countdown-timer", "widget:ai-quota",
        "widget:pushup-reminder", "widget:spaceapp-promo", "dock:clipboard", "dock:links",
        "dock:agent-sessions", "pane:browser", "pane:demos", "dock:room-agent",
        "dock:shared-chat", "utility:asteroids", "utility:osk", "utility:system-health"
      ], connectionChoices: []
    });
    const plan = await setup.createPlan(ownerId, draft.revision, available, {});
    expect(plan.actions.at(-3)?.dependsOn).toHaveLength(plan.actions.length - 3);
  });

  it("rejects an older plan after relevant connection evidence changes", async () => {
    const { setup, draft, plan } = await prepared();
    const newer = await setup.createPlan(ownerId, draft.revision, available, { "agent:opencode": "a".repeat(64) });
    expect(newer.planDigest).not.toBe(plan.planDigest);
    await expect(setup.startRun(ownerId, plan.id, plan.planDigest, "request:old-plan"))
      .rejects.toMatchObject({ code: "SETUP_PLAN_STALE" });
  });

  it("can restore an earlier selection as a new immutable plan", async () => {
    const { setup, draft, plan } = await prepared();
    await setup.createPlan(ownerId, draft.revision, available, { "agent:opencode": "a".repeat(64) });
    const restored = await setup.createPlan(ownerId, draft.revision, available, {});
    expect(restored.planDigest).toBe(plan.planDigest);
    expect(restored.id).not.toBe(plan.id);
    expect((await setup.startRun(ownerId, restored.id, restored.planDigest, "request:restored")).planId)
      .toBe(restored.id);
  });

  it("rejects unselected or unhashed connection subjects", async () => {
    const { setup, draft } = await prepared();
    await expect(setup.createPlan(ownerId, draft.revision, available, { "agent:opencode": "sk-private" }))
      .rejects.toMatchObject({ code: "SETUP_INVALID_SUBJECT" });
    await expect(setup.createPlan(ownerId, draft.revision, available, { "pane:live": "a".repeat(64) }))
      .rejects.toMatchObject({ code: "SETUP_INVALID_SUBJECT" });
  });

  // Review 2026-10-21 #9: changing setup again and again never reaches the owner document's schema limits; the completed
  // run, the active run and the latest plan stay.
  it("keeps setup history bounded across many reconfigurations without losing the completed or current work", async () => {
    const { store, setup, plan } = await prepared();
    const completedRun = await setup.startRun(ownerId, plan.id, plan.planDigest, "request:completed");
    await setup.cancelRun(ownerId, completedRun.id);
    const marked = await setup.getState(ownerId);
    expect(await store.compareAndSwapSetupExecutionState(ownerId, marked.revision, { ...marked, revision: marked.revision + 1,
      completion: { runId: completedRun.id, draftRevision: 0, planDigest: plan.planDigest, settingsRevision: 0,
        receiptSetHash: "c".repeat(64), starterRoomId: "room:starter", memoryHandoffRevision: 0, completedAt: clock().toISOString() } })).toBe(true);
    let draft = (await setup.getState(ownerId)).draft!;
    let lastRun = completedRun;
    // A Full selection: the largest task graph per run.
    const full = ["widget:clock", "dock:clipboard", "dock:links", "pane:browser", "pane:files", "pane:youtube"] as SetupFeatureId[];
    for (let index = 0; index < 60; index++) {
      draft = await setup.updateDraft(ownerId, draft.revision, { persona: "everyday", level: "full",
        requestedFeatureIds: index % 2 ? [...requestedFeatureIds, ...full] : [...requestedFeatureIds, ...full.slice(1)], connectionChoices: [] });
      const next = await setup.createPlan(ownerId, draft.revision, available, {});
      lastRun = await setup.startRun(ownerId, next.id, next.planDigest, `request:cycle-${index}`);
      if (index < 59) await setup.cancelRun(ownerId, lastRun.id);
    }
    const state = await setup.getState(ownerId);
    expect(state.plans.length).toBeLessThanOrEqual(10);
    expect(state.runs.length).toBeLessThanOrEqual(6);
    expect(state.runs.map((run) => run.id)).toContain(completedRun.id);
    expect(state.plans.map((item) => item.id)).toContain(plan.id);
    expect(state.runs.at(-1)).toMatchObject({ id: lastRun.id, status: "RUNNING" });
    expect(state.plans.at(-1)!.id).toBe(lastRun.planId);
    expect(state.tasks.every((task) => state.runs.some((run) => run.id === task.runId))).toBe(true);
    expect(state.tasks.filter((task) => task.runId === completedRun.id)).toHaveLength(plan.actions.length);
    expect(state.runIdempotency.map((entry) => entry.key)).toContain("request:cycle-59");
    expect(await setup.leaseNextTask(ownerId, lastRun.id, "worker:one", 30_000)).not.toBeNull();
  }, 30_000);

  it("replays bounded run events by cursor", async () => {
    const { setup, plan } = await prepared();
    const run = await setup.startRun(ownerId, plan.id, plan.planDigest, "request:events");
    const task = await setup.leaseNextTask(ownerId, run.id, "worker:one", 30_000);
    await setup.failTask(ownerId, run.id, task!.id, "worker:one", "SERVICE_UNAVAILABLE");
    expect((await setup.listRunEvents(ownerId, run.id, 0, 1)).map((item) => item.sequence)).toEqual([1]);
    expect((await setup.listRunEvents(ownerId, run.id, 1, 10)).map((item) => item.sequence)).toEqual([2]);
    await expect(setup.listRunEvents(ownerId, run.id, -1, 10))
      .rejects.toMatchObject({ code: "SETUP_EVENT_CURSOR_INVALID" });
  });

  it("requires reconciliation after an expired lease and never automatically reapplies", async () => {
    const { store, setup, plan } = await prepared();
    const run = await setup.startRun(ownerId, plan.id, plan.planDigest, "request:start-1");
    const leased = await setup.leaseNextTask(ownerId, run.id, "worker:one", 30_000);
    expect(leased?.status).toBe("INSTALLING");
    const restarted = new SetupExecutionCoordinator(store, () => new Date("2026-10-07T12:01:00.000Z"));
    expect(await restarted.leaseNextTask(ownerId, run.id, "worker:two", 30_000)).toBeNull();
    expect((await restarted.getState(ownerId)).tasks.find((task) => task.id === leased?.id))
      .toMatchObject({ status: "NEEDS_ATTENTION", errorCode: "LEASE_EXPIRED_RECONCILE" });
    const failed = await restarted.getState(ownerId);
    await expect(restarted.retryFailedTasks(ownerId, run.id, [leased!.id], failed.runs[0]!.revision))
      .rejects.toMatchObject({ code: "SETUP_RECONCILIATION_REQUIRED" });
    await restarted.reconcileExpiredTask(ownerId, run.id, leased!.id, async () => ({
      outcome: "NOT_APPLIED", evidenceRef: "proof:inspection-1"
    }));
    expect((await restarted.getState(ownerId)).tasks.find((task) => task.id === leased?.id)?.status).toBe("QUEUED");
  });

  it("leases at most one heavy installation and two independent checks", async () => {
    const { setup, plan } = await prepared();
    const run = await setup.startRun(ownerId, plan.id, plan.planDigest, "request:limits");
    expect((await setup.leaseNextTask(ownerId, run.id, "worker:one", 30_000))?.status).toBe("INSTALLING");
    expect((await setup.leaseNextTask(ownerId, run.id, "worker:two", 30_000))?.status).toBe("CHECKING");
    expect((await setup.leaseNextTask(ownerId, run.id, "worker:three", 30_000))?.status).toBe("CHECKING");
    expect(await setup.leaseNextTask(ownerId, run.id, "worker:four", 30_000)).toBeNull();
  });

  it("does not resurrect a cancelled run during delayed reconciliation", async () => {
    const { store, setup, plan } = await prepared();
    const run = await setup.startRun(ownerId, plan.id, plan.planDigest, "request:cancel-reconcile");
    const leased = await setup.leaseNextTask(ownerId, run.id, "worker:one", 30_000);
    const restarted = new SetupExecutionCoordinator(store, () => new Date("2026-10-07T12:01:00.000Z"));
    await restarted.leaseNextTask(ownerId, run.id, "worker:two", 30_000);
    await restarted.cancelRun(ownerId, run.id);
    await expect(restarted.reconcileExpiredTask(ownerId, run.id, leased!.id, async () => ({
      outcome: "NOT_APPLIED", evidenceRef: "proof:inspection-1"
    }))).rejects.toMatchObject({ code: "SETUP_RUN_NOT_ACTIVE" });
    expect((await restarted.getState(ownerId)).runs[0]?.status).toBe("CANCELLED");
  });

  it("pauses, resumes and retries only the failed dependency subgraph", async () => {
    const { setup, plan } = await prepared();
    const run = await setup.startRun(ownerId, plan.id, plan.planDigest, "request:start-1");
    await setup.pauseRun(ownerId, run.id);
    expect(await setup.leaseNextTask(ownerId, run.id, "worker:one", 30_000)).toBeNull();
    await setup.resumeRun(ownerId, run.id);
    const task = await setup.leaseNextTask(ownerId, run.id, "worker:one", 30_000);
    expect(task).not.toBeNull();
    await setup.failTask(ownerId, run.id, task!.id, "worker:one", "SERVICE_UNAVAILABLE");
    const before = await setup.getState(ownerId);
    const unrelated = before.tasks.find((candidate) => candidate.featureId === "dock:rooms");
    await setup.retryFailedTasks(ownerId, run.id, [task!.id], before.runs[0]!.revision);
    const after = await setup.getState(ownerId);
    expect(after.tasks.find((candidate) => candidate.id === task!.id)).toMatchObject({ status: "QUEUED", errorCode: null });
    expect(after.tasks.find((candidate) => candidate.id === unrelated?.id)).toEqual(unrelated);
  });

  it("requires a current matching receipt for every task before Ready", async () => {
    const { setup, plan } = await prepared();
    const run = await setup.startRun(ownerId, plan.id, plan.planDigest, "request:start-1");
    expect((await setup.checkReadiness(ownerId, run.id, {})).ready).toBe(false);
    const task = await setup.leaseNextTask(ownerId, run.id, "worker:one", 30_000);
    await setup.completeTask(ownerId, run.id, task!.id, "worker:one", {
      checkVersion: "check:v1", subjectFingerprint: "a".repeat(64), evidenceRef: "proof:verified-1"
    });
    expect((await setup.checkReadiness(ownerId, run.id, { [task!.featureId]: "b".repeat(64) })).ready).toBe(false);
    expect((await setup.getState(ownerId)).receipts).toHaveLength(1);
  });
});
