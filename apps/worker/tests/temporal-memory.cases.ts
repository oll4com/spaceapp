import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import type { MemoryConsolidationRun, MemoryMaintenanceResult, MemoryMutationWorkflowResult } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { firstRunHistory, recordWorkflowHistory, withTemporalWorker } from "./support/temporal-sandbox.js";

const traceId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const changeSetId = "10000000-0000-4000-8000-000000000003";
const timestamp = "2026-01-01T00:00:00.000Z";
const snapshot: MemoryMaintenanceResult = {
  status: "REFRESHED", generatedAt: timestamp, sourceHash: "a".repeat(64), previousSourceHash: null,
  summary: { sourceCount: 1, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 }, durationMs: 1
};
const completedRun: MemoryConsolidationRun = {
  id: runId, mode: "AUDIT", triggerKind: "SCHEDULED", status: "SUCCEEDED",
  workflowId: "synthetic-consolidation", dedupeKey: "synthetic-audit", sourceHash: snapshot.sourceHash,
  actorUserId: null, progressCompleted: 0, progressTotal: 0, findingCount: 0,
  appliedOperationCount: 0, skippedOperationCount: 0, failedOperationCount: 0,
  metrics: {}, modelId: null, aiVerified: false, aiEvidence: {}, statusReason: null,
  createdAt: timestamp, startedAt: timestamp, completedAt: timestamp, updatedAt: timestamp
};
const mutation: MemoryMutationWorkflowResult = {
  status: "APPLIED", changeSetId, resultingSourceHash: "b".repeat(64), reason: null
};

