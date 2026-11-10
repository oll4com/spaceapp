// The task history cap on a real, disposable PostgreSQL: the newest-100 prune on every upsert deleted OPEN reminders and
// scheduled tasks between runs (next_run_at NULL) once 100 newer tasks arrived (task loss 2026-10-19). Only DONE/ARCHIVED
// tasks without a schedule are pruned. Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSpaceStore } from "../src/space-store.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Task prune on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let store: PostgresSpaceStore;

  beforeAll(async () => {
    server = await startDisposablePostgres("taskcap");
    await server.createDatabase("space_taskcap");
    pool = server.pool("space_taskcap", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    store = new PostgresSpaceStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps open and scheduled tasks while DONE/ARCHIVED history stays capped at 100", async () => {
    const user = await store.upsertUser({ id: "user:taskcap", email: "taskcap@space.local", role: "ADMIN" });
    const base = { ownerUserId: user.id, source: "MANUAL" as const };
    const kept = [
      await store.upsertTaskItem({ ...base, title: "Daily review", objective: "Run the daily review", status: "OPEN", schedule: { recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Asia/Bangkok" } }),
      await store.upsertTaskItem({ ...base, title: "Reminder", objective: "Call the accountant", status: "OPEN" }),
      await store.upsertTaskItem({ ...base, title: "Ran once", objective: "Pay the invoice", status: "DONE", schedule: { recurrence: { kind: "ONCE", at: "2026-10-15T09:00:00.000Z" }, timeZone: "Asia/Bangkok" } })
    ];
    for (let index = 0; index < 150; index += 1) {
      await store.upsertTaskItem({ ...base, title: `Done ${index}`, objective: `done ${index}`, status: index % 2 ? "DONE" : "ARCHIVED" });
    }

    for (const task of kept) expect(await store.getTaskItem(user.id, task.id)).toMatchObject({ status: task.status, title: task.title });
    expect((await store.listTaskItems(user.id, { page: 1, pageSize: 100 })).total).toBe(103);
    await store.deleteTaskItem(user.id, kept[1]!.id);
    expect(await store.getTaskItem(user.id, kept[1]!.id)).toBeNull();
  }, 60_000);
});
