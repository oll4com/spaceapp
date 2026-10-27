import { randomUUID } from "node:crypto";
import type { SetupTask } from "@space/contracts";
import { SetupExecutionCoordinator } from "./setup-execution.js";

export type SetupActionInspection =
  | { outcome: "VERIFIED"; receipt: { checkVersion: string; subjectFingerprint: string; evidenceRef: string } }
  | { outcome: "NOT_APPLIED"; evidenceRef: string }
  | { outcome: "UNKNOWN" };

/** Only server-owned adapters implement these methods. Model/client input never becomes an action. */
export interface SetupActionAdapter {
  inspect(task: SetupTask): Promise<SetupActionInspection>;
  apply(task: SetupTask): Promise<void>;
}

export class SetupActionRunner {
  constructor(
    private readonly coordinator: SetupExecutionCoordinator,
    private readonly adapterFor: (task: SetupTask) => SetupActionAdapter | null
  ) {}

  async pump(ownerId: string, runId: string): Promise<void> {
    const workerId = `worker:${randomUUID()}`;
    for (let iteration = 0; iteration < 200; iteration++) {
      const before = await this.coordinator.getState(ownerId);
      const run = before.runs.find((candidate) => candidate.id === runId);
      if (!run) return;
      if (run.status === "FAILED") {
        const expired = before.tasks.filter((candidate) =>
          candidate.runId === runId && candidate.status === "NEEDS_ATTENTION" &&
          candidate.errorCode === "LEASE_EXPIRED_RECONCILE"
        );
        if (!expired.length) return;
        for (const candidate of expired) {
          const adapter = this.adapterFor(candidate);
          await this.coordinator.reconcileExpiredTask(ownerId, runId, candidate.id, async () => {
            if (!adapter) return { outcome: "UNKNOWN" };
            try { return await adapter.inspect(candidate); }
            catch { return { outcome: "UNKNOWN" }; }
          });
        }
        const reconciled = await this.coordinator.getState(ownerId);
        if (reconciled.runs.find((candidate) => candidate.id === runId)?.status === "FAILED") return;
        continue;
      }
      if (run.status !== "RUNNING") return;
      const task = await this.coordinator.leaseNextTask(ownerId, runId, workerId, 120_000);
      if (!task) {
        const after = await this.coordinator.getState(ownerId);
        const expired = after.tasks.some((candidate) =>
          candidate.runId === runId && candidate.status === "NEEDS_ATTENTION" &&
          candidate.errorCode === "LEASE_EXPIRED_RECONCILE"
        );
        if (expired) continue;
        return;
      }
      const adapter = this.adapterFor(task);
      if (!adapter) {
        await this.coordinator.failTask(ownerId, runId, task.id, workerId, "ACTION_ADAPTER_UNAVAILABLE");
        return;
      }
      let inspection: SetupActionInspection;
      try { inspection = await adapter.inspect(task); }
      catch {
        await this.coordinator.failTask(ownerId, runId, task.id, workerId, "ACTION_INSPECTION_FAILED");
        return;
      }
      if (inspection.outcome === "UNKNOWN") {
        await this.coordinator.failTask(ownerId, runId, task.id, workerId, "ACTION_STATE_UNKNOWN");
        return;
      }
      if (inspection.outcome === "NOT_APPLIED") {
        try { await adapter.apply(task); }
        catch {
          await this.coordinator.failTask(ownerId, runId, task.id, workerId, "ACTION_APPLY_FAILED");
          return;
        }
        try { inspection = await adapter.inspect(task); }
        catch {
          await this.coordinator.failTask(ownerId, runId, task.id, workerId, "ACTION_VERIFICATION_FAILED");
          return;
        }
      }
      if (inspection.outcome !== "VERIFIED") {
        await this.coordinator.failTask(ownerId, runId, task.id, workerId, "ACTION_VERIFICATION_FAILED");
        return;
      }
      await this.coordinator.completeTask(ownerId, runId, task.id, workerId, inspection.receipt);
    }
  }
}
