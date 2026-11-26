-- K1 tenancy M1 part 10/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE shared_chat_messages ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE site_sign_ins ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE source_control_connections ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_agent_messages ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_agent_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_agent_sessions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_control_records ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_dots ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_first_setup_states ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_inbox_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_inbox_threads ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_notifications ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_owner_setup ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_push_devices ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_setup_connection_check_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE space_setup_connection_verifications ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE streaming_bot_activity ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE streaming_bot_message_receipts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE streaming_chat_state ADD COLUMN IF NOT EXISTS tenant_id text;
