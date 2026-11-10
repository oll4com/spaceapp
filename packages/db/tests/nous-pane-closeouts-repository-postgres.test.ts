// Nous's pane close-outs on a real, disposable PostgreSQL (migration 0243, standing orders 2026-10-21): one row per pane, written
// whole, per owner. Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresNousPaneCloseoutsRepository, type NousPaneCloseout } from "../src/nous-pane-closeouts-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:nous";

describe.skipIf(unavailable !== null)(`Nous pane close-outs on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresNousPaneCloseoutsRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-pane-closeouts");
    await server.createDatabase("space_nous_pane_closeouts");
    pool = server.pool("space_nous_pane_closeouts", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "nous@space.local"]);
    repository = new PostgresNousPaneCloseoutsRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps one row per pane, replaced whole, and lists only the owner's", async () => {
    const row: NousPaneCloseout = { paneId: "pane:andy0001", roomId: "room:main0001", state: "SAVE_REQUESTED", requestedAt: "2026-10-21T10:00:00.000Z",
      retriedAt: null, verifiedMemoryId: null, closedAt: null, reason: null, updatedAt: "2026-10-21T10:00:00.000Z" };
    await repository.save(owner, row);
    expect(await repository.list(owner)).toEqual([row]);
    const closed: NousPaneCloseout = { ...row, state: "CLOSED", verifiedMemoryId: "space_memory:ab12cd34ef56", closedAt: "2026-10-21T10:20:00.000Z", reason: "closed by Nous after its memory save", updatedAt: "2026-10-21T10:20:00.000Z" };
    await repository.save(owner, closed);
    expect(await repository.list(owner)).toEqual([closed]);
    expect(await repository.list("user:someone")).toEqual([]);
    await expect(repository.save(owner, { ...row, paneId: "pane:bob00001", state: "LOST" as never })).rejects.toThrow();
  });
});
