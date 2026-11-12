// Hot read paths write nothing on a real, disposable PostgreSQL (12/11 03:21-03:29 UTC: on a slow disk every operator request's
// no-op users UPDATE and every gateway settings read's upsert queued on one row lock through a WAL flush and filled the API pool).
// A row's xmin changes only when it is rewritten. Skips when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSpaceStore } from "../src/space-store.js";
import { PostgresGatewayRepository } from "../src/gateway-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Read paths on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("nowrite");
    await server.createDatabase("space_nowrite");
    pool = server.pool("space_nowrite", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  const xmin = async (sql: string, values: unknown[] = []) => (await pool.query<{ xmin: string }>(sql, values)).rows[0]?.xmin;

  it("an unchanged user is not rewritten; a role change or a new user still is", async () => {
    const store = new PostgresSpaceStore(pool);
    const first = await store.upsertUser({ id: "user:nowrite", email: "NoWrite@space.local", role: "ADMIN" });
    const before = await xmin("SELECT xmin FROM users WHERE id=$1", [first.id]);
    // Same email in another case and another id (a dev login reusing it): the stored user, untouched.
    await expect(store.upsertUser({ id: "user:other", email: "nowrite@space.local", role: "ADMIN" })).resolves.toEqual(first);
    expect(await xmin("SELECT xmin FROM users WHERE id=$1", [first.id])).toBe(before);
    await expect(store.upsertUser({ id: "user:nowrite", email: "nowrite@space.local", role: "OPERATOR" })).resolves.toMatchObject({ id: first.id, role: "OPERATOR" });
    expect(await xmin("SELECT xmin FROM users WHERE id=$1", [first.id])).not.toBe(before);
    await expect(store.upsertUser({ id: "user:fresh", email: "fresh@space.local", role: "OPERATOR" })).resolves.toEqual({ id: "user:fresh", email: "fresh@space.local", role: "OPERATOR" });
  });

  it("gateway settings reads create the row once and never rewrite it", async () => {
    const repository = new PostgresGatewayRepository(pool);
    await pool.query("DELETE FROM space_gateway_settings");
    await repository.getSettings();
    const before = await xmin("SELECT xmin FROM space_gateway_settings WHERE settings_id=1");
    expect(before).toBeDefined();
    await repository.getSettings();
    await repository.speedDefaults();
    expect(await xmin("SELECT xmin FROM space_gateway_settings WHERE settings_id=1")).toBe(before);
  });
});
