import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";
import { createPostgresAdminOperationStore } from "../../../scripts/cli-maintenance-runner.mjs";
import { runScheduledCliMaintenanceCheck } from "../../../scripts/cli-maintenance-scheduler.mjs";

const unavailable = disposablePostgresUnavailableReason();

// DATA-001: a CLI maintenance row is RUNNING only while a root runner holds the maintenance lock. One killed
// (OOM, SIGKILL, the timer's 45 min stop, a host restart) left it RUNNING, and every later check and the daily repair refused.
describe.skipIf(unavailable !== null)(`CLI maintenance orphans on disposable PostgreSQL${unavailable ? ` (${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  beforeAll(async () => { server = await startDisposablePostgres("cli-maint-orphans"); }, 120_000);
  afterAll(async () => { await server?.stop(); }, 120_000);

  it("the daily repair fails the runs a dead runner left and starts, leaving finished and release runs alone", async () => {
    await server.createDatabase("cli_maint");
    const pool = server.pool("cli_maint");
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
    const at = "2026-11-03T01:00:00.000Z";
    const insert = (id: string, type: string, status: string, result: object) => pool.query(
      `INSERT INTO admin_operation_runs (id, operation_type, status, actor_user_id, summary, result, created_at, started_at, finished_at, updated_at)
       VALUES ($1, $2, $3, NULL, 'fixture', $4, $5, $5, NULL, $5)`, [id, type, status, result, at]);
    await insert("admin_run:OrphanRun123", "CLI_MAINTENANCE_CHECK", "RUNNING", {});
    await insert("admin_run:QueuedRun123", "CLI_MAINTENANCE_APPLY", "QUEUED", { planId: "admin_run:PlanRun12345" });
    await insert("admin_run:FinishedRun1", "CLI_MAINTENANCE_UPDATE", "SUCCEEDED", {});
    await insert("admin_run:ReleaseRun12", "SPACE_RELEASE", "RUNNING", {});

    const store = createPostgresAdminOperationStore(
      `postgresql://postgres@localhost/cli_maint?host=${encodeURIComponent(server.socketDir)}`);
    const executed: string[] = [];
    try {
      const outcome = await runScheduledCliMaintenanceCheck({
        store,
        lock: (work: () => Promise<unknown>) => work(),
        now: () => new Date("2026-11-03T02:00:00.000Z"),
        execute: async (run: { id: string; status: string }) => { executed.push(`${run.id}:${run.status}`); }
      });
      expect(outcome.status).toBe("STARTED");
      expect([...outcome.interrupted].sort()).toEqual(["admin_run:OrphanRun123", "admin_run:QueuedRun123"]);
      expect(executed).toEqual([`${outcome.runId}:QUEUED`]);
    } finally {
      await store.close();
    }

    const rows = (await pool.query<{ id: string; status: string; result: Record<string, unknown>; finished: string | null }>(
      `SELECT id, status, result, finished_at::text AS finished FROM admin_operation_runs ORDER BY id`)).rows;
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    expect(byId["admin_run:OrphanRun123"]).toMatchObject({ status: "FAILED", result: { code: "MAINTENANCE_INTERRUPTED" } });
    expect(byId["admin_run:OrphanRun123"]!.finished).not.toBeNull();
    expect(byId["admin_run:QueuedRun123"]).toMatchObject({ status: "FAILED",
      result: { planId: "admin_run:PlanRun12345", code: "MAINTENANCE_INTERRUPTED" } });
    expect(byId["admin_run:FinishedRun1"]).toMatchObject({ status: "SUCCEEDED", finished: null });
    expect(byId["admin_run:ReleaseRun12"]).toMatchObject({ status: "RUNNING", result: {} });
    expect(rows.filter(row => row.status === "QUEUED").map(row => row.id)).toHaveLength(1);
    await pool.end();
  }, 120_000);
});
