import process from "node:process";
import pg from "pg";
import { applyMigration } from "./migration-runner.js";
import { loadMigrations } from "./migrations.js";

const { Client } = pg;

const databaseUrl = process.env.SPACE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("SPACE_DATABASE_URL or DATABASE_URL is required to run migrations.");
}

const client = new Client({ connectionString: databaseUrl });

await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS space_schema_migrations (
      id text PRIMARY KEY,
      filename text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const migration of await loadMigrations()) {
    const existing = await client.query("SELECT id FROM space_schema_migrations WHERE id = $1", [migration.id]);
    if (existing.rowCount && existing.rowCount > 0) {
      continue;
    }
    await applyMigration(client, migration);
    console.log(`applied ${migration.filename}`);
  }
} finally {
  await client.end();
}
