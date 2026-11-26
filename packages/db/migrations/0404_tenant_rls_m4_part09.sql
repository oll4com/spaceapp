-- K1 tenancy M4 part 09/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE review_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON review_checks;
CREATE POLICY tenant_isolation ON review_checks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE review_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON review_decisions;
CREATE POLICY tenant_isolation ON review_decisions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE review_diff_summaries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON review_diff_summaries;
CREATE POLICY tenant_isolation ON review_diff_summaries USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE room_agent_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON room_agent_actions;
CREATE POLICY tenant_isolation ON room_agent_actions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE room_agent_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON room_agent_bindings;
CREATE POLICY tenant_isolation ON room_agent_bindings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE room_agent_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON room_agent_events;
CREATE POLICY tenant_isolation ON room_agent_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE room_agent_missions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON room_agent_missions;
CREATE POLICY tenant_isolation ON room_agent_missions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE room_agent_monitor_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON room_agent_monitor_settings;
CREATE POLICY tenant_isolation ON room_agent_monitor_settings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE room_agent_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON room_agent_requests;
CREATE POLICY tenant_isolation ON room_agent_requests USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE room_agent_task_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON room_agent_task_runs;
CREATE POLICY tenant_isolation ON room_agent_task_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE room_pane_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON room_pane_activity;
CREATE POLICY tenant_isolation ON room_pane_activity USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE room_pane_commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON room_pane_commands;
CREATE POLICY tenant_isolation ON room_pane_commands USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE room_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON room_shares;
CREATE POLICY tenant_isolation ON room_shares USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON rooms;
CREATE POLICY tenant_isolation ON rooms USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE saved_signatures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saved_signatures;
CREATE POLICY tenant_isolation ON saved_signatures USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE security_copilot_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security_copilot_actions;
CREATE POLICY tenant_isolation ON security_copilot_actions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE security_copilot_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security_copilot_events;
CREATE POLICY tenant_isolation ON security_copilot_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE security_copilot_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security_copilot_findings;
CREATE POLICY tenant_isolation ON security_copilot_findings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE security_copilot_hosts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security_copilot_hosts;
CREATE POLICY tenant_isolation ON security_copilot_hosts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE security_copilot_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security_copilot_memory;
CREATE POLICY tenant_isolation ON security_copilot_memory USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
