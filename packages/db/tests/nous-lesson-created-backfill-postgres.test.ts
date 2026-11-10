import { expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres } from "./support/disposable-postgres.js";
import { loadMigrations } from "../src/migrations.js";

// Migration 0300: a lesson with no created_at gets the key's date, else its earliest incident, else 2026-10-28; never after its update; text untouched.
it.skipIf(disposablePostgresUnavailableReason() !== null)("backfills legacy lessons' created_at from the key, the incidents or an old date, and leaves the rest", async () => {
  const backfill = (await loadMigrations()).find((item) => item.id === "0300_nous_lesson_created_backfill")!;
  const server = await startDisposablePostgres("lesson-backfill");
  const pool = server.pool("postgres", 2);
  try {
    await pool.query("CREATE TABLE nous_notes (owner_user_id text, key text, text text, updated_at timestamptz, created_at timestamptz, PRIMARY KEY (owner_user_id, key))");
    const rows: Array<[string, string, string, string | null]> = [
      ["lessons-1031-allowances-ask", "Ask less.", "2026-11-04T10:00:00Z", null],
      ["lessons-1231-future", "A key date after its update.", "2026-11-04T10:00:00Z", null],
      ["lessons-ask-last", "Base.\n\n--- Incident (2026-11-02T09:30:00.000Z, saved as lessons-x):\nAgain.\n\n--- Incident (merged from lessons-y, 2026-10-30):\nY.",
        "2026-11-04T10:00:00Z", null],
      ["lessons-plain", "No date anywhere.", "2026-11-03T10:00:00Z", null],
      ["lessons-ancient", "Older than the fallback.", "2026-10-20T10:00:00Z", null],
      ["lessons-kept", "Already dated.", "2026-11-04T10:00:00Z", "2026-11-01T00:00:00Z"],
      ["plan-notes", "Not a lesson.", "2026-11-04T10:00:00Z", null]
    ];
    for (const [key, text, updatedAt, createdAt] of rows) {
      await pool.query("INSERT INTO nous_notes VALUES ('user:operator', $1, $2, $3, $4)", [key, text, updatedAt, createdAt]);
    }
    await pool.query(backfill.sql);
    await pool.query(backfill.sql);
    const { rows: after } = await pool.query("SELECT key, text, created_at FROM nous_notes ORDER BY key");
    const created = Object.fromEntries(after.map((row) => [row.key, row.created_at ? new Date(row.created_at).toISOString() : null]));
    expect(created).toEqual({
      "lessons-1031-allowances-ask": "2026-10-31T00:00:00.000Z", "lessons-1231-future": "2026-11-04T10:00:00.000Z",
      "lessons-ask-last": "2026-10-30T00:00:00.000Z", "lessons-plain": "2026-10-28T00:00:00.000Z", "lessons-ancient": "2026-10-20T10:00:00.000Z",
      "lessons-kept": "2026-11-01T00:00:00.000Z", "plan-notes": null
    });
    expect(after.map((row) => row.text)).toEqual([...rows].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text));
  } finally {
    await server.stop();
  }
}, 120_000);
