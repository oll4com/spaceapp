-- K1 tenancy M1 part 2/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE channel_inbox ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE channel_link_codes ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE channel_outbox ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE cli_maintenance_auth_handoffs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE cli_maintenance_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE cli_task_revisions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE cli_tasks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE codex_app_server_turn_smoke_checks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE codex_cli_turn_markers ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE connector_accounts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE council_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE database_connections ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE demo_connections ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE demo_oauth_attempts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE demo_operations ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE demo_preferences ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE demo_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE demo_sheets_targets ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE demo_test_runs ADD COLUMN IF NOT EXISTS tenant_id text;
