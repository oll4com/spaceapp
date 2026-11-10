import { createHash } from "node:crypto";
import type { MemoryChangeSet, MemoryMutationRecoveryResult } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { CanonicalMemoryMutationExecutionError } from "@space/runtime";
import { executePersistedMemoryChangeSet } from "../src/memory-mutation-activity.js";
import { MEMORY_MUTATION_TASK_QUEUE, memoryMutationWorkerOptions } from "../src/memory-mutation-config.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function approvedChangeSet(): MemoryChangeSet {
  const beforeSnapshot = "before\n";
  const afterSnapshot = "after\n";
  return {
    id: "memory_change:adapter",
    kind: "EDIT",
    status: "APPROVED",
    sourcePath: "/tmp/gemini_history.md",
    recordIds: ["memory_record:adapter"],
    resolvesIssueIds: [],
    expectedSourceHash: "a".repeat(64),
    resultingSourceHash: null,
    beforeContentHash: digest(beforeSnapshot),
    afterContentHash: digest(afterSnapshot),
    beforeSnapshot,
    afterSnapshot,
    reason: "Approved adapter fixture.",
    statusReason: null,
    actorUserId: "user:adapter",
    traceId: "trace:adapter",
    rollbackOfChangeSetId: null,
    rolledBackByChangeSetId: null,
    createdAt: "2026-07-13T01:00:00.000Z",
    updatedAt: "2026-07-13T01:01:00.000Z",
    appliedAt: null,
    failedAt: null,
    rolledBackAt: null
  };
}

function fakeStore(initial: MemoryChangeSet) {
  let current = initial;
  const updates: Array<{ status: string; resultingSourceHash?: string; statusReason?: string }> = [];
  return {
    updates,
    async getMemoryChangeSet() { return current; },
    async updateMemoryChangeSet(_id: string, input: { status: string; resultingSourceHash?: string; statusReason?: string }) {
      updates.push(input);
      current = {
        ...current,
        status: input.status as MemoryChangeSet["status"],
        resultingSourceHash: input.resultingSourceHash ?? current.resultingSourceHash,
        statusReason: input.statusReason ?? current.statusReason,
        appliedAt: input.status === "APPLIED" ? "2026-07-13T01:03:00.000Z" : current.appliedAt,
        failedAt: input.status === "FAILED" ? "2026-07-13T01:03:00.000Z" : current.failedAt
      };
      return current;
    }
  };
}

const enabledEnv = {
  SPACE_MEMORY_GRAPH_ENABLED: "true",
  SPACE_MEMORY_MUTATIONS_ENABLED: "true"
};

