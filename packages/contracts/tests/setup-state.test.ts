import { describe, expect, it } from "vitest";
import {
  setupDraftSchema,
  setupPlanSchema,
  setupRunSchema,
  setupTaskSchema,
  setupReadinessReceiptSchema,
  setupCompletionSchema
} from "../src/setup-state.js";

const at = "2026-10-07T12:00:00.000Z";
const digest = "a".repeat(64);
const draft = {
  id: "draft:owner", ownerId: "user:owner", protocolVersion: 2, revision: 1,
  persona: "everyday", level: "minimal", requestedFeatureIds: ["agent:opencode", "pane:chat"],
  connectionChoices: [], catalogVersion: "first-setup-v2.0", updatedAt: at
};

describe("durable first setup contracts", () => {
  it("accepts a revisioned owner draft without secret values", () => {
    expect(setupDraftSchema.parse(draft)).toEqual(draft);
    expect(() => setupDraftSchema.parse({ ...draft, apiKey: "should-not-store" })).toThrow();
    expect(() => setupDraftSchema.parse({ ...draft, requestedFeatureIds: ["pane:chat", "pane:chat"] })).toThrow();
    expect(() => setupDraftSchema.parse({ ...draft, revision: -1 })).toThrow();
  });

  it("accepts only opaque credential references in connection choices", () => {
    const choice = {
      featureId: "pane:live", providerId: "openai", modelId: "gpt-live-1", voiceId: "gleam",
      credentialRef: "cred:abc123"
    };
    expect(setupDraftSchema.parse({ ...draft, connectionChoices: [choice] }).connectionChoices).toEqual([choice]);
    expect(() => setupDraftSchema.parse({ ...draft, connectionChoices: [{ ...choice, apiKey: "real-key" }] })).toThrow();
    expect(() => setupDraftSchema.parse({ ...draft, connectionChoices: [{ ...choice, credentialRef: "sk-secret" }] })).toThrow();
  });

  it("requires a digest and allowlisted setup actions", () => {
    const plan = {
      id: "plan:owner-1", draftId: draft.id, ownerId: draft.ownerId, draftRevision: 1,
      catalogVersion: draft.catalogVersion, planDigest: digest,
      requestedFeatureIds: draft.requestedFeatureIds, effectiveFeatureIds: draft.requestedFeatureIds,
      actions: [{ id: "task:prepare", featureId: "agent:opencode", actionId: "PREPARE_OPENCODE", dependsOn: [] }],
      requiredHumanInputs: [], costDisclosures: [], resourceConstraints: [], createdAt: at
    };
    expect(setupPlanSchema.parse(plan)).toEqual(plan);
    expect(() => setupPlanSchema.parse({ ...plan, actions: [{ ...plan.actions[0], actionId: "RUN_SHELL" }] })).toThrow();
    expect(() => setupPlanSchema.parse({ ...plan, planDigest: "not-a-digest" })).toThrow();
  });

  it("separates run, leased task and functional receipt status", () => {
    const run = { id: "run:owner-1", planId: "plan:owner-1", ownerId: draft.ownerId,
      status: "RUNNING", revision: 1, eventSequence: 0, createdAt: at, updatedAt: at, finishedAt: null };
    expect(setupRunSchema.parse(run)).toEqual(run);
    const task = { id: "task:prepare", runId: run.id, actionId: "PREPARE_OPENCODE", featureId: "agent:opencode",
      dependsOn: [], status: "CHECKING", attempt: 1, idempotencyKey: "setup:owner:prepare", leaseOwner: "worker:one",
      leaseExpiresAt: at, errorCode: null, resultRef: null };
    expect(setupTaskSchema.parse(task)).toEqual(task);
    expect(() => setupTaskSchema.parse({ ...task, providerOutput: "private terminal text" })).toThrow();
    const receipt = { id: "receipt:task-1", runId: run.id, taskId: task.id,
      featureId: "agent:opencode", checkVersion: "agent-task-v1", subjectFingerprint: digest,
      completedAt: at, expiresAt: "2026-10-07T12:15:00.000Z", outcome: "PASSED", evidenceRef: "proof:bounded-1" };
    expect(setupReadinessReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(() => setupReadinessReceiptSchema.parse({ ...receipt, transcript: "private prompt" })).toThrow();
  });

  it("completion binds the run, draft revision, digest, settings and memory", () => {
    const completion = { runId: "run:owner-1", draftRevision: 1, planDigest: digest,
      settingsRevision: 2, receiptSetHash: digest, starterRoomId: "room:alex",
      memoryHandoffRevision: 1, completedAt: at };
    expect(setupCompletionSchema.parse(completion)).toEqual(completion);
    expect(() => setupCompletionSchema.parse({ ...completion, settingsRevision: -1 })).toThrow();
  });
});

describe("setup execution snapshot", () => {
  it("stores only bounded, sanitized durable state", async () => {
    const { setupExecutionStateSchema } = await import("../src/setup-state.js");
    const state = { ownerId: "user:owner", revision: 0, draft: null, plans: [], runs: [], tasks: [], receipts: [], events: [], runIdempotency: [] };
    expect(setupExecutionStateSchema.parse(state)).toEqual(state);
    expect(() => setupExecutionStateSchema.parse({ ...state, secret: "sk-private" })).toThrow();
    expect(() => setupExecutionStateSchema.parse({ ...state, events: Array(501).fill({ runId: "run:owner-1", sequence: 1, taskId: null, state: "READY", reasonCode: null, createdAt: at }) })).toThrow();
  });
});
