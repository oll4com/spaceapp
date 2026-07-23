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

export async function applyMigration(
  client: Pick<pg.Client, "query">,
  migration: Migration,
  options: MigrationOptions = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 5;
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
      await client.query("ROLLBACK");
      const code = errorCode(error);
      if (!code || !retryableTransactionCodes.has(code) || attempt === maxAttempts) throw error;

      const delayMs = 100 * 2 ** (attempt - 1);
      console.warn(`retrying ${migration.filename} after PostgreSQL ${code} (${attempt}/${maxAttempts})`);
      await sleep(delayMs);
    }
  }
}
