import { describe, expect, it } from "vitest";
import { PostgresSpaceStore, type PgClientLike, type PgPoolLike } from "../src/index.js";

interface QueryCall {
  sql: string;
  values: unknown[];
}

const taskRow = {
  id: "task:postgres",
  title: "Fallback task",
  objective: "fallback",
  status: "OPEN" as const,
  source: "MANUAL" as const,
  roomId: null,
  paneId: null,
  paneTitle: null,
  occurrenceCount: 1,
  characterCount: 8,
  createdAt: "2026-07-15T10:00:00.000Z",
  lastUsedAt: "2026-07-15T10:00:00.000Z",
  recurrence: null,
  timeZone: null,
  nextRunAt: null,
  lastRunAt: null,
  lastOutcome: null
};
const { recurrence: _recurrence, timeZone: _timeZone, nextRunAt: _nextRunAt, lastRunAt: _lastRunAt, lastOutcome: _lastOutcome, ...taskFields } = taskRow;
const taskItem = { ...taskFields, schedule: null };

class TaskPgPool implements PgPoolLike, PgClientLike {
  readonly calls: QueryCall[] = [];

  async connect(): Promise<PgClientLike> {
    return this;
  }

  release(): void {}

  async query<T = unknown>(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes("INSERT INTO task_items")) {
      return { rows: [taskRow as T], rowCount: 1 };
    }
    if (sql.includes("SELECT count(*) AS count") && sql.includes("FROM task_items")) {
      return { rows: [{ count: 1 } as T], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM task_items") && sql.includes("RETURNING")) {
      return { rows: [taskRow as T], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM task_items") && sql.includes("owner_user_id = $1") && !sql.includes("NOT IN")) {
      return { rows: [], rowCount: 3 };
    }
    if (sql.includes("UPDATE task_items") && sql.includes("RETURNING")) {
      return { rows: [taskRow as T], rowCount: 1 };
    }
    if (sql.includes("FROM task_items") && sql.includes("SELECT")) {
      return { rows: [taskRow as T], rowCount: 1 };
    }
    return { rows: [], rowCount: null };
  }
}

describe("PostgresSpaceStore task history", () => {
  it("upserts and prunes under one owner transaction without interpolating task objective", async () => {
    const pool = new TaskPgPool();
    const store = new PostgresSpaceStore(pool);

    await store.upsertTaskItem({
      ownerUserId: "user:one",
      title: "Fallback task",
      objective: "fallback",
      status: "OPEN",
      source: "MANUAL"
    });

    expect(pool.calls.map((call) => call.sql.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "SELECT id,",
      "INSERT INTO",
      "DELETE FROM",
      "COMMIT"
    ]);
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO task_items"));
    expect(insert?.sql).toContain("ON CONFLICT (owner_user_id, content_hash)");
    expect(insert?.sql).not.toContain("fallback");
    expect(insert?.values).toContain("fallback");
    expect(insert?.values).toContain("OPEN");
    expect(insert?.values).toContain("MANUAL");
    expect(pool.calls.find((call) => call.sql.includes("NOT IN"))?.sql).toContain("LIMIT 100");
    // Pending scheduled tasks are never pruned.
    expect(pool.calls.find((call) => call.sql.includes("NOT IN"))?.sql).toContain("next_run_at IS NULL");
  });

  it("scopes list, get, update, delete, and clear queries to the authenticated owner", async () => {
    const pool = new TaskPgPool();
    const store = new PostgresSpaceStore(pool);

    expect(await store.listTaskItems("user:one", { q: "fall", status: "OPEN", page: 1, pageSize: 25 }))
      .toEqual({ items: [taskItem], total: 1 });
    expect(await store.getTaskItem("user:one", taskRow.id)).toEqual(taskItem);
    expect(await store.updateTaskItem("user:one", taskRow.id, { status: "DONE" })).toEqual(taskItem);
    expect(await store.deleteTaskItem("user:one", taskRow.id)).toEqual(taskItem);
    expect(await store.clearTaskItems("user:one")).toBe(3);

    const scopedCalls = pool.calls.filter((call) => call.sql.includes("task_items"));
    expect(scopedCalls.every((call) => call.sql.includes("owner_user_id"))).toBe(true);
    expect(scopedCalls.flatMap((call) => call.values)).not.toContain("user:two");
  });

  it("maps a schedule and claims a due run with a compare-and-set on its due time", async () => {
    const pool = new TaskPgPool();
    const store = new PostgresSpaceStore(pool);
    const scheduled = { ...taskRow, recurrence: { kind: "INTERVAL", minutes: 120 }, timeZone: "Europe/Athens", nextRunAt: new Date("2026-10-15T10:00:00.000Z") };
    pool.query = async <T,>(sql: string, values: unknown[] = []) => {
      pool.calls.push({ sql, values });
      return sql.startsWith("UPDATE") ? { rows: [], rowCount: 1 } : { rows: [scheduled as T], rowCount: 1 };
    };
    expect((await store.dueTaskSchedules("2026-10-15T10:00:30.000Z", 5))[0]?.schedule).toEqual({
      recurrence: { kind: "INTERVAL", minutes: 120 }, timeZone: "Europe/Athens", nextRunAt: "2026-10-15T10:00:00.000Z", lastRunAt: null, lastOutcome: null
    });
    expect(await store.claimTaskSchedule(taskRow.id, "2026-10-15T10:00:00.000Z", { nextRunAt: "2026-10-15T12:00:00.000Z", outcome: "Sent.", ran: true })).toBe(true);
    const claim = pool.calls.at(-1)!;
    expect(claim.sql).toContain("WHERE id = $1 AND next_run_at = $2");
    expect(claim.values).toEqual([taskRow.id, "2026-10-15T10:00:00.000Z", "2026-10-15T12:00:00.000Z", "Sent.", true]);
  });
});
