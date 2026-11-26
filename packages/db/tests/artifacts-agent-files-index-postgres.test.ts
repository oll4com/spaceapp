// The Agent Files list reads its own partial index instead of the whole artifacts table (migration 0337, speed slice 17, 14/11): the
// statements the store sends, planned on a table of stable's size. Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore, type PgPoolLike } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Agent Files list on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("agentfilesidx");
    await server.createDatabase("space_agent_files_idx");
    pool = server.pool("space_agent_files_idx", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("counts and pages the Agent Files through idx_artifacts_agent_files", async () => {
    // One artifact in 15 is an Agent File, the newest first by the lowest number.
    await pool.query(`INSERT INTO artifacts(id, kind, mime_type, storage_uri, sha256, byte_size, created_at)
      SELECT 'artifact:' || n, 'EXPORT', 'text/plain', 'space-artifact://' || CASE WHEN n % 15 = 0 THEN 'agent-files/' ELSE 'browser-evidence/' END || n,
        repeat('a', 64), 1, now() - n * interval '1 minute' FROM generate_series(1, 22000) AS n`);
    await pool.query("UPDATE artifacts SET deleted_at = now() WHERE id = 'artifact:15'");
    await pool.query("ANALYZE artifacts");
    const sent: Array<{ sql: string; values: unknown[] }> = [];
    const recording = { query: (sql: string, values: unknown[]) => { sent.push({ sql, values }); return pool.query(sql, values); }, connect: () => pool.connect() } as unknown as PgPoolLike;

    const page = await new PostgresSpaceStore(recording).listArtifactsPage({ collection: "AGENT_FILES", page: 2, pageSize: 50, sortOrder: "desc" });
    expect(page.totalItems).toBe(1465);
    expect(page.data.slice(0, 2).map((artifact) => artifact.id)).toEqual(["artifact:780", "artifact:795"]);
    expect(sent).toHaveLength(2);
    for (const { sql, values } of sent) {
      const plan = (await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, values)).rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(plan).toContain("idx_artifacts_agent_files");
      expect(plan).not.toContain("Seq Scan");
    }
  });
});
