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

/** A migration that opts in with this line runs each statement in its own transaction, so it never holds one table's
 * locks while it waits for another's: a live API transaction cannot deadlock with it (promote q-20261123-005136-8155).
 * Its `SET LOCAL` lines repeat in every transaction; the history row commits with the last statement, so every
 * statement must be safe to run again after a failed deploy.
 * shortcut: one statement per line, no multi-line SQL; split on semicolons properly if a migration ever needs one. */
export const statementPerTransactionMarker = "-- space:migration statement-per-transaction";

function migrationSteps(migration: Migration): string[] {
  if (!migration.sql.split("\n").some((line) => line.trim() === statementPerTransactionMarker)) return [migration.sql];
  const lines = migration.sql.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("--"));
  const bad = lines.find((line) => !line.endsWith(";"));
  if (bad) throw new Error(`${migration.filename}: statement-per-transaction needs one complete statement per line: ${bad}`);
  const prelude = lines.filter((line) => /^SET LOCAL\s/i.test(line));
  const statements = lines.filter((line) => !/^SET LOCAL\s/i.test(line));
  if (!statements.length) throw new Error(`${migration.filename}: statement-per-transaction migration has no statements.`);
  return statements.map((statement) => [...prelude, statement].join("\n"));
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
  const steps = migrationSteps(migration);
  for (const [index, sql] of steps.entries()) await applyStep(client, migration, sql, index === steps.length - 1, maxAttempts, sleep);
}

async function applyStep(
  client: Pick<pg.Client, "query">,
  migration: Migration,
  sql: string,
  record: boolean,
  maxAttempts: number,
  sleep: (delayMs: number) => Promise<void>
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await client.query("BEGIN");
    try {
      await client.query(sql);
      if (record) {
        await client.query("INSERT INTO space_schema_migrations (id, filename) VALUES ($1, $2)", [
          migration.id,
          migration.filename
        ]);
      }
      await client.query("COMMIT");
      return;
    } catch (error) {
      // A lost connection fails ROLLBACK too: keep the migration's error and do not retry on that client.
      const rollback = await rollbackKeepingError(client, error);
      if (rollback.failed) throw rollback.error;
      const code = errorCode(error);
      if (!code || !retryableTransactionCodes.has(code) || attempt === maxAttempts) throw error;

      const delayMs = 100 * 2 ** (attempt - 1);
      console.warn(`retrying ${migration.filename} after PostgreSQL ${code} (${attempt}/${maxAttempts})`);
      await sleep(delayMs);
    }
  }
}
