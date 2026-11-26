-- K1 tenancy M2 part 10/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
UPDATE shared_chat_messages SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE signature_requests SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE site_sign_ins SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE source_control_connections SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_agent_messages SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_agent_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_agent_sessions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_control_records SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_dots SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_first_setup_states SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_inbox_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_inbox_threads SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_notifications SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_owner_setup SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_push_devices SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_setup_connection_check_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE space_setup_connection_verifications SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE streaming_bot_activity SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE streaming_bot_message_receipts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE streaming_chat_state SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE shared_chat_messages ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE signature_requests ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE site_sign_ins ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE source_control_connections ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_agent_messages ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_agent_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_agent_sessions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_control_records ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_dots ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_first_setup_states ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_inbox_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_inbox_threads ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_notifications ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_owner_setup ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_push_devices ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_setup_connection_check_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE space_setup_connection_verifications ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE streaming_bot_activity ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE streaming_bot_message_receipts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE streaming_chat_state ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
