import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrationDirectory } from "@space/db";
import { applyPendingMigrations } from "../../db/src/migration-runner.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../db/tests/support/disposable-postgres.js";
import { GATEWAY_PARTS, migrateNgw, SPACE_GATEWAY_MIGRATIONS } from "../src/nous/migrate.js";
import { NGW_MIGRATIONS } from "../src/nous/schema.js";

// K5-migrations: the gateway's own set gives exactly Space's space_gateway_* schema, plus the Nous tables, and nothing else.
const unavailable = disposablePostgresUnavailableReason();
const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("Nous Gateway migration set", () => {
  it("lists every Space migration that touches space_gateway_, and each gateway part is the file's own text", () => {
    const touching = readdirSync(migrationDirectory).filter((file) => file.endsWith(".sql") && readFileSync(join(migrationDirectory, file), "utf8").includes("space_gateway_"));
    expect([...touching].sort()).toEqual([...SPACE_GATEWAY_MIGRATIONS].sort());
    for (const [file, part] of Object.entries(GATEWAY_PARTS)) expect(squash(readFileSync(join(migrationDirectory, file), "utf8"))).toContain(squash(part));
  });
});

describe.skipIf(unavailable)("Nous Gateway migrations on PostgreSQL", () => {
  let server: DisposablePostgres;
  let ngw: pg.Pool, space: pg.Pool;
  beforeAll(async () => {
    server = await startDisposablePostgres("ngw-migrations");
    await server.createDatabase("ngw");
    await server.createDatabase("space");
    ngw = server.pool("ngw", 1);
    space = server.pool("space", 1);
  }, 120_000);
  afterAll(async () => { await server?.stop(); }, 60_000);

  // Partitions of the request logs are the Nous Gateway's own (ngw_0002); the comparison reads the parent tables only.
  const notPartition = "NOT EXISTS (SELECT 1 FROM pg_class p WHERE p.relname = %s AND p.relispartition)";
  const schemaOf = async (pool: pg.Pool) => ({
    columns: (await pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name LIKE 'space\\_gateway\\_%' AND ${notPartition.replace("%s", "table_name")} ORDER BY 1, 2`)).rows,
    constraints: (await pool.query(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid::regclass::text LIKE 'space\\_gateway\\_%' AND ${notPartition.replace("%s", "conrelid::regclass::text")} ORDER BY 1, 2`)).rows,
    indexes: (await pool.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename LIKE 'space\\_gateway\\_%'
      AND ${notPartition.replace("%s", "tablename")} ORDER BY 1, 2`)).rows
  });
  /** Space's schema with the Nous Gateway's request-log changes: tenant_id, its index, and the partition key in the primary key. */
  const withNgwRequestLogs = (schema: Awaited<ReturnType<typeof schemaOf>>) => ({
    columns: [...schema.columns, { table_name: "space_gateway_request_logs", column_name: "tenant_id", data_type: "text", is_nullable: "YES", column_default: null }]
      .sort((a, b) => `${a.table_name}.${a.column_name}`.localeCompare(`${b.table_name}.${b.column_name}`)),
    constraints: schema.constraints.map((row) => row.conname === "space_gateway_request_logs_pkey" ? { ...row, def: "PRIMARY KEY (id, requested_at)" } : row),
    indexes: [...schema.indexes.map((row) => row.indexname === "space_gateway_request_logs_pkey"
      ? { ...row, indexdef: row.indexdef.replace("(id)", "(id, requested_at)") } : row),
    { tablename: "space_gateway_request_logs", indexname: "space_gateway_request_logs_tenant_idx",
      indexdef: "CREATE INDEX space_gateway_request_logs_tenant_idx ON ONLY public.space_gateway_request_logs USING btree (tenant_id) WHERE (tenant_id IS NOT NULL)" }]
      .map((row) => row.tablename === "space_gateway_request_logs" ? { ...row, indexdef: row.indexdef.replace(" ON public.", " ON ONLY public.") } : row)
      .sort((a, b) => `${a.tablename}.${a.indexname}`.localeCompare(`${b.tablename}.${b.indexname}`))
  });

  it("builds Space's gateway schema without Space's other tables or pgvector, and re-running applies nothing", async () => {
    const applied: string[] = [];
    await migrateNgw(ngw, (file) => applied.push(file));
    expect(applied).toHaveLength(SPACE_GATEWAY_MIGRATIONS.length + NGW_MIGRATIONS.length);
    expect((await migrateNgw(ngw)).applied).toEqual([]);
    const tables = (await ngw.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((row) => row.tablename as string);
    expect(tables.filter((name) => !/^(space_gateway_|ngw_)/.test(name))).toEqual(["space_schema_migrations"]);
    expect(tables).toEqual(expect.arrayContaining(["ngw_tenant_keys", "ngw_switches", "ngw_account_pools"]));
    expect((await ngw.query("SELECT extname FROM pg_extension WHERE extname = 'vector'")).rowCount).toBe(0);
    await applyPendingMigrations(space, await loadMigrations());
    expect(await schemaOf(ngw)).toEqual(withNgwRequestLogs(await schemaOf(space)));
  }, 300_000);

  it("partitions the request logs by month with the tenant from the ledger id; the ops function makes the coming months and drops old ones", async () => {
    const month = (offset: number) => { const at = new Date(); at.setUTCDate(1); at.setUTCMonth(at.getUTCMonth() + offset); return at.toISOString().slice(0, 7).replace("-", "m"); };
    const parts = async () => (await ngw.query("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'space_gateway_request_logs'::regclass ORDER BY 1"))
      .rows.map((row) => row.relname as string);
    expect(await parts()).toEqual([0, 1, 2].map((offset) => `space_gateway_request_logs_y${month(offset)}`));
    await ngw.query(`INSERT INTO space_gateway_request_logs (request_id, provider, model, status) VALUES ('ngwreq:t-9:${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}', 'CLAUDE', 'm', 'success'),
      ('req_space_style', 'CLAUDE', 'm', 'success')`);
    expect((await ngw.query("SELECT tenant_id FROM space_gateway_request_logs ORDER BY id")).rows).toEqual([{ tenant_id: "t-9" }, { tenant_id: null }]);
    expect((await ngw.query("SELECT ngw_request_log_partitions() AS changed")).rows[0].changed).toEqual([]);
    // An old month falls out after 13 months; nothing else moves.
    const old = new Date(); old.setUTCDate(1); old.setUTCMonth(old.getUTCMonth() - 14);
    const next = new Date(old); next.setUTCMonth(next.getUTCMonth() + 1);
    await ngw.query(`CREATE TABLE space_gateway_request_logs_old PARTITION OF space_gateway_request_logs FOR VALUES FROM ('${old.toISOString().slice(0, 10)}T00:00:00Z') TO ('${next.toISOString().slice(0, 10)}T00:00:00Z')`);
    expect((await ngw.query("SELECT ngw_request_log_partitions() AS changed")).rows[0].changed).toEqual(["dropped space_gateway_request_logs_old"]);
    expect((await ngw.query("SELECT count(*)::int AS n FROM space_gateway_request_logs")).rows[0].n).toBe(2);
    expect((await ngw.query("SELECT has_function_privilege('public', 'ngw_request_log_partitions()', 'EXECUTE') AS anyone")).rows[0].anyone).toBe(false);
  }, 120_000);
});
