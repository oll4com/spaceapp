// Nous RSI change ledger on a real, disposable PostgreSQL (migration 0423, plan clipboard:CCIzkVBIbPpG step 1): one row per ref,
// measured once. Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresNousChangesRepository, type NousChange } from "../src/nous-changes-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:nous";

describe.skipIf(unavailable !== null)(`Nous changes on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresNousChangesRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-changes");
    await server.createDatabase("space_nous_changes");
    pool = server.pool("space_nous_changes", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "nous@space.local"]);
    repository = new PostgresNousChangesRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps the first row of a ref and measures it once", async () => {
    const change: NousChange = { ownerUserId: owner, kind: "CODE", ref: "q-20261110-120000-8149", cause: "space_db_query guessed columns", metric: "tool:space_db_query",
      deployedAt: "2026-11-10T12:00:00.000Z", before: { count: 57, turns: 3000 }, after: null, verdict: null, measuredAt: null };
    expect(await repository.add(change)).toBe(true);
    expect(await repository.add({ ...change, cause: "a second line naming the ticket" })).toBe(false);
    expect(await repository.add({ ...change, ref: "q-20261110-120100-08a5", metric: null, before: null, verdict: "UNMEASURED", measuredAt: "2026-11-11T00:00:00.000Z" })).toBe(true);
    expect(await repository.list(owner)).toEqual([change, expect.objectContaining({ ref: "q-20261110-120100-08a5", verdict: "UNMEASURED", before: null })]);

    await repository.measured(owner, "CODE", change.ref, { count: 8, turns: 3100 }, "KEPT", new Date("2026-11-17T13:00:00.000Z"));
    await repository.measured(owner, "CODE", change.ref, { count: 99, turns: 1 }, "WORSE");
    expect((await repository.list(owner))[0]).toEqual({ ...change, after: { count: 8, turns: 3100 }, verdict: "KEPT", measuredAt: "2026-11-17T13:00:00.000Z" });
  });
});
