import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

// K2 §4 invite-gated Google sign-up (plan clipboard:ZGz1LnD51ELH step 7) on the full migrated schema with synthetic people.
describe.skipIf(disposablePostgresUnavailableReason())("headless Google sign-up by invite on PostgreSQL", () => {
  let server: DisposablePostgres, pool: pg.Pool, store: PostgresSpaceStore;
  const now = "2026-11-27T06:00:00.000Z";
  // An OPERATOR invite still makes a USER: a sign-up never takes a platform-wide role.
  const invite = (id: string, email: string) => pool.query(`INSERT INTO user_invites (id, token_sha256, email, role, created_by, expires_at)
    VALUES ($1, $1, $2, 'OPERATOR', 'user:operator', '2026-12-01T00:00:00Z')`, [id, email]);
  const identity = (sub: string, email: string) => ({ sub, email, name: "Synthetic", picture: "https://example.test/a.png" });
  const signUp = (sub: string, email: string) => store.signUpWithGoogleInvite({ identity: identity(sub, email), termsVersion: "terms-2026-11", region: "eu", now });

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-signup");
    await server.createDatabase("nous_signup");
    pool = server.pool("nous_signup", 4);
    for (const migration of await loadMigrations()) await pool.query(migration.sql);
    await pool.query("INSERT INTO users (id, email, role) VALUES ('user:operator', 'owner@signup.test', 'ADMIN') ON CONFLICT DO NOTHING");
    store = new PostgresSpaceStore(pool);
  }, 300_000);
  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  }, 120_000);

  it("an invited email gets its own EU tenant, a USER, the primary Google link and the invite used once", async () => {
    await invite("invite:a", "Alice@Signup.test");
    const user = await signUp("sub-a", "alice@signup.test");
    expect(user).toMatchObject({ email: "alice@signup.test", role: "USER", googleId: "sub-a" });
    const row = (await pool.query("SELECT u.tenant_id, u.terms_version, u.adult_confirmed_at, t.kind, t.region, t.status FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1", [user!.id])).rows[0];
    expect(row).toMatchObject({ terms_version: "terms-2026-11", kind: "PERSONAL", region: "eu", status: "ACTIVE" });
    expect(row.tenant_id).toMatch(/^tenant:/);
    expect(row.tenant_id).not.toBe("tenant:local");
    expect(new Date(row.adult_confirmed_at).toISOString()).toBe(now);
    expect((await pool.query("SELECT tenant_id, is_primary FROM google_accounts WHERE google_sub = 'sub-a'")).rows).toEqual([{ tenant_id: row.tenant_id, is_primary: true }]);
    expect((await pool.query("SELECT accepted_user_id FROM user_invites WHERE id = 'invite:a'")).rows[0].accepted_user_id).toBe(user!.id);
    expect((await store.getUserByGoogleId!("sub-a"))?.id).toBe(user!.id);
    // The invite is spent, and the address is taken: a second Google account with it gets nothing.
    await invite("invite:a2", "alice@signup.test");
    expect(await signUp("sub-a2", "alice@signup.test")).toBeNull();
  });

  it("refuses without an open invite and leaves nothing behind", async () => {
    await invite("invite:expired", "old@signup.test");
    await pool.query("UPDATE user_invites SET expires_at = '2026-11-01T00:00:00Z' WHERE id = 'invite:expired'");
    await invite("invite:revoked", "gone@signup.test");
    await pool.query("UPDATE user_invites SET revoked_at = now() WHERE id = 'invite:revoked'");
    await invite("invite:taken", "owner@signup.test");
    const tenantsBefore = (await pool.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n;
    for (const email of ["nobody@signup.test", "old@signup.test", "gone@signup.test", "owner@signup.test"]) {
      expect(await signUp(`sub-${email}`, email), email).toBeNull();
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n).toBe(tenantsBefore);
    expect((await pool.query("SELECT count(*)::int AS n FROM user_invites WHERE accepted_at IS NOT NULL AND id <> 'invite:a'")).rows[0].n).toBe(0);
  });

  it("two sign-ups racing for one invite make one account", async () => {
    await invite("invite:race", "race@signup.test");
    const results = await Promise.allSettled([signUp("sub-r1", "race@signup.test"), signUp("sub-r2", "race@signup.test")]);
    const made = results.filter((result) => result.status === "fulfilled" && result.value);
    expect(made).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'race@signup.test'")).rows[0].n).toBe(1);
  });
});
