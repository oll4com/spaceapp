import { describe, expect, it } from "vitest";
import { PostgresSpaceStore, type PgClientLike, type PgPoolLike } from "../src/index.js";

interface QueryCall {
  sql: string;
  values: unknown[];
}

class SetupCheckPgPool implements PgPoolLike, PgClientLike {
  readonly calls: QueryCall[] = [];

  async connect(): Promise<PgClientLike> {
    return this;
  }

  release(): void {}

  async query<T = unknown>(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes("INSERT INTO space_setup_connection_check_runs")) {
      return {
        rows: [{
          id: values[0],
          scope: values[1],
          connectionIds: values[2],
          status: "RUNNING",
          totalCount: values[4],
          completedCount: 0,
          createdAt: values[5],
          updatedAt: values[5],
          finishedAt: null
        } as T],
        rowCount: 1
      };
    }
    if (sql.includes("FROM space_setup_connection_check_runs") && sql.includes("FOR SHARE")) {
      return {
        rows: [{ connectionIds: ["cli:codex"] } as T],
        rowCount: 1
      };
    }
    if (sql.includes("INSERT INTO space_setup_connection_check_events")) {
      return {
        rows: [{
          id: values[0],
          runId: values[1],
          sequence: 1,
          connectionId: values[2],
          stage: values[3],
          state: values[4],
          functionalState: values[5],
          liveVerificationState: values[6],
          reasonCode: values[7],
          createdAt: values[8]
        } as T],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: null };
  }
}

describe("PostgresSpaceStore setup connection check runs", () => {
  it("allocates replay sequences transactionally without persisting provider output", async () => {
    const pool = new SetupCheckPgPool();
    const store = new PostgresSpaceStore(pool);
    const run = await store.createSetupConnectionCheckRun({
      scope: "SINGLE",
      connectionIds: ["cli:codex"],
      actorUserId: "user:owner"
    });

    const event = await store.appendSetupConnectionCheckEvent({
      runId: run.id,
      connectionId: "cli:codex",
      stage: "Verified",
      state: "COMPLETED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "VERIFIED",
      reasonCode: null
    });

    expect(event.sequence).toBe(1);
    expect(pool.calls.map((call) => call.sql.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "INSERT INTO",
      "BEGIN",
      "SELECT connection_ids",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "INSERT INTO",
      "COMMIT"
    ]);
    const eventInsert = pool.calls.find((call) =>
      call.sql.includes("INSERT INTO space_setup_connection_check_events")
    );
    expect(eventInsert?.sql).toContain("COALESCE(MAX(sequence), 0) + 1");
    expect(eventInsert?.sql).not.toMatch(/\b(stdout|stderr|nonce|fingerprint|token|provider_payload)\b/i);
  });
});
