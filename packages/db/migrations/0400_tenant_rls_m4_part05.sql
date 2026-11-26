-- K1 tenancy M4 part 05/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE live_personal_memory_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON live_personal_memory_changes;
CREATE POLICY tenant_isolation ON live_personal_memory_changes USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaign_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_checks;
CREATE POLICY tenant_isolation ON mail_campaign_checks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaign_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_contacts;
CREATE POLICY tenant_isolation ON mail_campaign_contacts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaign_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_events;
CREATE POLICY tenant_isolation ON mail_campaign_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaign_list_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_list_members;
CREATE POLICY tenant_isolation ON mail_campaign_list_members USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaign_lists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_lists;
CREATE POLICY tenant_isolation ON mail_campaign_lists USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaign_senders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_senders;
CREATE POLICY tenant_isolation ON mail_campaign_senders USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaign_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_sends;
CREATE POLICY tenant_isolation ON mail_campaign_sends USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaign_suppressions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_suppressions;
CREATE POLICY tenant_isolation ON mail_campaign_suppressions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaign_template_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_template_versions;
CREATE POLICY tenant_isolation ON mail_campaign_template_versions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaign_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_templates;
CREATE POLICY tenant_isolation ON mail_campaign_templates USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaigns;
CREATE POLICY tenant_isolation ON mail_campaigns USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_copilot_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_copilot_actions;
CREATE POLICY tenant_isolation ON mail_copilot_actions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_copilot_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_copilot_events;
CREATE POLICY tenant_isolation ON mail_copilot_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_copilot_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_copilot_memory;
CREATE POLICY tenant_isolation ON mail_copilot_memory USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_copilot_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_copilot_rules;
CREATE POLICY tenant_isolation ON mail_copilot_rules USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_copilot_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_copilot_runs;
CREATE POLICY tenant_isolation ON mail_copilot_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_copilot_sync ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_copilot_sync;
CREATE POLICY tenant_isolation ON mail_copilot_sync USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_open_hits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_open_hits;
CREATE POLICY tenant_isolation ON mail_open_hits USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE mail_open_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_open_messages;
CREATE POLICY tenant_isolation ON mail_open_messages USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
