import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import type { SetupAvailability, SetupFeatureId } from "@space/contracts";
import { createProductionSetupActionAdapter } from "../src/setup-production-actions.js";
import type { SetupConnectionsService } from "../src/setup-connections.js";

describe("setup runtime function proof", () => {
  it("keeps capture behind current owner-bound server evidence", async () => {
    const store = new InMemorySpaceStore(); const ownerId = "user:capture-proof";
    const task = { id: "task:capture", runId: "run:capture", featureId: "utility:snip" as const, actionId: "VERIFY_CAPTURE" as const,
      status: "CHECKING" as const, attempt: 1, idempotencyKey: "test:capture", dependsOn: [], leaseOwner: null, leaseExpiresAt: null, errorCode: null, resultRef: null };
    let fingerprint: string | null = null;
    const adapter = createProductionSetupActionAdapter({ task, ownerId, store, plan: { catalogVersion: "first-setup-v2.0" } as never,
      connections: { overview: async () => [] } as unknown as SetupConnectionsService, captureFingerprint: async () => fingerprint });
    expect(adapter).not.toBeNull();
    expect(await adapter!.inspect(task)).toMatchObject({ outcome: "NOT_APPLIED" });
    await expect(adapter!.apply(task)).rejects.toThrow();
    fingerprint = "d".repeat(64);
    expect(await adapter!.inspect(task)).toMatchObject({ outcome: "VERIFIED", receipt: { subjectFingerprint: fingerprint } });
  });
  it("requires a completed function proof for the Room Agent task and invalidates a changed model", async () => {
    const store = new InMemorySpaceStore(); const ownerId = "user:room-agent-check";
    const task = { id: "task:room-agent-check", runId: "run:room-agent-check", featureId: "dock:room-agent" as const,
      actionId: "VERIFY_AGENT_TASK" as const, status: "CHECKING" as const, attempt: 1,
      idempotencyKey: "test:room-agent", dependsOn: [], leaseOwner: null, leaseExpiresAt: null, errorCode: null, resultRef: null };
    let fingerprint = "model-one"; let completed = false;
    const context = { task, ownerId, store, plan: { catalogVersion: "first-setup-v2.0" } as never,
      connections: { overview: async () => [] } as unknown as SetupConnectionsService,
      functionalChecks: { "dock:room-agent": { fingerprint: async () => fingerprint, exercise: async () => { completed = true; } } } };
    const adapter = createProductionSetupActionAdapter(context);
    expect(adapter).not.toBeNull();
    expect(await adapter!.inspect(task)).toMatchObject({ outcome: "NOT_APPLIED" });
    await adapter!.apply(task);
    expect(completed).toBe(true);
    expect(await adapter!.inspect(task)).toMatchObject({ outcome: "VERIFIED" });
    fingerprint = "model-two";
    expect(await adapter!.inspect(task)).toMatchObject({ outcome: "NOT_APPLIED" });
  });
  it("requires an actual function check, persists its digest and invalidates it when the runtime changes", async () => {
    const store = new InMemorySpaceStore();
    const ownerId = "user:function-proof";
    const coordinator = new SetupExecutionCoordinator(store);
    const availability = new Proxy({}, { get: () => "AVAILABLE" }) as Record<SetupFeatureId, SetupAvailability>;
    const draft = await coordinator.updateDraft(ownerId, null, { persona: "developer", level: "balanced",
      requestedFeatureIds: ["pane:demos"], connectionChoices: [] });
    const plan = await coordinator.createPlan(ownerId, draft.revision, availability, {});
    const run = await coordinator.startRun(ownerId, plan.id, plan.planDigest, "request:function-proof");
    const task = await coordinator.leaseNextTask(ownerId, run.id, "worker:function-proof", 30_000);
    expect(task?.featureId).toBe("pane:demos");
    let digest = "b".repeat(64);
    let executed = false;
    const functionalCheck = { fingerprint: async () => digest, exercise: async () => { executed = true; } };
    const connections = { overview: async () => [] } as unknown as SetupConnectionsService;
    const adapter = () => createProductionSetupActionAdapter({ task: task!, ownerId, plan, store, connections,
      functionalChecks: { "pane:demos": functionalCheck } });
    expect(adapter()).not.toBeNull();
    expect(await adapter()!.inspect(task!)).toMatchObject({ outcome: "NOT_APPLIED" });
    await adapter()!.apply(task!);
    expect(executed).toBe(true);
    const observed = await adapter()!.inspect(task!);
    expect(observed.outcome).toBe("VERIFIED");
    if (observed.outcome !== "VERIFIED") throw new Error("The runtime function did not verify.");
    await coordinator.completeTask(ownerId, run.id, task!.id, "worker:function-proof", observed.receipt);
    const restarted = createProductionSetupActionAdapter({ task: task!, ownerId, plan, store, connections,
      functionalChecks: { "pane:demos": { fingerprint: async () => digest, exercise: async () => { throw new Error("Inspection must be read-only."); } } } });
    expect(await restarted!.inspect(task!)).toMatchObject({ outcome: "VERIFIED" });
    digest = "c".repeat(64);
    expect(await restarted!.inspect(task!)).toMatchObject({ outcome: "NOT_APPLIED" });
  });
});
