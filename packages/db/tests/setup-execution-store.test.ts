import { describe, expect, it } from "vitest";
import { PostgresSpaceStore, loadMigrations, type PgPoolLike } from "../src/index.js";
import type { SetupExecutionState } from "@space/contracts";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import type { SetupAvailability, SetupFeatureId } from "@space/contracts";

const empty: SetupExecutionState = {
  ownerId: "user:owner", revision: 0, draft: null, plans: [], runs: [], tasks: [], receipts: [], events: [], runIdempotency: []
};

describe("PostgreSQL first-setup state", () => {
  it("persists an owner snapshot with SQL revision CAS", async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const pool: PgPoolLike = {
      async query<T>(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        if (sql.includes("SELECT payload")) return { rows: [{ payload: empty } as T], rowCount: 1 };
        return { rows: [{ ownerId: empty.ownerId } as T], rowCount: 1 };
      }
    };
    const store = new PostgresSpaceStore(pool);
    expect(await store.compareAndSwapSetupExecutionState(empty.ownerId, null, empty)).toBe(true);
    expect(await store.compareAndSwapSetupExecutionState(empty.ownerId, 0, { ...empty, revision: 1 })).toBe(true);
    expect(await store.getSetupExecutionState(empty.ownerId)).toEqual(empty);
    expect(calls[0]?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(calls[1]?.sql).toContain("WHERE owner_id = $1 AND revision = $2");
    expect(calls[1]?.values.slice(0, 2)).toEqual([empty.ownerId, 0]);
    expect(calls[2]?.values).toEqual([empty.ownerId]);
    expect(calls.map((call) => call.sql)).not.toContain("apiKey");
  });

  it("has an additive migration for owner-scoped versioned snapshots", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find((item) => item.id === "0239_first_setup_execution");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS space_first_setup_states");
    expect(migration?.sql).toContain("REFERENCES users(id) ON DELETE CASCADE");
    expect(migration?.sql).toContain("revision integer NOT NULL");
  });

  it("rolls back completion when the owner onboarding row was not updated", async () => {
    const time = "2026-10-07T16:30:00.000Z";
    const memory = new InMemorySpaceStore();
    const coordinator = new SetupExecutionCoordinator(memory, () => new Date(time));
    const requestedFeatureIds: SetupFeatureId[] = [
      "agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"
    ];
    const draft = await coordinator.updateDraft(empty.ownerId, null, {
      persona: "everyday", level: "minimal", requestedFeatureIds, connectionChoices: []
    });
    const availability = new Proxy({}, { get: () => "AVAILABLE" }) as Record<SetupFeatureId, SetupAvailability>;
    const plan = await coordinator.createPlan(empty.ownerId, draft.revision, availability, {});
    const run = await coordinator.startRun(empty.ownerId, plan.id, plan.planDigest, "request:db-completion");
    const fingerprints: Partial<Record<SetupFeatureId, string>> = {};
    for (let index = 0; index < plan.actions.length; index++) {
      const task = await coordinator.leaseNextTask(empty.ownerId, run.id, "worker:db", 30_000);
      fingerprints[task!.featureId] = "a".repeat(64);
      await coordinator.completeTask(empty.ownerId, run.id, task!.id, "worker:db", {
        checkVersion: "check:v1", subjectFingerprint: "a".repeat(64), evidenceRef: `proof:db-${index}`
      });
    }
    const state = await coordinator.getState(empty.ownerId);
    const calls: string[] = [];
    const client = {
      async query<T>(sql: string) {
        calls.push(sql);
        if (sql.includes("SELECT revision, payload")) return { rows: [{ revision: state.revision, payload: state } as T], rowCount: 1 };
        if (sql.includes("SELECT owner_user_id")) return { rows: [{
          ownerUserId: empty.ownerId, onboardingCompletedAt: null, starterRoomId: "room:starter"
        } as T], rowCount: 1 };
        return { rows: [] as T[], rowCount: sql.includes("UPDATE space_owner_setup") ? 0 : 1 };
      }
    };
    const pool: PgPoolLike = { ...client, connect: async () => client };
    const store = new PostgresSpaceStore(pool);
    await expect(store.completeSetupExecution({
      ownerId: empty.ownerId, expectedStateRevision: state.revision,
      runId: run.id, draftRevision: draft.revision, planDigest: plan.planDigest,
      currentFingerprints: fingerprints, completedAt: time
    })).rejects.toThrow(/owner onboarding update failed/i);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });
});