describe("persisted memory mutation activity", () => {
  it("moves an approved change set through APPLYING and APPLIED before journal finalization", async () => {
    const store = fakeStore(approvedChangeSet());
    const finalized: MemoryChangeSet[] = [];
    const result = await executePersistedMemoryChangeSet(
      { changeSetId: "memory_change:adapter", traceId: "trace:execute" },
      {
        env: enabledEnv,
        store,
        coreOptions: {} as never,
        executeMutation: async () => ({
          status: "APPLIED",
          changeSetId: "memory_change:adapter",
          sourcePath: "/tmp/gemini_history.md",
          resultingSourceHash: "b".repeat(64),
          journalPath: "/tmp/journal.json",
          durationMs: 1
        }),
        finalizeJournal: async (changeSet) => { finalized.push(changeSet); }
      }
    );

    expect(result).toMatchObject({ status: "APPLIED", resultingSourceHash: "b".repeat(64) });
    expect(store.updates).toEqual([
      { status: "APPLYING" },
      { status: "APPLIED", resultingSourceHash: "b".repeat(64) }
    ]);
    expect(finalized[0]).toMatchObject({ status: "APPLIED", resultingSourceHash: "b".repeat(64) });
  });

  it("records FAILED only for a proven pre-rename failure", async () => {
    const store = fakeStore(approvedChangeSet());
    const result = await executePersistedMemoryChangeSet(
      { changeSetId: "memory_change:adapter", traceId: "trace:execute" },
      {
        env: enabledEnv,
        store,
        coreOptions: {} as never,
        executeMutation: async () => {
          throw new CanonicalMemoryMutationExecutionError("sensitive internal failure", "memory_change:adapter", false);
        }
      }
    );
    expect(result).toMatchObject({ status: "FAILED", resultingSourceHash: null });
    expect(store.updates).toEqual([
      { status: "APPLYING" },
      { status: "FAILED", statusReason: "Canonical mutation failed before the atomic replacement commit point." }
    ]);
  });

  it("reconciles a post-rename failure and leaves ambiguous state APPLYING", async () => {
    const appliedStore = fakeStore(approvedChangeSet());
    const recovered: MemoryMutationRecoveryResult = {
      status: "COMPLETE_APPLIED",
      changeSetId: "memory_change:adapter",
      sourcePath: "/tmp/gemini_history.md",
      resultingSourceHash: "c".repeat(64),
      reason: null
    };
    const applied = await executePersistedMemoryChangeSet(
      { changeSetId: "memory_change:adapter", traceId: "trace:execute" },
      {
        env: enabledEnv,
        store: appliedStore,
        coreOptions: {} as never,
        executeMutation: async () => {
          throw new CanonicalMemoryMutationExecutionError("post rename", "memory_change:adapter", true);
        },
        recoverMutation: async () => recovered,
        finalizeJournal: async () => undefined
      }
    );
    expect(applied.status).toBe("APPLIED");
    expect(appliedStore.updates.at(-1)).toEqual({ status: "APPLIED", resultingSourceHash: "c".repeat(64) });

    const ambiguousStore = fakeStore(approvedChangeSet());
    const ambiguous = await executePersistedMemoryChangeSet(
      { changeSetId: "memory_change:adapter", traceId: "trace:execute" },
      {
        env: enabledEnv,
        store: ambiguousStore,
        coreOptions: {} as never,
        executeMutation: async () => {
          throw new CanonicalMemoryMutationExecutionError("post rename", "memory_change:adapter", true);
        },
        recoverMutation: async () => ({
          status: "OPERATOR_REQUIRED",
          changeSetId: "memory_change:adapter",
          sourcePath: "/tmp/gemini_history.md",
          resultingSourceHash: null,
          reason: "Unknown canonical state."
        })
      }
    );
    expect(ambiguous).toMatchObject({ status: "OPERATOR_REQUIRED", reason: "Unknown canonical state." });
    expect(ambiguousStore.updates).toEqual([{ status: "APPLYING" }]);
  });

  it("does not touch the store when either mutation kill switch is disabled", async () => {
    let calls = 0;
    const result = await executePersistedMemoryChangeSet(
      { changeSetId: "memory_change:adapter", traceId: "trace:execute" },
      {
        env: { ...enabledEnv, SPACE_MEMORY_MUTATIONS_ENABLED: "false" },
        store: {
          async getMemoryChangeSet() { calls += 1; return approvedChangeSet(); },
          async updateMemoryChangeSet() { calls += 1; return approvedChangeSet(); }
        },
        coreOptions: {} as never
      }
    );
    expect(result).toEqual({ status: "DISABLED", changeSetId: "memory_change:adapter", resultingSourceHash: null, reason: null });
    expect(calls).toBe(0);
  });

  // The least-privilege worker unit it ships: memory-worker-units.test.ts (deploy files, not in the public tree).
  it("uses a serialized dedicated queue", () => {
    expect(MEMORY_MUTATION_TASK_QUEUE).toBe("space-memory-mutations");
    expect(memoryMutationWorkerOptions).toMatchObject({
      maxConcurrentActivityTaskExecutions: 1,
      maxConcurrentLocalActivityExecutions: 1,
      maxConcurrentActivityTaskPolls: 1
    });
  });
});
