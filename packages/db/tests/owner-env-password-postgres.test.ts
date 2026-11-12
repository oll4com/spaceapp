// adoptOwnerPassword on a real, disposable PostgreSQL (Settings → Login password for the .env operator, 12/11): the owner row is created
// or kept for that user only, with the replaced .env hash's fingerprint. Skips when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSpaceStore } from "../src/space-store.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Owner password from .env${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let store: PostgresSpaceStore;

  beforeAll(async () => {
    server = await startDisposablePostgres("ownerenv");
    await server.createDatabase("space_ownerenv");
    pool = server.pool("space_ownerenv", 2);
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

  it("makes the .env operator the owner with the new hash, refuses anyone else, and keeps the row on a second change", async () => {
    const operator = await store.upsertUser({ id: "user:operator", email: "operator@example.com", role: "ADMIN" });
    await store.upsertUser({ id: "user:other", email: "other@example.com", role: "ADMIN" });
    expect(await store.getOwnerCredentials()).toBeNull();
    expect(await store.adoptOwnerPassword(operator.id, "scrypt$1$1$1$a$b", "a".repeat(64))).toBe(true);
    expect(await store.getOwnerCredentials()).toEqual({ user: operator, passwordHash: "scrypt$1$1$1$a$b", envPasswordSha256: "a".repeat(64) });
    expect(await store.adoptOwnerPassword("user:other", "scrypt$1$1$1$c$d", "b".repeat(64))).toBe(false);
    expect(await store.adoptOwnerPassword(operator.id, "scrypt$1$1$1$e$f", "c".repeat(64))).toBe(true);
    expect(await store.getOwnerCredentials()).toMatchObject({ passwordHash: "scrypt$1$1$1$e$f", envPasswordSha256: "c".repeat(64) });
    expect((await store.getOwnerOnboarding()).isComplete).toBe(true);
    await store.setUserDisabled(operator.id, true, new Date().toISOString());
    expect(await store.adoptOwnerPassword(operator.id, "scrypt$1$1$1$g$h", "d".repeat(64))).toBe(false);
  });
});
