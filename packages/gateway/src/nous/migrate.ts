import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { migrationDirectory } from "@space/db";
import { NGW_MIGRATIONS } from "./schema.js";

/**
 * The Nous Gateway's own migration set (plan clipboard:_0qBSFCftZuD step 4, K5-migrations): the `space_gateway_*` tables the gateway
 * runs on, from Space's migration files as they are, then the Nous tables. Space's other 270-odd migrations (and pgvector) are never
 * applied to the `ngw` database. A new Space migration that touches `space_gateway_` fails `nous-gateway-migrations.test.ts` until it is
 * listed here, which also proves the result equals Space's gateway schema.
 * Run as ngw_migrate: `SPACE_DATABASE_URL=<ngw_migrate URL> node packages/gateway/dist/nous/migrate.js`.
 */
export const SPACE_GATEWAY_MIGRATIONS = [
  "0153_space_gateway_core.sql", "0154_space_gateway_reauth_status.sql", "0155_space_gateway_reset_credits.sql", "0156_space_gateway_compression.sql",
  "0157_space_gateway_speed_defaults.sql", "0160_space_gateway_parity.sql", "0165_space_gateway_headroom_stats.sql", "0166_space_gateway_code_text_compression.sql",
  "0172_space_gateway_no_shadow.sql", "0175_space_gateway_claude_api_key_fallback.sql", "0184_space_gateway_compression_providers.sql",
  "0185_space_gateway_output_policy.sql", "0204_token_usage_routes.sql", "0229_space_gateway_anthropic_billing.sql", "0247_gateway_anthropic_monthly_budget.sql",
  "0251_gateway_anthropic_credits.sql", "0285_gateway_request_log_request_id.sql", "0286_gateway_subscription_routing.sql", "0287_gateway_provider_order.sql",
  "0296_gateway_claude_reserve.sql", "0298_gateway_free_key_pools.sql", "0299_gateway_model_checks.sql", "0305_gateway_adaption_pool.sql", "0307_gateway_amd_token_lab_pool.sql",
  "0309_gateway_inception_jina_pools.sql", "0310_gateway_freeai_pool.sql", "0311_gateway_azure_openai_pool.sql",
  "0312_gateway_zai_siliconflow_ovh_pools.sql",
  "0313_gateway_mistral_pool.sql",
  "0314_gateway_cloud_claude_pools.sql",
  "0321_cpu_report_indexes.sql"
] as const;

/** Space files that also change Space's own tables: only their gateway statements are applied (each must still match the file). */
export const GATEWAY_PARTS: Record<string, string> = {
  "0204_token_usage_routes.sql": `ALTER TABLE space_gateway_request_logs
  ADD COLUMN IF NOT EXISTS upstream_request_id text CHECK (upstream_request_id IS NULL OR char_length(upstream_request_id) <= 120);
CREATE INDEX IF NOT EXISTS space_gateway_request_logs_upstream_request_idx
  ON space_gateway_request_logs(upstream_request_id) WHERE upstream_request_id IS NOT NULL;`,
  "0321_cpu_report_indexes.sql": `CREATE INDEX IF NOT EXISTS space_gateway_usage_history_secondary_reset_idx ON space_gateway_usage_history (reset_at)
  INCLUDE (account_id, quota_key, used_percent, recorded_at) WHERE usage_window = 'SECONDARY' AND reset_at IS NOT NULL;`
};

export async function loadNgwMigrations() {
  const space = await Promise.all(SPACE_GATEWAY_MIGRATIONS.map(async (filename) => ({ id: filename, filename,
    sql: GATEWAY_PARTS[filename] ?? await readFile(join(migrationDirectory, filename), "utf8") })));
  return [...space, ...NGW_MIGRATIONS.map((migration) => ({ id: migration.id, filename: `${migration.id}.sql`, sql: migration.sql }))];
}

/** Space's history table and rule: an applied id is never run again; each migration in its own transaction. */
export async function migrateNgw(client: Pick<pg.Client, "query">, onApplied?: (filename: string) => void): Promise<{ applied: string[] }> {
  await client.query("CREATE TABLE IF NOT EXISTS space_schema_migrations (id text PRIMARY KEY, filename text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied: string[] = [];
  for (const migration of await loadNgwMigrations()) {
    if ((await client.query("SELECT 1 FROM space_schema_migrations WHERE id = $1", [migration.id])).rowCount) continue;
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO space_schema_migrations (id, filename) VALUES ($1, $2)", [migration.id, migration.filename]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    applied.push(migration.filename);
    onApplied?.(migration.filename);
  }
  return { applied };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.SPACE_DATABASE_URL;
  if (!url) throw new Error("SPACE_DATABASE_URL (the ngw_migrate connection) is required.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrateNgw(client, (filename) => console.log(`applied ${filename}`));
  } finally {
    await client.end();
  }
}
