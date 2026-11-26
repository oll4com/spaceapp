-- K1 tenancy M3 part 02/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
UPDATE channel_inbox SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE channel_link_codes SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE channel_outbox SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE cli_maintenance_auth_handoffs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE cli_maintenance_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE cli_task_revisions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE cli_tasks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE clipboard_items SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE codex_app_server_turn_smoke_checks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE codex_cli_turn_markers SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE connector_accounts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE council_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE database_connections SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_connections SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_oauth_attempts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_operations SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_preferences SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_sheets_targets SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_test_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE channel_inbox ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE channel_link_codes ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE channel_outbox ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE cli_maintenance_auth_handoffs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE cli_maintenance_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE cli_task_revisions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE cli_tasks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE clipboard_items ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE codex_app_server_turn_smoke_checks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE codex_cli_turn_markers ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE connector_accounts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE council_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE database_connections ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE demo_connections ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE demo_oauth_attempts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE demo_operations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE demo_preferences ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE demo_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE demo_sheets_targets ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE demo_test_runs ALTER COLUMN tenant_id SET NOT NULL;
