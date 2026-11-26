-- K1 tenancy M4 part 10/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE shared_chat_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON shared_chat_messages;
CREATE POLICY tenant_isolation ON shared_chat_messages USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE signature_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON signature_requests;
CREATE POLICY tenant_isolation ON signature_requests USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE site_sign_ins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON site_sign_ins;
CREATE POLICY tenant_isolation ON site_sign_ins USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE source_control_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON source_control_connections;
CREATE POLICY tenant_isolation ON source_control_connections USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_agent_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_agent_messages;
CREATE POLICY tenant_isolation ON space_agent_messages USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_agent_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_agent_runs;
CREATE POLICY tenant_isolation ON space_agent_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_agent_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_agent_sessions;
CREATE POLICY tenant_isolation ON space_agent_sessions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_control_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_control_records;
CREATE POLICY tenant_isolation ON space_control_records USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_dots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_dots;
CREATE POLICY tenant_isolation ON space_dots USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_first_setup_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_first_setup_states;
CREATE POLICY tenant_isolation ON space_first_setup_states USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_inbox_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_inbox_events;
CREATE POLICY tenant_isolation ON space_inbox_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_inbox_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_inbox_threads;
CREATE POLICY tenant_isolation ON space_inbox_threads USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_notifications;
CREATE POLICY tenant_isolation ON space_notifications USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_owner_setup ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_owner_setup;
CREATE POLICY tenant_isolation ON space_owner_setup USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_push_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_push_devices;
CREATE POLICY tenant_isolation ON space_push_devices USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_setup_connection_check_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_setup_connection_check_events;
CREATE POLICY tenant_isolation ON space_setup_connection_check_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE space_setup_connection_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON space_setup_connection_verifications;
CREATE POLICY tenant_isolation ON space_setup_connection_verifications USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE streaming_bot_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON streaming_bot_activity;
CREATE POLICY tenant_isolation ON streaming_bot_activity USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE streaming_bot_message_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON streaming_bot_message_receipts;
CREATE POLICY tenant_isolation ON streaming_bot_message_receipts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE streaming_chat_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON streaming_chat_state;
CREATE POLICY tenant_isolation ON streaming_chat_state USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
