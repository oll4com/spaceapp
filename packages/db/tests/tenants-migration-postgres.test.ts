// K1 tenancy M0-M6 (migrations 0359-0409, tenant-context.ts) on a real, disposable PostgreSQL: rows that exist before them land in tenant:local, and
// every insert path that names no tenant keeps working unchanged. Skips when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSpaceStore } from "../src/space-store.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { tenantScopedPool, withTenant } from "../src/tenant-context.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Tenants M0-M6 0359-0409${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("tenants");
    await server.createDatabase("space_tenants");
    pool = server.pool("space_tenants", 2);
    const migrations = await loadMigrations();
    const until = (filename: string) => migrations.slice(0, migrations.findIndex((migration) => migration.filename === filename));
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, until("0359_tenants.sql"));
      await client.query("INSERT INTO users (id, email, role) VALUES ('user:operator', 'operator@example.com', 'ADMIN')");
      await applyPendingMigrations(client, until("0372_tenant_id_m2_part01.sql"));
      await new PostgresSpaceStore(pool).createRoom({ name: "Before M2" }, undefined, "user:operator");
      await applyPendingMigrations(client, until("0409_channel_provider_tenant.sql"));
      await client.query(`INSERT INTO channel_identities (identity_id, provider, tenant_id, external_user_id, owner_user_id, reply_address)
        VALUES ('channel_identity:${"a".repeat(32)}', 'SLACK', 'T1', 'U1', 'user:operator', 'U1')`);
      await applyPendingMigrations(client, migrations);
    } finally {
      client.release();
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("puts existing and new users in tenant:local and refuses an unknown tenant", async () => {
    await new PostgresSpaceStore(pool).upsertUser({ id: "user:second", email: "second@example.com", role: "OPERATOR" });
    const users = await pool.query("SELECT id, tenant_id FROM users ORDER BY id");
    expect(users.rows).toEqual([{ id: "user:operator", tenant_id: "tenant:local" }, { id: "user:second", tenant_id: "tenant:local" }]);
    expect(await new PostgresSpaceStore(pool).getUserTenantId("user:second")).toBe("tenant:local");
    expect(await new PostgresSpaceStore(pool).getUserTenantId("user:nobody")).toBeNull();
    expect((await pool.query("SELECT id, kind, status FROM tenants")).rows).toEqual([{ id: "tenant:local", kind: "PERSONAL", status: "ACTIVE" }]);
    await expect(pool.query("UPDATE users SET tenant_id = 'tenant:other' WHERE id = 'user:second'")).rejects.toThrow(/foreign key/);
    await expect(pool.query("UPDATE users SET tenant_id = NULL WHERE id = 'user:second'")).rejects.toThrow(/null value/);
  });

  it("M1-M3 fill tenant_id with tenant:local for old rows and today's inserts, the session's tenant when one is set", async () => {
    const nullable = await pool.query(`SELECT table_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'tenant_id' AND is_nullable = 'YES'`);
    expect(nullable.rows).toEqual([]);
    const empty = await pool.query(`SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.column_name = 'tenant_id' AND c.column_default IS NULL
        AND c.table_name <> 'nous_computer_cells'`); // 0415: GLOBAL_PLATFORM (tenant-scope.test.mjs), tenant_id is its key, always named
    expect(empty.rows).toEqual([]);
    await new PostgresSpaceStore(pool).createRoom({ name: "After M2" }, undefined, "user:operator");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('space.tenant_id', 'tenant:probe', true)");
      await client.query("INSERT INTO nous_notes (owner_user_id, key, text) VALUES ('user:operator', 'probe', 'Session tenant')");
      await client.query("COMMIT");
      // set_config(..., true) leaves '' behind after the transaction on a pooled connection: still tenant:local.
      await client.query("INSERT INTO nous_notes (owner_user_id, key, text) VALUES ('user:operator', 'after', 'Reused connection')");
    } finally {
      client.release();
    }
    expect((await pool.query("SELECT name, tenant_id FROM rooms ORDER BY name")).rows).toEqual([
      { name: "After M2", tenant_id: "tenant:local" },
      { name: "Before M2", tenant_id: "tenant:local" }
    ]);
    expect((await pool.query("SELECT text, tenant_id FROM nous_notes ORDER BY text")).rows).toEqual([
      { text: "Reused connection", tenant_id: "tenant:local" },
      { text: "Session tenant", tenant_id: "tenant:probe" }
    ]);
  });

  it("M4: a role that owns no table sees and writes only its transaction's tenant; the owner (today's API, dev's space_dev) everything", async () => {
    await pool.query("CREATE ROLE k1_app NOLOGIN NOBYPASSRLS; GRANT SELECT, INSERT ON nous_notes TO k1_app; CREATE ROLE k1_owner NOLOGIN NOBYPASSRLS");
    const client = await pool.connect();
    const as = async (role: string, tenant: string | null, sql: string) => {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL ROLE ${role}`);
        if (tenant) await client.query("SELECT set_config('space.tenant_id', $1, true)", [tenant]);
        return (await client.query(sql)).rows;
      } finally {
        await client.query("ROLLBACK");
      }
    };
    try {
      expect(await as("k1_app", null, "SELECT text FROM nous_notes")).toEqual([]);
      expect(await as("k1_app", "tenant:local", "SELECT text FROM nous_notes")).toEqual([{ text: "Reused connection" }]);
      expect(await as("k1_app", "tenant:probe", "INSERT INTO nous_notes (owner_user_id, key, text) VALUES ('user:operator', 'k1', 'x') RETURNING tenant_id"))
        .toEqual([{ tenant_id: "tenant:probe" }]);
      await expect(as("k1_app", "tenant:local", "INSERT INTO nous_notes (owner_user_id, key, text, tenant_id) VALUES ('user:operator', 'k1', 'x', 'tenant:probe')"))
        .rejects.toThrow(/row-level security/);
      await pool.query("ALTER TABLE nous_notes OWNER TO k1_owner");
      expect((await as("k1_owner", null, "SELECT count(*)::int AS n FROM nous_notes"))[0]).toEqual({ n: 2 });
    } finally {
      client.release();
    }
    const secured = await pool.query("SELECT count(*)::int AS n FROM pg_class WHERE relrowsecurity AND relnamespace = current_schema()::regnamespace");
    expect(secured.rows[0].n).toBe(236); // 0412 added mail_campaign_web_copies
  });

  it("0409: the channel tables' provider tenant is kept as provider_tenant_id, and they get our tenant_id like every TENANT table", async () => {
    expect((await pool.query("SELECT provider_tenant_id, tenant_id FROM channel_identities")).rows).toEqual([{ provider_tenant_id: "T1", tenant_id: "tenant:local" }]);
    const { PostgresChannelsRepository } = await import("../src/channels-repository.js");
    expect(await new PostgresChannelsRepository(pool).identity("SLACK", "T1", "U1")).toMatchObject({ tenantId: "T1", ownerUserId: "user:operator" });
  });

  it("M5: space_app (row-level security applies) and space_system (bypasses it) may use every table, and the tables made after", async () => {
    const roles = await pool.query("SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('space_app', 'space_system') ORDER BY rolname");
    expect(roles.rows).toEqual([
      { rolname: "space_app", rolbypassrls: false, rolcanlogin: false },
      { rolname: "space_system", rolbypassrls: true, rolcanlogin: false }
    ]);
    await pool.query("CREATE TABLE k1_later (id serial PRIMARY KEY)");
    const may = await pool.query(`SELECT has_table_privilege('space_app', 'nous_notes', 'SELECT, INSERT, UPDATE, DELETE') AS app,
      has_table_privilege('space_system', 'nous_notes', 'SELECT, INSERT, UPDATE, DELETE') AS system,
      has_table_privilege('space_app', 'k1_later', 'INSERT') AS later, has_sequence_privilege('space_app', 'k1_later_id_seq', 'USAGE') AS sequence,
      has_database_privilege('space_app', current_database(), 'TEMPORARY') AS temporary`);
    expect(may.rows[0]).toEqual({ app: true, system: true, later: true, sequence: true, temporary: true });
  });

  it("M6: a tenant-scoped pool works as space_app in the context's tenant and as the owner outside one, on the same connection", async () => {
    const scoped = tenantScopedPool(server.pool("space_tenants", 1));
    const notes = async () => (await scoped.query("SELECT current_user AS role, text FROM nous_notes ORDER BY text")).rows;
    expect(await notes()).toEqual([{ role: "postgres", text: "Reused connection" }, { role: "postgres", text: "Session tenant" }]);
    expect(await withTenant("tenant:local", notes)).toEqual([{ role: "space_app", text: "Reused connection" }]);
    expect(await withTenant("tenant:probe", async () => {
      const client = await scoped.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query("INSERT INTO nous_notes (owner_user_id, key, text) VALUES ('user:operator', 'm6', 'Probe insert') RETURNING tenant_id");
        await client.query("COMMIT");
        return inserted.rows;
      } finally {
        client.release();
      }
    })).toEqual([{ tenant_id: "tenant:probe" }]);
    expect(await withTenant("tenant:probe", notes)).toEqual([{ role: "space_app", text: "Probe insert" }, { role: "space_app", text: "Session tenant" }]);
    expect((await notes()).map((row) => row.role)).toEqual(["postgres", "postgres", "postgres"]);
  });
});
