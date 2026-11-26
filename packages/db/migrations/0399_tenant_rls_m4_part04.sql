-- K1 tenancy M4 part 04/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE freelance_copilot_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON freelance_copilot_events;
CREATE POLICY tenant_isolation ON freelance_copilot_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE freelance_copilot_leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON freelance_copilot_leads;
CREATE POLICY tenant_isolation ON freelance_copilot_leads USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE freelance_copilot_mailboxes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON freelance_copilot_mailboxes;
CREATE POLICY tenant_isolation ON freelance_copilot_mailboxes USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE freelance_copilot_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON freelance_copilot_memory;
CREATE POLICY tenant_isolation ON freelance_copilot_memory USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE freelance_copilot_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON freelance_copilot_messages;
CREATE POLICY tenant_isolation ON freelance_copilot_messages USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE freelance_copilot_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON freelance_copilot_rules;
CREATE POLICY tenant_isolation ON freelance_copilot_rules USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE freelance_copilot_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON freelance_copilot_runs;
CREATE POLICY tenant_isolation ON freelance_copilot_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE google_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON google_accounts;
CREATE POLICY tenant_isolation ON google_accounts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE import_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON import_candidates;
CREATE POLICY tenant_isolation ON import_candidates USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE instance_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON instance_links;
CREATE POLICY tenant_isolation ON instance_links USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE job_application_fields ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_application_fields;
CREATE POLICY tenant_isolation ON job_application_fields USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE job_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_applications;
CREATE POLICY tenant_isolation ON job_applications USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE job_apply_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_apply_events;
CREATE POLICY tenant_isolation ON job_apply_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE job_apply_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_apply_memory;
CREATE POLICY tenant_isolation ON job_apply_memory USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE job_apply_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_apply_profiles;
CREATE POLICY tenant_isolation ON job_apply_profiles USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE job_apply_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_apply_runs;
CREATE POLICY tenant_isolation ON job_apply_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE live_conversation_rooms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON live_conversation_rooms;
CREATE POLICY tenant_isolation ON live_conversation_rooms USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE live_conversation_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON live_conversation_sessions;
CREATE POLICY tenant_isolation ON live_conversation_sessions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE live_conversation_turns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON live_conversation_turns;
CREATE POLICY tenant_isolation ON live_conversation_turns USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE live_personal_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON live_personal_memory;
CREATE POLICY tenant_isolation ON live_personal_memory USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
