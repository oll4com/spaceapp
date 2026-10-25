import process from "node:process";
import pg from "pg";
import { applyPendingMigrations } from "./migration-runner.js";
import { loadMigrations } from "./migrations.js";

const { Client } = pg;

const databaseUrl = process.env.SPACE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("SPACE_DATABASE_URL or DATABASE_URL is required to run migrations.");
}

const client = new Client({ connectionString: databaseUrl });

await client.connect();
try {
  await applyPendingMigrations(client, await loadMigrations(), {
    onApplied: (migration) => console.log(`applied ${migration.filename}`)
  });
} finally {
  await client.end();
}
