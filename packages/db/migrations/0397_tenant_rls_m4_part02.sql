-- K1 tenancy M4 part 02/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE channel_inbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON channel_inbox;
CREATE POLICY tenant_isolation ON channel_inbox USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE channel_link_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON channel_link_codes;
CREATE POLICY tenant_isolation ON channel_link_codes USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE channel_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON channel_outbox;
CREATE POLICY tenant_isolation ON channel_outbox USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE cli_maintenance_auth_handoffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cli_maintenance_auth_handoffs;
CREATE POLICY tenant_isolation ON cli_maintenance_auth_handoffs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE cli_maintenance_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cli_maintenance_events;
CREATE POLICY tenant_isolation ON cli_maintenance_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE cli_task_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cli_task_revisions;
CREATE POLICY tenant_isolation ON cli_task_revisions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE cli_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cli_tasks;
CREATE POLICY tenant_isolation ON cli_tasks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE clipboard_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON clipboard_items;
CREATE POLICY tenant_isolation ON clipboard_items USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE codex_app_server_turn_smoke_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON codex_app_server_turn_smoke_checks;
CREATE POLICY tenant_isolation ON codex_app_server_turn_smoke_checks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE codex_cli_turn_markers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON codex_cli_turn_markers;
CREATE POLICY tenant_isolation ON codex_cli_turn_markers USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE connector_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON connector_accounts;
CREATE POLICY tenant_isolation ON connector_accounts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE council_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON council_runs;
CREATE POLICY tenant_isolation ON council_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE database_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON database_connections;
CREATE POLICY tenant_isolation ON database_connections USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE demo_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON demo_connections;
CREATE POLICY tenant_isolation ON demo_connections USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE demo_oauth_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON demo_oauth_attempts;
CREATE POLICY tenant_isolation ON demo_oauth_attempts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE demo_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON demo_operations;
CREATE POLICY tenant_isolation ON demo_operations USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE demo_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON demo_preferences;
CREATE POLICY tenant_isolation ON demo_preferences USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE demo_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON demo_runs;
CREATE POLICY tenant_isolation ON demo_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE demo_sheets_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON demo_sheets_targets;
CREATE POLICY tenant_isolation ON demo_sheets_targets USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE demo_test_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON demo_test_runs;
CREATE POLICY tenant_isolation ON demo_test_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
