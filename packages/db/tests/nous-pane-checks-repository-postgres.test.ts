// Nous pane watch on a real, disposable PostgreSQL (migration 0223, plan clipboard:MAongwnxq9Ro): a read moves only the time,
// a verdict sets verdict, note and next check, and rows are per owner. Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresNousPaneChecksRepository } from "../src/nous-pane-checks-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:nous";

describe.skipIf(unavailable !== null)(`Nous plan marks on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresNousPaneChecksRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-pane-checks");
    await server.createDatabase("space_nous_pane_checks");
    pool = server.pool("space_nous_pane_checks", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "nous@space.local"]);
    repository = new PostgresNousPaneChecksRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps one row per pane: reads move the time, verdicts set verdict, note and next check", async () => {
    const read = await repository.record(owner, { paneId: "pane:andy0001", roomId: "room:bruno0001", at: "2026-10-17T15:00:00.000Z" });
    expect(read).toEqual({ paneId: "pane:andy0001", roomId: "room:bruno0001", checkedAt: "2026-10-17T15:00:00.000Z", verdict: null, note: null, nextCheckAt: null });
    await repository.record(owner, { paneId: "pane:andy0001", roomId: "room:bruno0001", at: "2026-10-17T15:10:00.000Z",
      verdict: { verdict: "WAITING_DATE", note: "Visa on 20 Oct", nextCheckAt: "2026-10-20T08:00:00.000Z" } });
    expect(await repository.record(owner, { paneId: "pane:andy0001", roomId: "room:bruno0001", at: "2026-10-17T15:20:00.000Z" }))
      .toEqual({ paneId: "pane:andy0001", roomId: "room:bruno0001", checkedAt: "2026-10-17T15:20:00.000Z", verdict: "WAITING_DATE", note: "Visa on 20 Oct", nextCheckAt: "2026-10-20T08:00:00.000Z" });
    expect(await repository.list(owner)).toHaveLength(1);
    expect(await repository.list("user:someone")).toEqual([]);
  });
});
