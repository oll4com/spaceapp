// Slice 15 (14/11): migration 0338 fills each tool's error samples a turn kept only 3 of from the turn's FAILED TOOL messages. Skips without Docker.
import type pg from "pg";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Nous turn facts error samples migration${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  const tool = async (id: string, turn: string, name: string, status: string, result: string, at: number) => pool.query(
    "INSERT INTO nous_messages(id, owner_user_id, turn_id, kind, status, content, meta, created_at) VALUES ($1, 'user:nf', $2, 'TOOL', $3, $4, $5::jsonb, to_timestamp($6))",
    [id, turn, status, `${name} FAILED`, JSON.stringify({ name, result }), at]);

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-error-samples");
    await server.createDatabase("space_nous_error_samples");
    pool = server.pool("space_nous_error_samples", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
    await pool.query("INSERT INTO users(id, email, role) VALUES ('user:nf', 'nf@space.local', 'OPERATOR')");
    const facts = (turn: string, tools: object) => pool.query("INSERT INTO nous_turn_facts(turn_id, owner_user_id, reason, status, tools, started_at, ended_at) VALUES ($1, 'user:nf', 'OPERATOR', 'DONE', $2::jsonb, now(), now())", [turn, JSON.stringify(tools)]);
    // Five failures, three kept, one dropped by the database (refused), one refused by a gate: the two unsampled ones come back.
    await facts("turn:a", { space_task_update: { calls: 6, failed: 6, refused: 1, errors: ["No task t1.", "No task t2.", "No task t3."] }, space_reply_now: { calls: 1, failed: 0, refused: 0 } });
    for (const [index, id] of ["t1", "t2", "t3", "t4"].entries()) await tool(`m:a${index}`, "turn:a", "space_task_update", "FAILED", `No task ${id}.\nMore text`, 100 + index);
    await tool("m:a4", "turn:a", "space_task_update", "FAILED", "FAILED tasks.update: [\n  {\"message\": \"Invalid request data\"}\n]", 104);
    await tool("m:a5", "turn:a", "space_task_update", "FAILED", "Connection terminated unexpectedly", 105);
    await tool("m:a6", "turn:a", "space_task_update", "REFUSED", "Held: ask first", 106);
    // Every failure already sampled: untouched.
    await facts("turn:b", { space_git: { calls: 1, failed: 1, refused: 0, errors: ["kept"] } });
    await tool("m:b0", "turn:b", "space_git", "FAILED", "other text", 200);
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("rebuilds the samples of turns with more failures than texts, skipping database drops and refusals", async () => {
    await pool.query(await readFile(new URL("../migrations/0338_nous_turn_facts_error_samples.sql", import.meta.url), "utf8"));
    const rows = Object.fromEntries((await pool.query<{ turn_id: string; tools: Record<string, unknown> }>("SELECT turn_id, tools FROM nous_turn_facts")).rows.map((row) => [row.turn_id, row.tools]));
    expect(rows["turn:a"]).toEqual({ space_task_update: { calls: 6, failed: 6, refused: 1,
      errors: ["No task t1.", "No task t2.", "No task t3.", "No task t4.", "FAILED tasks.update: [ {\"message\": \"Invalid request data\"} ]"] }, space_reply_now: { calls: 1, failed: 0, refused: 0 } });
    expect(rows["turn:b"]).toEqual({ space_git: { calls: 1, failed: 1, refused: 0, errors: ["kept"] } });
  });
});
