// CLI task history's first-stdin lookup reads one session's chunks through idx_pane_cli_transcript_chunks_session_stream_sequence
// instead of walking every stdout chunk (migration 0351, speed Phase 2 Slice 7, 21/11). Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`transcript first-stdin lookup on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("chunksstreamidx");
    await server.createDatabase("space_chunks_stream_idx");
    pool = server.pool("space_chunks_stream_idx", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("plans the first-stdin lateral through the session/stream/sequence index", async () => {
    // One long session: 20,000 stdout chunks, its only stdin near the end.
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('ix:a','a@ix.test','USER');
      INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('ix:room','Ix','ix:trace','ix:a',0);
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('ix:pane','ix:room','Chat','CHAT','IDLE',0);
      INSERT INTO pane_cli_sessions(session_id,pane_id,room_id,runtime_id,provider_id,agent_id,reasoning_effort,status)
        VALUES ('ix:session','ix:pane','ix:room','runtime','provider','agent','none','IDLE');
      INSERT INTO pane_cli_transcript_chunks(chunk_id,session_id,pane_id,room_id,sequence,stream,content,byte_length)
        SELECT 'ix:' || n, 'ix:session', 'ix:pane', 'ix:room', n, CASE WHEN n = 19990 THEN 'stdin' ELSE 'stdout' END, 'output', 6
        FROM generate_series(1, 20000) AS n;
      ANALYZE pane_cli_transcript_chunks`);
    const lookup = `SELECT content FROM pane_cli_transcript_chunks
      WHERE session_id = 'ix:session' AND stream = 'stdin' AND length(trim(content)) > 0 ORDER BY sequence ASC LIMIT 1`;
    const plan = (await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ${lookup}`)).rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("idx_pane_cli_transcript_chunks_session_stream_sequence");
    expect((await pool.query<{ content: string }>(lookup)).rows).toEqual([{ content: "output" }]);
  });
});
