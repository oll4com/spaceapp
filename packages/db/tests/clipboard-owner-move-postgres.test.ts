// Migration 0319 on a real, disposable PostgreSQL: stable's six broker-filed clipboard rows move from user:dev-operator to
// user:operator (operator 12/11), the open plan pauses, and nothing else moves. Skips when Docker or the image is missing.
import { readFile } from "node:fs/promises";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSpaceStore } from "../src/space-store.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const migration = new URL("../migrations/0319_clipboard_dev_operator_rows_to_operator.sql", import.meta.url);

describe.skipIf(unavailable !== null)(`Clipboard owner move 0319${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let store: PostgresSpaceStore;

  beforeAll(async () => {
    server = await startDisposablePostgres("clipmove");
    await server.createDatabase("space_clipmove");
    pool = server.pool("space_clipmove", 2);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    store = new PostgresSpaceStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("moves exactly the listed rows, pauses the open plan and leaves a row whose copy the operator holds", async () => {
    await store.upsertUser({ id: "user:operator", email: "operator@example.com", role: "ADMIN" });
    await store.upsertUser({ id: "user:dev-operator", email: "space@space.local", role: "ADMIN" });
    const row = async (id: string, text: string, owner = "user:dev-operator") => {
      const item = await store.upsertClipboardItem({ ownerUserId: owner, text, source: "PLAN", title: id, minimumModel: "claude-opus-5-5" });
      await pool.query("UPDATE clipboard_items SET id = $1, execution_status = 'PLANNED' WHERE id = $2", [id, item.id]);
    };
    await row("clipboard:plan-sensevoice-e00e2efe", "sensevoice");
    await row("clipboard:e01d15ac1946", "e01d");
    await row("clipboard:DJkwzi2JeVwo", "same text");
    await row("clipboard:mine", "same text", "user:operator");
    await row("clipboard:9Gn3d7MS-Ir5", "excluded");

    await pool.query(await readFile(migration, "utf8"));

    const { rows } = await pool.query("SELECT id, owner_user_id, execution_status FROM clipboard_items ORDER BY id");
    expect(Object.fromEntries(rows.map((r) => [r.id, `${r.owner_user_id} ${r.execution_status}`]))).toEqual({
      "clipboard:plan-sensevoice-e00e2efe": "user:operator PAUSED",
      "clipboard:e01d15ac1946": "user:operator PLANNED",
      "clipboard:DJkwzi2JeVwo": "user:dev-operator PLANNED",
      "clipboard:mine": "user:operator PLANNED",
      "clipboard:9Gn3d7MS-Ir5": "user:dev-operator PLANNED"
    });
  });
});
