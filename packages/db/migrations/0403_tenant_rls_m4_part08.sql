-- K1 tenancy M4 part 08/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE nous_programs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_programs;
CREATE POLICY tenant_isolation ON nous_programs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_score_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_score_snapshots;
CREATE POLICY tenant_isolation ON nous_score_snapshots USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_shared_memory_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_shared_memory_policy;
CREATE POLICY tenant_isolation ON nous_shared_memory_policy USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_turn_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_turn_facts;
CREATE POLICY tenant_isolation ON nous_turn_facts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON outbox_events;
CREATE POLICY tenant_isolation ON outbox_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE owner_signatures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON owner_signatures;
CREATE POLICY tenant_isolation ON owner_signatures USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE pane_agent_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pane_agent_bindings;
CREATE POLICY tenant_isolation ON pane_agent_bindings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE pane_agent_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pane_agent_sessions;
CREATE POLICY tenant_isolation ON pane_agent_sessions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE pane_browser_routes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pane_browser_routes;
CREATE POLICY tenant_isolation ON pane_browser_routes USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE pane_browser_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pane_browser_sessions;
CREATE POLICY tenant_isolation ON pane_browser_sessions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE pane_cli_codex_thread_ownerships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pane_cli_codex_thread_ownerships;
CREATE POLICY tenant_isolation ON pane_cli_codex_thread_ownerships USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE pane_cli_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pane_cli_sessions;
CREATE POLICY tenant_isolation ON pane_cli_sessions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE pane_cli_terminal_control_leases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pane_cli_terminal_control_leases;
CREATE POLICY tenant_isolation ON pane_cli_terminal_control_leases USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE pane_cli_transcript_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pane_cli_transcript_chunks;
CREATE POLICY tenant_isolation ON pane_cli_transcript_chunks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE pane_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pane_reports;
CREATE POLICY tenant_isolation ON pane_reports USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE panes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON panes;
CREATE POLICY tenant_isolation ON panes USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE personal_git_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON personal_git_connections;
CREATE POLICY tenant_isolation ON personal_git_connections USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE project_repository_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON project_repository_bindings;
CREATE POLICY tenant_isolation ON project_repository_bindings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE provider_validation_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON provider_validation_checks;
CREATE POLICY tenant_isolation ON provider_validation_checks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE repository_publish_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON repository_publish_operations;
CREATE POLICY tenant_isolation ON repository_publish_operations USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
