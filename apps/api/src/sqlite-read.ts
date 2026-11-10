import { DatabaseSync } from "node:sqlite";

/**
 * API audit 4/11: sqlite3 was the most spawned program (1,500-7,700 an hour, the largest share of the restart minute), each spawn a
 * fork of the 1-2 GB API. Space's read-only SQLite reads (Codex state, OpenCode stats) run in the API process instead: a busy database
 * waits at most `timeoutMs`, and errors carry SQLite's own message ("attempt to write a readonly database", "unable to open database file").
 */
export function readSqliteRows<T>(dbPath: string, sql: string, { readOnly = true, timeoutMs = 100 }: { readOnly?: boolean; timeoutMs?: number } = {}): T[] {
  const db = new DatabaseSync(dbPath, { readOnly, timeout: timeoutMs });
  try { return db.prepare(sql).all() as T[]; } finally { db.close(); }
}
