import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemorySpaceStore, type SpaceStore } from "@space/runtime";
import { loadMigrations, PostgresSpaceStore } from "@space/db";
import type pg from "pg";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../../packages/db/tests/support/disposable-postgres.js";

// PostgreSQL in the shared disposable container (never pulled): without Docker or its image the PostgreSQL cases skip, as in
// every *-postgres test, and the in-memory registry cases still run.
const postgresUnavailable = disposablePostgresUnavailableReason();
if (postgresUnavailable) process.stderr.write(`[google accounts] PostgreSQL cases skipped: ${postgresUnavailable}\n`);
let postgres: DisposablePostgres | undefined;
let pool: pg.Pool;
const database = `google_accounts_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  const available = await loadMigrations();
  expect(available.find(item => item.id === "0132_google_accounts"), "Google registry migration must exist").toBeDefined();
  if (postgresUnavailable) return;
  postgres = await startDisposablePostgres("google-accounts");
  await postgres.createDatabase(database);
  pool = postgres.pool(database, 6);
  const migrations = await loadMigrations();
  for (const migration of migrations.filter(item => item.id < "0132_google_accounts")) await pool.query(migration.sql);
  await pool.query(`INSERT INTO users(id,email,role,google_id) VALUES ('google:legacy','legacy@example.test','ADMIN','legacy-sub');`);
  const migration = migrations.find(item => item.id === "0132_google_accounts");
  expect(migration, "Google registry migration must exist").toBeDefined();
  await pool.query(migration!.sql);
}, 150_000);
afterAll(async () => { await postgres?.stop(); });

it.skipIf(postgresUnavailable)("migrates legacy login to a stable primary and survives replay without duplication", async () => {
  const store = new PostgresSpaceStore(pool);
  const before = await store.listGoogleAccounts("google:legacy");
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ googleSub: "legacy-sub", isPrimary: true, ownerUserId: "google:legacy" });
  await pool.query((await loadMigrations()).find(item => item.id === "0132_google_accounts")!.sql);
  expect(await store.listGoogleAccounts("google:legacy")).toEqual(before);
  expect(await store.getUserByGoogleId("legacy-sub")).toMatchObject({ id: "google:legacy", googleId: "legacy-sub", role: "ADMIN" });
});

it.skipIf(postgresUnavailable)("prevents legacy rollback writers from silently diverging from the SSO registry", async () => {
  const store = new PostgresSpaceStore(pool);
  await expect(pool.query("UPDATE users SET google_id=NULL WHERE id='google:legacy'")).rejects.toThrow(/registry/);
  await expect(pool.query("UPDATE users SET google_id='rollback-new-sub' WHERE id='google:legacy'")).rejects.toThrow(/registry/);
  expect(await store.getUserByGoogleId("legacy-sub")).toMatchObject({ id: "google:legacy" });
  expect(await store.getUserByGoogleId("rollback-new-sub")).toBeNull();
  // Unrelated old-code password/session upserts still work.
  await pool.query("UPDATE users SET updated_at=now() WHERE id='google:legacy'");
});

for (const backend of ["memory", "postgres"] as const) describe.skipIf(backend === "postgres" && postgresUnavailable)(`${backend} Google registry`, () => {
  let store: SpaceStore;
  let owner: string;
  let other: string;
  beforeAll(() => { store = backend === "memory" ? new InMemorySpaceStore() : new PostgresSpaceStore(pool); });
  async function users() {
    owner = `user:${randomUUID()}`; other = `user:${randomUUID()}`;
    await store.upsertUser({ id: owner, email: `${owner.slice(5)}@example.test`, role: "ADMIN" });
    await store.upsertUser({ id: other, email: `${other.slice(5)}@example.test`, role: "USER" });
  }
  it("keeps two subs on one user, primary compatibility and stable duplicate IDs", async () => {
    await users();
    const a = await store.linkGoogleAccount(owner, { sub: `${owner}-a`, email: "a@example.test", name: "A" });
    const b = await store.linkGoogleAccount(owner, { sub: `${owner}-b`, email: "b@example.test" });
    const duplicate = await store.linkGoogleAccount(owner, { sub: `${owner}-b`, email: "new-b@example.test", name: "B" });
    expect(duplicate.id).toBe(b.id);
    expect(await store.listGoogleAccounts(owner)).toHaveLength(2);
    expect(await store.listGoogleAccounts(other)).toEqual([]);
    for (const sub of [a.googleSub, b.googleSub]) expect(await store.getUserByGoogleId!(sub)).toMatchObject({ id: owner, role: "ADMIN", googleId: a.googleSub });
    await store.setPrimaryGoogleAccount(owner, b.id);
    expect(await store.getControlActor(owner)).toMatchObject({ googleId: b.googleSub });
    expect(await store.listGoogleAccounts(owner)).toEqual(expect.arrayContaining([expect.objectContaining({ id: a.id, isPrimary: false }), expect.objectContaining({ id: b.id, isPrimary: true })]));
  });
  it("rejects cross-user claims and changes without exposing an account", async () => {
    await users();
    const a = await store.linkGoogleAccount(owner, { sub: `${owner}-a`, email: "a@example.test" });
    await expect(Promise.resolve().then(() => store.linkGoogleAccount(other, { sub: a.googleSub, email: "a@example.test" }))).rejects.toThrow(/already linked/);
    await expect(Promise.resolve().then(() => store.setPrimaryGoogleAccount(other, a.id))).rejects.toThrow(/not found/);
    await expect(Promise.resolve().then(() => store.removeGoogleAccount(other, a.id, true))).rejects.toThrow(/not found/);
    expect(await store.getUserByGoogleId!(a.googleSub)).toMatchObject({ id: owner });
  });
  it("promotes the remaining account and prevents removal of the final login", async () => {
    await users();
    const a = await store.linkGoogleAccount(owner, { sub: `${owner}-a`, email: "a@example.test" });
    const b = await store.linkGoogleAccount(owner, { sub: `${owner}-b`, email: "b@example.test" });
    await store.removeGoogleAccount(owner, a.id, false);
    expect(await store.getUserByGoogleId!(a.googleSub)).toBeNull();
    expect(await store.getControlActor(owner)).toMatchObject({ googleId: b.googleSub });
    await expect(Promise.resolve().then(() => store.removeGoogleAccount(owner, b.id, false))).rejects.toThrow(/last.*login/);
    await store.removeGoogleAccount(owner, b.id, true);
    expect(await store.listGoogleAccounts(owner)).toEqual([]);
    expect(await store.getControlActor(owner)).toMatchObject({ googleId: null });
  });
  it("serializes competing claims, primary updates and final removals", async () => {
    await users();
    const sub = `${owner}-shared`;
    const claims = await Promise.allSettled([owner, other].map(id => Promise.resolve().then(() => store.linkGoogleAccount(id, { sub, email: "shared@example.test" }))));
    expect(claims.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const a = (claims[0] as PromiseFulfilledResult<Awaited<ReturnType<SpaceStore["linkGoogleAccount"]>>>).value;
    const actualOwner = a?.ownerUserId ?? other;
    const b = await store.linkGoogleAccount(actualOwner, { sub: `${owner}-b`, email: "b@example.test" });
    const accounts = await store.listGoogleAccounts(actualOwner);
    await Promise.all(accounts.map(account => store.setPrimaryGoogleAccount(actualOwner, account.id)));
    expect((await store.listGoogleAccounts(actualOwner)).filter(account => account.isPrimary)).toHaveLength(1);
    const removals = await Promise.allSettled(accounts.map(account => Promise.resolve().then(() => store.removeGoogleAccount(actualOwner, account.id, false))));
    expect(removals.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const remaining = await store.listGoogleAccounts(actualOwner);
    expect(remaining).toHaveLength(1);
    expect(await store.getControlActor(actualOwner)).toMatchObject({ googleId: remaining[0]!.googleSub });
  });
});
