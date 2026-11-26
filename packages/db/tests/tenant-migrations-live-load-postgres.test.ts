// K1 tenancy M2-M4 (0379-0407) on a database in stable's state of 2026-11-23 (0359-0378 applied) while the API is live:
// an API transaction that read a table M2 alters, then writes a row M2 fills, must neither deadlock nor fail the migration.
// Repro of promote q-20261123-005136-8155 (40P01 on 0379). Skips when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Tenancy 0379-0407 under live API load${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("tenant-live-load");
    await server.createDatabase("space_tenant_live");
    pool = server.pool("space_tenant_live", 4);
    const migrations = await loadMigrations();
    await applyPendingMigrations(pool, migrations.slice(0, migrations.findIndex((m) => m.filename === "0379_tenant_id_m2_part08.sql")));
    await pool.query(`INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload) VALUES ('probe', 'room', 'room:x', 'probe', '{}')`);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("applies with an API transaction holding nous_programs and then writing outbox_events (both in 0379)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = await pool.connect();
    const migrator = await pool.connect();
    try {
      await api.query("BEGIN");
      await api.query("SELECT 1 FROM nous_programs LIMIT 1");
      const migrating = applyPendingMigrations(migrator, await loadMigrations());
      // Wait until the migration queues for nous_programs behind the API's read.
      await expect.poll(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE NOT l.granted AND c.relname = 'nous_programs'`)).rows[0].n, { timeout: 30_000, interval: 50 }).toBe(1);
      await api.query("UPDATE outbox_events SET published_at = now() WHERE id = 'probe'");
      await api.query("COMMIT");
      await migrating;
    } finally {
      api.release();
      migrator.release();
    }
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/40P01/);
    const applied = await pool.query("SELECT count(*)::int AS n FROM space_schema_migrations WHERE id >= '0379' AND id < '0408'");
    expect(applied.rows[0].n).toBe(29);
    expect((await pool.query("SELECT tenant_id FROM outbox_events WHERE id = 'probe'")).rows).toEqual([{ tenant_id: "tenant:local" }]);
  }, 120_000);
});
