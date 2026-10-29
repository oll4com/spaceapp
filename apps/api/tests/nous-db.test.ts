// Nous reads Space's own database (operator order 2026-10-24): one read per call, never a write, secrets hidden.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNousDb, NOUS_DB_COMMON_TABLES, nousDbColumnsText, nousDbNearestTables, nousDbRows, nousDbStatement } from "../src/nous/db.js";
import { applyPendingMigrations } from "../../../packages/db/src/migration-runner.js";
import { loadMigrations } from "../../../packages/db/src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../../packages/db/tests/support/disposable-postgres.js";

describe("space_db_query statements", () => {
  it("wraps reads in a row limit, keeps EXPLAIN and SHOW, and refuses writes and side-effect calls", () => {
    expect(nousDbStatement({ sql: "select id from panes;", limit: 5 })).toEqual({ text: "SELECT * FROM (\nselect id from panes\n) AS nous_query LIMIT 6", limit: 5 });
    expect(nousDbStatement({ sql: "EXPLAIN SELECT 1" }).text).toBe("EXPLAIN SELECT 1");
    expect(() => nousDbStatement({ sql: "DELETE FROM panes" })).toThrow("reads only");
    expect(() => nousDbStatement({ sql: "/* hi */ SELECT 1" })).toThrow("reads only");
    expect(() => nousDbStatement({ sql: "SELECT pg_terminate_backend(42)" })).toThrow("only reads");
    expect(() => nousDbStatement({ sql: "select set_config('statement_timeout', '0', false)" })).toThrow("only reads");
  });

  it("shows rows as JSON lines, hides secret-named columns and says when more rows exist", () => {
    const text = nousDbRows(["id", "password_hash", "created_at"], [["u1", "argon2…", new Date("2026-10-24T00:00:00.000Z")], ["u2", null, null]], 1);
    expect(text).toBe('1 row (more exist: raise limit or narrow the query); columns: id, password_hash, created_at\n{"id":"u1","password_hash":"[hidden]","created_at":"2026-10-24T00:00:00.000Z"}');
  });

  it("ranks the nearest table names by shared name parts", () => {
    expect(nousDbNearestTables("nous_turns", ["panes", "nous_turn_facts", "nous_messages", "turn_log"])).toEqual(["nous_turn_facts", "turn_log", "nous_messages"]);
    expect(nousDbNearestTables("xyz", ["panes"])).toEqual([]);
  });

  it("lists real columns for the tool description, whole tables only, within the budget", () => {
    const tables = [{ table_name: "panes", columns: "id, is_closed" }, { table_name: "rooms", columns: "id, name" }];
    expect(nousDbColumnsText(tables)).toBe("Real columns (use these names; other tables: information_schema.columns): panes(id, is_closed); rooms(id, name);");
    expect(nousDbColumnsText(tables, 100)).not.toContain("rooms(");
    expect(nousDbColumnsText([])).toBe("");
  });
});

const unavailable = disposablePostgresUnavailableReason();
describe.skipIf(unavailable !== null)(`space_db_query on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-db");
    await server.createDatabase("space_nous_db");
    pool = server.pool("space_nous_db", 2);
    await pool.query("CREATE TABLE notes(id int, body text); CREATE TABLE note_tags(note_id int, tag text); INSERT INTO notes VALUES (1, 'one'), (2, 'two'), (3, 'three')");
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("reads, and never writes: a write inside a read, a second statement and a commit all fail", async () => {
    const db = createNousDb({ pool });
    expect(await db.query({ sql: "SELECT id, body FROM notes ORDER BY id", limit: 2 })).toContain('2 rows (more exist');
    await expect(db.query({ sql: "WITH gone AS (DELETE FROM notes RETURNING id) SELECT * FROM gone" })).rejects.toThrow("Postgres:");
    await expect(db.query({ sql: "SELECT 1; DELETE FROM notes" })).rejects.toThrow("Postgres:");
    await expect(db.query({ sql: "SELECT 1) AS x; COMMIT; DELETE FROM notes; SELECT (1" })).rejects.toThrow("Postgres:");
    expect((await pool.query("SELECT count(*)::int AS n FROM notes")).rows[0].n).toBe(3);
  });

  it("says what was wrong: message, code and hint, the table's real columns or the nearest table names", async () => {
    const db = createNousDb({ pool });
    const column = await db.query({ sql: "SELECT n.title FROM public.notes n JOIN note_tags t ON t.note_id = n.id" }).catch((error: Error) => error.message);
    expect(column).toContain('Postgres: column n.title does not exist (code 42703)');
    expect(column).toContain("Columns of notes: id, body");
    expect(column).toContain("Columns of note_tags: note_id, tag");
    const table = await db.query({ sql: "SELECT * FROM note" }).catch((error: Error) => error.message);
    expect(table).toContain('relation "note" does not exist (code 42P01)');
    expect(table).toContain("Nearest tables: notes, note_tags");
    const hinted = await db.query({ sql: "SELECT bodyy FROM notes" }).catch((error: Error) => error.message);
    expect(hinted).toContain('Hint: Perhaps you meant to reference the column "notes.body".');
  });

  it("knows the real columns of the tables it reads most before the first query (stable 2026-10-27: four guessed names failed)", async () => {
    await server.createDatabase("space_nous_db_schema");
    const schemaPool = server.pool("space_nous_db_schema", 2);
    try {
      const client = await schemaPool.connect();
      try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
      const columns = await createNousDb({ pool: schemaPool }).columns();
      expect(columns.length).toBeLessThanOrEqual(3_000);
      for (const table of NOUS_DB_COMMON_TABLES) expect(columns).toContain(` ${table}(`);
      expect(columns).toMatch(/ nous_messages\([^)]*\bkind\b/);
      expect(columns).toMatch(/ pane_reports\([^)]*\bat\b/);
      expect(columns).toMatch(/ security_copilot_events\([^)]*\btype\b/);
      expect(columns).toMatch(/ panes\([^)]*\bis_closed\b/);
    } finally {
      await schemaPool.end();
    }
  }, 120_000);
});
