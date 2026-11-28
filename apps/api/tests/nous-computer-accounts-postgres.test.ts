import pg from "pg";
import { PostgresSpaceStore } from "@space/db";
import { loadMigrations } from "../../../packages/db/src/migrations.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../../packages/db/tests/support/disposable-postgres.js";
import { AccountStateError, DELETION_UNDO_MS, createAccountLifecycle } from "../src/computer/accounts.js";
import { createFakeCellDriver } from "../src/computer/cell-driver.js";
import { CellSuspendedError, createCellOrchestrator, createMemoryCellStore } from "../src/computer/cells.js";
import { createCellProvisioner } from "../src/computer/provisioning.js";

// K4 account lifecycle and the K1 purge on the full migrated schema (synthetic tenants and people, fake cell driver and fake gateway keys).
describe.skipIf(disposablePostgresUnavailableReason())("nous computer account lifecycle on PostgreSQL", () => {
  let server: DisposablePostgres, pool: pg.Pool;
  beforeAll(async () => {
    server = await startDisposablePostgres("nous-accounts");
    await server.createDatabase("nous_accounts");
    pool = server.pool("nous_accounts", 2);
    for (const migration of await loadMigrations()) await pool.query(migration.sql);
    await pool.query("INSERT INTO tenants (id, region) VALUES ('tenant:a', 'eu'), ('tenant:b', 'eu'), ('tenant:c', 'eu'), ('tenant:d', 'eu'), ('tenant:e', 'eu'), ('tenant:f', 'eu')");
  }, 300_000);
  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  }, 120_000);

  function setup() {
    let t = 1_800_000_000_000;
    const driver = createFakeCellDriver({ advance: (ms) => (t += ms) });
    const cells = createCellOrchestrator({ driver, store: createMemoryCellStore(), hosts: [{ id: "h1", ramMib: 8192, maxAwake: 4 }], now: () => t });
    const keyCalls: string[] = [];
    const keys = { setStatus: async (tenantId: string, status: string) => void keyCalls.push(`${tenantId} ${status}`) };
    const accounts = createAccountLifecycle({ pool, cells, keys, now: () => t });
    const provisioner = createCellProvisioner({ pool, cells, region: "eu" });
    const tenant = async (id: string) => (await pool.query("SELECT status, status_before_deletion, deletion_requested_at FROM tenants WHERE id = $1", [id])).rows[0];
    return { accounts, provisioner, cells, driver, keyCalls, tenant, advance: (ms: number) => (t += ms) };
  }

  it("suspends and resumes: gate, keys and cell move together", async () => {
    const { accounts, provisioner, cells, keyCalls, tenant } = setup();
    await provisioner.ensureTenantCell("tenant:a");
    await accounts.suspend("tenant:a", "chargeback");
    expect((await tenant("tenant:a")).status).toBe("FROZEN");
    expect((await cells.cell("tenant:a"))?.state).toBe("SLEEPING");
    await expect(provisioner.ensureTenantCell("tenant:a")).rejects.toBeInstanceOf(CellSuspendedError);
    await accounts.suspend("tenant:a", "retry"); // idempotent
    await accounts.resume("tenant:a", "resolved");
    expect((await tenant("tenant:a")).status).toBe("ACTIVE");
    expect((await provisioner.ensureTenantCell("tenant:a")).from).toBe("SLEEPING");
    expect(keyCalls).toEqual(["tenant:a FROZEN", "tenant:a FROZEN", "tenant:a ACTIVE"]);
  });

  it("deletes after the undo window with an export first; a cancel restores the earlier status", async () => {
    const { accounts, provisioner, cells, driver, keyCalls, tenant, advance } = setup();
    await provisioner.ensureTenantCell("tenant:b");
    const { exportKey, deleteAfter } = await accounts.requestDeletion("tenant:b", "user asked");
    expect(exportKey).toBeTruthy();
    expect(await tenant("tenant:b")).toMatchObject({ status: "DELETING", status_before_deletion: "ACTIVE" });
    await expect(accounts.suspend("tenant:b", "x")).rejects.toBeInstanceOf(AccountStateError);
    await expect(accounts.resume("tenant:b", "x")).rejects.toBeInstanceOf(AccountStateError);
    await expect(accounts.finishDeletion("tenant:b", "x")).rejects.toThrow(/can still cancel/);
    expect((await accounts.requestDeletion("tenant:b", "again")).deleteAfter).toBe(deleteAfter); // a repeat keeps the first clock

    await accounts.cancelDeletion("tenant:b", "undo");
    expect(await tenant("tenant:b")).toEqual({ status: "ACTIVE", status_before_deletion: null, deletion_requested_at: null });
    expect((await provisioner.ensureTenantCell("tenant:b")).hostId).toBe("h1");

    await accounts.requestDeletion("tenant:b", "user asked");
    advance(DELETION_UNDO_MS);
    await accounts.finishDeletion("tenant:b", "undo window over");
    expect((await cells.cell("tenant:b"))?.state).toBe("DELETED");
    expect(driver.calls.some((call) => call.op === "destroy" && call.tenantId === "tenant:b")).toBe(true);
    expect(keyCalls.at(-1)).toBe("tenant:b REVOKED");
    await expect(accounts.cancelDeletion("tenant:b", "too late")).rejects.toBeInstanceOf(AccountStateError);
    expect((await tenant("tenant:b")).status).toBe("DELETING");
  });

  it("keeps a suspended account suspended when its deletion is cancelled, and handles a tenant with no cell", async () => {
    const { accounts, cells, keyCalls, tenant } = setup();
    await accounts.suspend("tenant:c", "abuse");
    expect((await accounts.requestDeletion("tenant:c", "user asked")).exportKey).toBeNull();
    await accounts.cancelDeletion("tenant:c", "undo");
    expect((await tenant("tenant:c")).status).toBe("FROZEN");
    expect(keyCalls.filter((call) => call.endsWith("ACTIVE"))).toEqual([]);
    expect((await cells.cell("tenant:c"))?.suspendedAt).not.toBeNull();
    await expect(accounts.cancelDeletion("tenant:c", "twice")).rejects.toBeInstanceOf(AccountStateError);
    await expect(accounts.suspend("tenant:none", "x")).rejects.toThrow(/does not exist/);
  });

  it("the sweep finishes each deletion past its window once, skips the rest and keeps going past a failure", async () => {
    const { accounts, provisioner, cells, keyCalls, advance } = setup();
    // tenant:d and tenant:e pass their window; tenant:f asks a day later and is still inside it.
    await provisioner.ensureTenantCell("tenant:d");
    await accounts.requestDeletion("tenant:d", "user asked");
    await accounts.requestDeletion("tenant:e", "user asked");
    advance(24 * 60 * 60_000);
    await accounts.requestDeletion("tenant:f", "user asked");
    advance(DELETION_UNDO_MS - 24 * 60 * 60_000);
    await pool.query("CREATE OR REPLACE FUNCTION refuse_e() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = 'tenant:e' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$");
    await pool.query("CREATE TRIGGER refuse_e BEFORE UPDATE OF deletion_finished_at ON tenants FOR EACH ROW EXECUTE FUNCTION refuse_e()");
    const first = await accounts.finishDueDeletions("window over");
    expect(first.finished).toEqual(["tenant:d"]);
    expect(first.failed).toEqual([{ tenantId: "tenant:e", error: expect.stringMatching(/synthetic failure/) }]);
    expect((await cells.cell("tenant:d"))?.state).toBe("DELETED");
    await pool.query("DROP TRIGGER refuse_e ON tenants");
    expect((await accounts.finishDueDeletions("window over")).finished).toEqual(["tenant:e"]); // retried
    expect(await accounts.finishDueDeletions("window over")).toEqual({ finished: [], failed: [] }); // once each; tenant:f still inside
    advance(24 * 60 * 60_000);
    expect((await accounts.finishDueDeletions("window over")).finished).toEqual(["tenant:f"]);
    expect(keyCalls.filter((call) => call.endsWith("REVOKED"))).toEqual(["tenant:d REVOKED", "tenant:e REVOKED", "tenant:e REVOKED", "tenant:f REVOKED"]);
  });

  it("the purge removes every row of the tenant and frees its email for a new invite; other tenants keep theirs", async () => {
    const { accounts, advance } = setup();
    const store = new PostgresSpaceStore(pool);
    const invite = (id: string) => pool.query(`INSERT INTO user_invites (id, token_sha256, email, role, created_by, expires_at)
      VALUES ($1, $1, 'gone@purge.test', 'USER', 'user:operator', '2099-01-01T00:00:00Z')`, [id]);
    const signUp = (sub: string) => store.signUpWithGoogleInvite({ identity: { sub, email: "gone@purge.test", name: "Synthetic", picture: "" }, termsVersion: "terms-1", region: "eu", now: new Date().toISOString() });
    await pool.query("INSERT INTO users (id, email, role) VALUES ('user:operator', 'owner@purge.test', 'ADMIN') ON CONFLICT DO NOTHING");
    await invite("invite:first");
    const user = (await signUp("sub-first"))!;
    const tenantId = (await pool.query("SELECT tenant_id FROM users WHERE id = $1", [user.id])).rows[0].tenant_id as string;
    await pool.query("INSERT INTO public_waitlist_signups (email, source) VALUES ('gone@purge.test', 'HOMEPAGE'), ('kept@purge.test', 'HOMEPAGE')");
    // The tenant's own rooms and panes, written the way requests write them: tenant_id comes from the session's tenant.
    const tenantPool = new pg.Pool({ host: server.socketDir, user: "postgres", database: "nous_accounts", max: 1, options: `-c space.tenant_id=${tenantId}` });
    try {
      await new PostgresSpaceStore(tenantPool).createRoom({ name: "Mine", initialPaneCount: 2 }, undefined, user.id);
    } finally {
      await tenantPool.end();
    }
    // purge_a sorts first but purge_b's rows reference it: the purge must retry it after the children.
    await pool.query(`CREATE TABLE purge_a (id text PRIMARY KEY, tenant_id text NOT NULL);
      CREATE TABLE purge_b (id text PRIMARY KEY, tenant_id text NOT NULL, a_id text REFERENCES purge_a (id) ON DELETE RESTRICT)`);
    await pool.query("INSERT INTO purge_a VALUES ('a1', $1), ('a2', 'tenant:other')", [tenantId]);
    await pool.query("INSERT INTO purge_b VALUES ('b1', $1, 'a1'), ('b2', 'tenant:other', 'a2')", [tenantId]);
    const count = async (sql: string) => (await pool.query(sql, [tenantId])).rows[0].n as number;
    expect(await count("SELECT count(*)::int AS n FROM panes WHERE tenant_id = $1")).toBe(2);

    await accounts.requestDeletion(tenantId, "user asked");
    advance(DELETION_UNDO_MS);
    expect((await accounts.finishDueDeletions("window over")).finished).toEqual([tenantId]);

    const tables = (await pool.query("SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'tenant_id' AND table_name <> 'nous_computer_cells'")).rows.map((row) => row.table_name as string);
    expect(tables.length).toBeGreaterThan(200);
    for (const table of tables) expect(await count(`SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = $1`), table).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM purge_a WHERE tenant_id <> $1")).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM purge_b WHERE tenant_id <> $1")).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM user_invites WHERE id = 'invite:first' AND $1 <> ''")).toBe(0);
    expect((await pool.query("SELECT email FROM public_waitlist_signups")).rows).toEqual([{ email: "kept@purge.test" }]);
    expect((await pool.query("SELECT status, deletion_finished_at IS NOT NULL AS finished FROM tenants WHERE id = $1", [tenantId])).rows[0]).toEqual({ status: "DELETING", finished: true });

    // The email is free again: a new invite makes a new account in a new tenant.
    await invite("invite:second");
    const again = await signUp("sub-second");
    expect(again?.email).toBe("gone@purge.test");
    expect((await pool.query("SELECT tenant_id FROM users WHERE id = $1", [again!.id])).rows[0].tenant_id).not.toBe(tenantId);
  });
});
