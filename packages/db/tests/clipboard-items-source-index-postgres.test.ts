// nous_board and nous_world query clipboard_items filtered by (owner_user_id, source = 'PLAN', ...) ordered by
// (last_used_at DESC, id DESC) through idx_clipboard_items_owner_source_recent instead of scanning COPY/NOTE rows
// (migration 0354, 22/11). Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`clipboard_items source/recent index on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("clipsrcidx");
    await server.createDatabase("space_clip_src_idx");
    pool = server.pool("space_clip_src_idx", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("plans source-filtered clipboard queries through idx_clipboard_items_owner_source_recent without sorting", async () => {
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('clip:u','u@clip.test','USER');
      INSERT INTO clipboard_items(id,owner_user_id,content_hash,text,source,character_count,is_completed,last_used_at)
      SELECT
        'clipboard:r' || n,
        'clip:u',
        md5('clip-' || n) || md5('clip2-' || n),
        'Clipboard body ' || n,
        CASE WHEN n <= 20 THEN 'PLAN' ELSE 'COPY' END,
        char_length('Clipboard body ' || n),
        CASE WHEN n <= 10 THEN false ELSE true END,
        now() - (n || ' seconds')::interval
      FROM generate_series(1, 5000) AS n;
      ANALYZE clipboard_items`);
    const sql = `SELECT id FROM clipboard_items
      WHERE owner_user_id = 'clip:u' AND source = 'PLAN' AND is_completed = false
      ORDER BY last_used_at DESC, id DESC LIMIT 100 OFFSET 0`;
    const plan = (await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`)).rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("idx_clipboard_items_owner_source_recent");
    expect(plan).not.toContain("Sort");
    const rows = (await pool.query<{ id: string }>(sql)).rows;
    expect(rows).toHaveLength(10);
  });
});
