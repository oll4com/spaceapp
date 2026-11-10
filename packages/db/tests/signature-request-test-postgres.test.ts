import { expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres } from "./support/disposable-postgres.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSignaturesRepository } from "../src/signatures-repository.js";

// Migration 0301: App Studio's and proof rooms' requests become tests, the waiting ones close; the operator's own stay and the list hides tests.
it.skipIf(disposablePostgresUnavailableReason() !== null)("marks App Studio and proof-room signature requests as tests, cancels the waiting ones and lists only real ones", async () => {
  const migrations = await loadMigrations();
  const sql = (id: string) => migrations.find((item) => item.id === id)!.sql;
  const server = await startDisposablePostgres("signature-test");
  const pool = server.pool("postgres", 2);
  try {
    await pool.query("CREATE TABLE panes (id text PRIMARY KEY, mode text); CREATE TABLE rooms (id text PRIMARY KEY, kind text)");
    await pool.query("INSERT INTO panes VALUES ('pane:studio', 'APP_STUDIO'), ('pane:max', 'CODE'); INSERT INTO rooms VALUES ('room:work', 'WORKSPACE'), ('room:proof', 'AGENT_PROOF')");
    await pool.query(sql("0297_signatures"));
    const rows: Array<[string, string, string, string]> = [["sigreq:studio", "room:work", "pane:studio", "PENDING"], ["sigreq:proof", "room:proof", "pane:max", "PENDING"],
      ["sigreq:real", "room:work", "pane:max", "PENDING"], ["sigreq:signed-test", "room:work", "pane:studio", "SIGNED"]];
    for (const [id, room, pane, status] of rows) {
      await pool.query(`INSERT INTO signature_requests (id, owner_user_id, artifact_id, title, placements, room_id, pane_id, status, created_at, updated_at)
        VALUES ($1, 'user:operator', 'artifact:pdf', 'Claim', '[]', $2, $3, $4, now(), now())`, [id, room, pane, status]);
    }
    await pool.query(sql("0301_signature_request_test"));
    await pool.query(sql("0301_signature_request_test"));
    const { rows: after } = await pool.query("SELECT id, test, status FROM signature_requests ORDER BY id");
    expect(after).toEqual([{ id: "sigreq:proof", test: true, status: "CANCELLED" }, { id: "sigreq:real", test: false, status: "PENDING" },
      { id: "sigreq:signed-test", test: true, status: "SIGNED" }, { id: "sigreq:studio", test: true, status: "CANCELLED" }]);
    const repository = new PostgresSignaturesRepository(pool);
    expect((await repository.listRequests("user:operator")).map((row) => row.id)).toEqual(["sigreq:real"]);
    expect((await repository.listRequests("user:operator", undefined, true)).map((row) => row.id).sort()).toEqual(["sigreq:proof", "sigreq:real", "sigreq:signed-test", "sigreq:studio"]);
  } finally {
    await server.stop();
  }
}, 120_000);
