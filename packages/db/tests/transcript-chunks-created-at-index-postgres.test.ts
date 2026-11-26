// The VPN 429 watcher reads the chunks of its last 75 seconds through idx_pane_cli_transcript_chunks_created_at instead of matching
// its regexes on every chunk (migration 0339, speed slice 21, 14/11): the host script's own statement, planned on a table of stable's
// size. Skips without Docker.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const watcher = new URL("../../../deploy/host/usr/local/libexec/space-vpn-429-watch.sh", import.meta.url);
// The host script is not exported: the public tree skips this check.
const unavailable = existsSync(watcher) ? disposablePostgresUnavailableReason() : "no host watcher script";

describe.skipIf(unavailable !== null)(`VPN 429 watcher's transcript scan on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("chunkstimeidx");
    await server.createDatabase("space_chunks_time_idx");
    pool = server.pool("space_chunks_time_idx", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("plans the watcher's statement through idx_pane_cli_transcript_chunks_created_at", async () => {
    const script = await readFile(watcher, "utf8");
    const sql = /-c "\s*(SELECT DISTINCT session_id[^"]*)"/.exec(script)?.[1]?.replace("${last_rotate}", "0").replace("${WINDOW_SECONDS}", "75") ?? "";
    expect(sql).toContain("FROM pane_cli_transcript_chunks");
    expect(sql).not.toContain("${");
    // Two days of chunks in no order of time, 400 of them in the last minute (stable, 14/11: 432 of 30,088 in the last 75 s).
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('watch:a','a@watch.test','USER');
      INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('watch:room','Watch','watch:trace','watch:a',0);
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('watch:pane','watch:room','Chat','CHAT','IDLE',0);
      INSERT INTO pane_cli_sessions(session_id,pane_id,room_id,runtime_id,provider_id,agent_id,reasoning_effort,status)
        VALUES ('watch:session','watch:pane','watch:room','runtime','provider','agent','none','IDLE');
      INSERT INTO pane_cli_transcript_chunks(chunk_id,session_id,pane_id,room_id,sequence,stream,content,byte_length,created_at)
        SELECT 'watch:' || n, 'watch:session', 'watch:pane', 'watch:room', n, 'stdout', repeat('output ', 40), 280,
          now() - n * CASE WHEN n <= 400 THEN interval '0.15 seconds' ELSE interval '5.8 seconds' END
        FROM generate_series(1, 30000) AS n ORDER BY random();
      ANALYZE pane_cli_transcript_chunks`);
    const plan = (await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`)).rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("idx_pane_cli_transcript_chunks_created_at");
    expect(plan).not.toContain("Seq Scan");
  });
});