/** Registers real maintenance, child-consolidation and mutation workflow retry cases. */
export function registerMemoryCases(): void {
  describe.sequential("real Temporal sandbox: memory workflows", () => {
    it("continues after both optional maintenance failures and completes its real child workflow", async () => {
      const allMonthsAttempts: number[] = [], reconciliationAttempts: number[] = [];
      const auditInputs: unknown[] = [], consolidationInputs: unknown[] = [];
      await withTemporalWorker({
        refreshMemoryGraphSnapshot: async () => snapshot,
        refreshAllMonthsMemoryGraphSnapshot: async () => {
          allMonthsAttempts.push(Context.current().info.attempt);
          throw new Error("synthetic all-months failure");
        },
        reconcileStaleSpaceAgentSessions: async () => {
          reconciliationAttempts.push(Context.current().info.attempt);
          throw new Error("synthetic stale-session failure");
        },
        createScheduledMemoryAudit: async (input: unknown) => { auditInputs.push(input); return completedRun; },
        prepareMemoryConsolidation: async (input: unknown) => {
          consolidationInputs.push(input); return { run: completedRun, changeSetId: null };
        }
      }, async ({ client, taskQueue }) => {
        const input = { scheduledAt: timestamp, traceId };
        const handle = await client.workflow.start("memoryMaintenanceWorkflow", {
          workflowId: randomUUID(), taskQueue, args: [input]
        });
        expect(await handle.result()).toEqual(snapshot);
        expect(allMonthsAttempts).toEqual([1, 2, 3]);
        expect(reconciliationAttempts).toEqual([1, 2, 3]);
        expect(auditInputs).toEqual([{ ...input, sourceHash: snapshot.sourceHash }]);
        expect(consolidationInputs).toEqual([{ runId, traceId }]);
        const history = await firstRunHistory(handle);
        const children = history.events?.filter((event: any) => event.startChildWorkflowExecutionInitiatedEventAttributes);
        expect(children).toHaveLength(1);
        expect(children?.[0]?.startChildWorkflowExecutionInitiatedEventAttributes?.workflowType?.name)
          .toBe("memoryConsolidationWorkflow");
        expect(history.events?.some((event: any) => event.childWorkflowExecutionCompletedEventAttributes)).toBe(true);
        await recordWorkflowHistory("memoryMaintenanceWorkflow", handle);
      }, { memory: true });
    }, 60_000);

    it("propagates an exhausted initial refresh instead of starting maintenance on a missing snapshot", async () => {
      const attempts: number[] = [];
      let auditCalls = 0;
      await withTemporalWorker({
        refreshMemoryGraphSnapshot: async () => {
          attempts.push(Context.current().info.attempt); throw new Error("synthetic initial refresh failure");
        },
        createScheduledMemoryAudit: async () => { auditCalls++; return completedRun; }
      }, async ({ client, taskQueue }) => {
        await expect(client.workflow.execute("memoryMaintenanceWorkflow", {
          workflowId: randomUUID(), taskQueue, args: [{ scheduledAt: timestamp, traceId }]
        })).rejects.toThrow();
        expect(attempts).toEqual([1, 2, 3]);
        expect(auditCalls).toBe(0);
      }, { memory: true });
    }, 60_000);

    it("retries the cross-queue mutation and finalizes consolidation with its actual result", async () => {
      const attempts: number[] = [], finalized: unknown[] = [];
      await withTemporalWorker({
        prepareMemoryConsolidation: async () => ({ run: completedRun, changeSetId }),
        executePersistedMemoryChangeSet: async (input: unknown) => {
          expect(input).toEqual({ changeSetId, traceId });
          const attempt = Context.current().info.attempt; attempts.push(attempt);
          if (attempt < 3) throw new Error("synthetic transient mutation failure");
          return mutation;
        },
        finalizeMemoryRepair: async (input: unknown) => { finalized.push(input); return completedRun; }
      }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("memoryConsolidationWorkflow", {
          workflowId: randomUUID(), taskQueue, args: [{ runId, traceId }]
        });
        expect(await handle.result()).toEqual(completedRun);
        expect(attempts).toEqual([1, 2, 3]);
        expect(finalized).toEqual([{ runId, changeSetId, mutationResult: mutation }]);
        await recordWorkflowHistory("memoryConsolidationWorkflow", handle);
      }, { memory: true });
    }, 60_000);

    it("returns an audit-only consolidation without scheduling a mutation or repair finalization", async () => {
      let mutationCalls = 0, finalizationCalls = 0;
      await withTemporalWorker({
        prepareMemoryConsolidation: async () => ({ run: completedRun, changeSetId: null }),
        executePersistedMemoryChangeSet: async () => { mutationCalls++; return mutation; },
        finalizeMemoryRepair: async () => { finalizationCalls++; return completedRun; }
      }, async ({ client, taskQueue }) => {
        expect(await client.workflow.execute("memoryConsolidationWorkflow", {
          workflowId: randomUUID(), taskQueue, args: [{ runId, traceId }]
        })).toEqual(completedRun);
        expect(mutationCalls).toBe(0); expect(finalizationCalls).toBe(0);
      }, { memory: true });
    }, 60_000);

    it("retries the real mutation activity and preserves its payload and return value", async () => {
      const attempts: number[] = [];
      await withTemporalWorker({ executePersistedMemoryChangeSet: async (input: unknown) => {
        expect(input).toEqual({ changeSetId, traceId });
        const attempt = Context.current().info.attempt; attempts.push(attempt);
        if (attempt < 3) throw new Error("synthetic transient mutation failure");
        return mutation;
      } }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("memoryMutationWorkflow", {
          workflowId: randomUUID(), taskQueue, args: [{ changeSetId, traceId }]
        });
        expect(await handle.result()).toEqual(mutation);
        expect(attempts).toEqual([1, 2, 3]);
        await recordWorkflowHistory("memoryMutationWorkflow", handle);
      });
    }, 60_000);

    it("fails the mutation workflow after the real three-attempt retry policy is exhausted", async () => {
      const attempts: number[] = [];
      await withTemporalWorker({ executePersistedMemoryChangeSet: async () => {
        attempts.push(Context.current().info.attempt); throw new Error("synthetic exhausted mutation failure");
      } }, async ({ client, taskQueue }) => {
        await expect(client.workflow.execute("memoryMutationWorkflow", {
          workflowId: randomUUID(), taskQueue, args: [{ changeSetId, traceId }]
        })).rejects.toThrow();
        expect(attempts).toEqual([1, 2, 3]);
      });
    }, 60_000);
  });
}
