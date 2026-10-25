import { describe, expect, it } from "vitest";
import { taskTitleSettingsSchema, type TaskTitleState } from "@space/contracts";
import { InMemoryTaskTitleRepository } from "../src/task-title-repository.js";
const at = "2026-09-08T10:00:00.000Z";
function state(version = 1): TaskTitleState {
  return {
    key: "task:test",
    version,
    paneId: "pane:test",
    sessionId: "session:test",
    runtimeId: "cli:codex",
    nativeId: null,
    revisionId: null,
    requestHash: `hash${version}`,
    request: "Fix login",
    title: "Fix login",
    dueAt: at,
    lastAttemptAt: null,
    preferredCandidateId: null,
    metadata: {
      taskKey: "task:test",
      version,
      description: "Fix login",
      steps: [],
      earlierWork: "",
      source: "local",
      generationStatus: "pending",
      nativeSyncStatus: "unsupported",
      providerId: null,
      modelId: null,
      updatedAt: at,
    },
  };
}
describe("durable task title queue contract", () => {
  it("atomically separates generation batches while allowing one distinct fallback", async () => {
    const repo = new InMemoryTaskTitleRepository(),
      policy = taskTitleSettingsSchema.parse({});
    expect(
      await repo.reserveAttempt("task", "first", at, policy, "batch-1"),
    ).toBe(true);
    expect(
      await repo.reserveAttempt("task", "second", at, policy, "batch-2"),
    ).toBe(false);
    expect(
      await repo.reserveAttempt("task", "second", at, policy, "batch-1"),
    ).toBe(true);
    expect(
      await repo.reserveAttempt("task", "third", at, policy, "batch-1"),
    ).toBe(false);
    expect(
      await repo.reserveAttempt("task", "first", at, policy, "batch-1"),
    ).toBe(false);
    expect(
      await repo.reserveAttempt(
        "task",
        "first",
        "2026-09-08T10:01:00.000Z",
        policy,
        "batch-2",
      ),
    ).toBe(true);
  });
  it("claims once and rejects results from a superseded context", async () => {
    const repo = new InMemoryTaskTitleRepository();
    expect(await repo.enqueue(state(), 0)).toBe(true);
    const lease = (await repo.claim(at))!;
    expect(await repo.claim(at)).toBe(null);
    expect(await repo.enqueue(state(2), 1)).toBe(true);
    expect(await repo.finish(lease, { ...state(), dueAt: null })).toBe(false);
    expect((await repo.claim(at))?.state.version).toBe(2);
  });
  it("recovers abandoned leases without accepting an old worker's completion", async () => {
    const repo = new InMemoryTaskTitleRepository();
    await repo.enqueue(state(), 0);
    const old = (await repo.claim(at))!;
    expect(await repo.claim("2026-09-08T10:01:01.000Z")).toBeNull();
    const fresh = (await repo.claim("2026-09-08T10:02:01.000Z"))!;
    expect(fresh.leaseId).not.toBe(old.leaseId);
    expect(await repo.finish(old, { ...state(), dueAt: null })).toBe(false);
    expect(await repo.finish(fresh, { ...state(), dueAt: null })).toBe(true);
    expect(await repo.claim("2026-09-08T10:03:01.000Z")).toBe(null);
  });
  it("atomically bounds competing attempts across tasks and rolls the window", async () => {
    const repo = new InMemoryTaskTitleRepository();
    const policy = taskTitleSettingsSchema.parse({
      globalDayAttempts: 2,
      perTaskHourAttempts: 1,
    });
    const results = await Promise.all([
      repo.reserveAttempt("a", "free", at, policy),
      repo.reserveAttempt("a", "other", at, policy),
      repo.reserveAttempt("b", "free", at, policy),
      repo.reserveAttempt("c", "free", at, policy),
    ]);
    expect(results).toEqual([true, false, true, false]);
    expect(
      await repo.reserveAttempt(
        "a",
        "free",
        "2026-09-09T10:00:01.000Z",
        policy,
      ),
    ).toBe(true);
  });
  it("keeps cooldowns and returns only active exclusions", async () => {
    const repo = new InMemoryTaskTitleRepository();
    await repo.cooldown("provider:model", "2026-09-08T10:05:00.000Z");
    expect(await repo.cooldowns(at)).toEqual({
      "provider:model": "2026-09-08T10:05:00.000Z",
    });
    expect(await repo.cooldowns("2026-09-08T10:06:00.000Z")).toEqual({});
  });
});
