-- K1 tenancy M4 part 07/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE monitoring_copilot_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON monitoring_copilot_events;
CREATE POLICY tenant_isolation ON monitoring_copilot_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE monitoring_copilot_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON monitoring_copilot_memory;
CREATE POLICY tenant_isolation ON monitoring_copilot_memory USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_attachments;
CREATE POLICY tenant_isolation ON nous_attachments USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_away_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_away_log;
CREATE POLICY tenant_isolation ON nous_away_log USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_away_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_away_sessions;
CREATE POLICY tenant_isolation ON nous_away_sessions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_conversation_marks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_conversation_marks;
CREATE POLICY tenant_isolation ON nous_conversation_marks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_decision_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_decision_ledger;
CREATE POLICY tenant_isolation ON nous_decision_ledger USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_decisions;
CREATE POLICY tenant_isolation ON nous_decisions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_file_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_file_shares;
CREATE POLICY tenant_isolation ON nous_file_shares USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_followups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_followups;
CREATE POLICY tenant_isolation ON nous_followups USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_goal_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_goal_events;
CREATE POLICY tenant_isolation ON nous_goal_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_goals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_goals;
CREATE POLICY tenant_isolation ON nous_goals USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_load_rollups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_load_rollups;
CREATE POLICY tenant_isolation ON nous_load_rollups USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_load_samples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_load_samples;
CREATE POLICY tenant_isolation ON nous_load_samples USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_messages;
CREATE POLICY tenant_isolation ON nous_messages USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_notes;
CREATE POLICY tenant_isolation ON nous_notes USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_pane_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_pane_checks;
CREATE POLICY tenant_isolation ON nous_pane_checks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_pane_closeouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_pane_closeouts;
CREATE POLICY tenant_isolation ON nous_pane_closeouts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_pane_summaries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_pane_summaries;
CREATE POLICY tenant_isolation ON nous_pane_summaries USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE nous_plan_marks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_plan_marks;
CREATE POLICY tenant_isolation ON nous_plan_marks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
