import { rollbackKeepingError } from "./rollback.js";
import type pg from "pg";

type Migration = {
  id: string;
  filename: string;
  sql: string;
};

type MigrationOptions = {
  maxAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

const retryableTransactionCodes = new Set(["40001", "40P01"]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export const migrationHistoryTableSql = `
    CREATE TABLE IF NOT EXISTS space_schema_migrations (
      id text PRIMARY KEY,
      filename text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

type PendingMigrationOptions = MigrationOptions & {
  onApplied?: (migration: Migration) => void;
};

/** The deploy migration pass: ensure the history table, then apply, in the
 * given order, every migration whose ID is not recorded yet. Recorded IDs are
 * never re-run, rewritten or removed, including IDs whose file is gone. */
export async function applyPendingMigrations(
  client: Pick<pg.Client, "query">,
  migrations: readonly Migration[],
  options: PendingMigrationOptions = {}
): Promise<{ applied: string[] }> {
  await client.query(migrationHistoryTableSql);
  const applied: string[] = [];
  for (const migration of migrations) {
    const existing = await client.query("SELECT id FROM space_schema_migrations WHERE id = $1", [migration.id]);
    if (existing.rowCount && existing.rowCount > 0) continue;
    await applyMigration(client, migration, options);
    applied.push(migration.id);
    options.onApplied?.(migration);
  }
  return { applied };
}

export async function applyMigration(
  client: Pick<pg.Client, "query">,
  migration: Migration,
  options: MigrationOptions = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new RangeError("maxAttempts must be an integer between 1 and 20.");
  }
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO space_schema_migrations (id, filename) VALUES ($1, $2)", [
        migration.id,
        migration.filename
      ]);
      await client.query("COMMIT");
      return;
    } catch (error) {
      // A lost connection fails ROLLBACK too: keep the migration's error and do not retry on that client.
      if (await rollbackKeepingError(client)) throw error;
      const code = errorCode(error);
      if (!code || !retryableTransactionCodes.has(code) || attempt === maxAttempts) throw error;

      const delayMs = 100 * 2 ** (attempt - 1);
      console.warn(`retrying ${migration.filename} after PostgreSQL ${code} (${attempt}/${maxAttempts})`);
      await sleep(delayMs);
    }
  }
}
