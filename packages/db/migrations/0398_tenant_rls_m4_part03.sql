-- K1 tenancy M4 part 03/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE design_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON design_assets;
CREATE POLICY tenant_isolation ON design_assets USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE design_brand_kits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON design_brand_kits;
CREATE POLICY tenant_isolation ON design_brand_kits USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE design_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON design_events;
CREATE POLICY tenant_isolation ON design_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE design_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON design_requests;
CREATE POLICY tenant_isolation ON design_requests USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_browser_panes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_browser_panes;
CREATE POLICY tenant_isolation ON dot_browser_panes USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_delegations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_delegations;
CREATE POLICY tenant_isolation ON dot_delegations USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_deliverables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_deliverables;
CREATE POLICY tenant_isolation ON dot_deliverables USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_eval_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_eval_cases;
CREATE POLICY tenant_isolation ON dot_eval_cases USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_feed_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_feed_entries;
CREATE POLICY tenant_isolation ON dot_feed_entries USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_feed_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_feed_state;
CREATE POLICY tenant_isolation ON dot_feed_state USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_goals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_goals;
CREATE POLICY tenant_isolation ON dot_goals USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_memories;
CREATE POLICY tenant_isolation ON dot_memories USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_proactive_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_proactive_state;
CREATE POLICY tenant_isolation ON dot_proactive_state USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_proactive_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_proactive_usage;
CREATE POLICY tenant_isolation ON dot_proactive_usage USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_schedules;
CREATE POLICY tenant_isolation ON dot_schedules USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_tool_invocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_tool_invocations;
CREATE POLICY tenant_isolation ON dot_tool_invocations USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE dot_user_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dot_user_settings;
CREATE POLICY tenant_isolation ON dot_user_settings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE event_relay_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON event_relay_state;
CREATE POLICY tenant_isolation ON event_relay_state USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events;
CREATE POLICY tenant_isolation ON events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE freelance_copilot_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON freelance_copilot_accounts;
CREATE POLICY tenant_isolation ON freelance_copilot_accounts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
