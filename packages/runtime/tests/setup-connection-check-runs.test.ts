import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "../src/store.js";

describe("durable setup connection check runs", () => {
  it("persists bounded runs and monotonic replay events", () => {
    const store = new InMemorySpaceStore();
    const run = store.createSetupConnectionCheckRun({
      scope: "ALL",
      connectionIds: ["cli:codex", "cli:gemini"],
      actorUserId: "user:owner"
    });

    expect(run).toMatchObject({
      scope: "ALL",
      status: "RUNNING",
      totalCount: 2,
      completedCount: 0,
      finishedAt: null
    });

    const detecting = store.appendSetupConnectionCheckEvent({
      runId: run.id,
      connectionId: "cli:codex",
      stage: "Detecting CLI",
      state: "RUNNING",
      functionalState: null,
      liveVerificationState: null,
      reasonCode: null
    });
    const verified = store.appendSetupConnectionCheckEvent({
      runId: run.id,
      connectionId: "cli:codex",
      stage: "Verified",
      state: "COMPLETED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "VERIFIED",
      reasonCode: null
    });

    expect(detecting.sequence).toBe(1);
    expect(verified.sequence).toBe(2);
    expect(store.listSetupConnectionCheckEvents(run.id, 1, 100)).toEqual([verified]);

    const finished = store.updateSetupConnectionCheckRun(run.id, {
      status: "COMPLETED",
      completedCount: 2,
      finishedAt: "2026-07-29T10:00:00.000Z"
    });
    expect(finished).toMatchObject({
      status: "COMPLETED",
      completedCount: 2,
      finishedAt: "2026-07-29T10:00:00.000Z"
    });
    expect(store.getSetupConnectionCheckRun(run.id)).toEqual(finished);
    expect(store.listSetupConnectionCheckRuns(10)).toContainEqual(finished);
  });

  it("rejects secret-shaped event fields and invalid progress", () => {
    const store = new InMemorySpaceStore();
    const run = store.createSetupConnectionCheckRun({
      scope: "SINGLE",
      connectionIds: ["cli:codex"],
      actorUserId: "user:owner"
    });

    expect(() => store.appendSetupConnectionCheckEvent({
      runId: run.id,
      connectionId: "cli:codex",
      stage: "Verified",
      state: "COMPLETED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "VERIFIED",
      reasonCode: null,
      stdout: "must not persist"
    } as never)).toThrow();
    expect(() => store.updateSetupConnectionCheckRun(run.id, {
      completedCount: 2
    })).toThrow();
  });
});
