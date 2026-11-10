import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const tables = ["marketing_copilot_runs", "freelance_copilot_runs", "mail_copilot_runs", "job_apply_runs"] as const;
const prefix: Record<(typeof tables)[number], string> = { marketing_copilot_runs: "mktrun", freelance_copilot_runs: "flrun", mail_copilot_runs: "mailrun", job_apply_runs: "jobrun" };
const runId = (table: (typeof tables)[number], suffix: string) => `${prefix[table]}:${suffix}0001`;

// DATA-001 (2026-11-07): stable had 17 copilot runs RUNNING whose pane was deleted, the oldest from 14/10.
describe.skipIf(unavailable !== null)(`Copilot runs of deleted panes on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("orphanruns");
    await server.createDatabase("space_orphan_runs");
    pool = server.pool("space_orphan_runs", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("stops the RUNNING and PAUSED runs whose pane is gone, and leaves live panes' runs and stopped runs alone", async () => {
    const store = new PostgresSpaceStore(pool);
    await store.upsertUser({ id: "user:operator", email: "operator@space.local", role: "ADMIN" });
    const room = await store.createRoom({ name: "Copilots", initialPaneCount: 0 }, "trace:orphanruns", "user:operator");
    const pane = await store.createPane({ roomId: room.id, title: "Live", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
    const at = "2026-10-14T19:11:07.000Z";
    for (const table of tables) {
      for (const [suffix, paneId, status] of [["live", pane.id, "RUNNING"], ["gone", "pane:deleted001", "RUNNING"], ["paused", "pane:deleted002", "PAUSED"],
        ["done", "pane:deleted003", "STOPPED"]] as const) {
        await pool.query(`INSERT INTO ${table} (id, owner_user_id, pane_id, status, started_at, created_at, updated_at) VALUES ($1, 'user:operator', $2, $3, $4, $4, $4)`,
          [runId(table, suffix), paneId, status, at]);
      }
    }
    const { stopped } = await store.stopOrphanedCopilotRuns();
    expect([...stopped].sort((a, b) => `${a.table}${a.id}`.localeCompare(`${b.table}${b.id}`))).toEqual(tables.flatMap((table) =>
      [{ table, id: runId(table, "gone") }, { table, id: runId(table, "paused") }]).sort((a, b) => `${a.table}${a.id}`.localeCompare(`${b.table}${b.id}`)));
    for (const table of tables) {
      const rows = Object.fromEntries((await pool.query<{ id: string; status: string; stopped_at: Date | null }>(`SELECT id, status, stopped_at FROM ${table}`)).rows
        .map((row) => [row.id.slice(prefix[table].length + 1, -4), { status: row.status, stopped: row.stopped_at !== null }]));
      expect(rows).toEqual({ live: { status: "RUNNING", stopped: false }, gone: { status: "STOPPED", stopped: true }, paused: { status: "STOPPED", stopped: true },
        done: { status: "STOPPED", stopped: false } });
    }
    // Nothing is left to stop.
    expect((await store.stopOrphanedCopilotRuns()).stopped).toEqual([]);
  });
});
