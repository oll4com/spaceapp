-- K1 tenancy M2 part 04/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
SET LOCAL lock_timeout = '10s';
UPDATE freelance_copilot_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE freelance_copilot_leads SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE freelance_copilot_mailboxes SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE freelance_copilot_memory SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE freelance_copilot_messages SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE freelance_copilot_rules SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE freelance_copilot_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE google_accounts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE import_candidates SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE instance_links SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE job_application_fields SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE job_applications SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE job_apply_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE job_apply_memory SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE job_apply_profiles SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE job_apply_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE live_conversation_rooms SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE live_conversation_sessions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE live_conversation_turns SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE live_personal_memory SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE freelance_copilot_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE freelance_copilot_leads ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE freelance_copilot_mailboxes ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE freelance_copilot_memory ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE freelance_copilot_messages ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE freelance_copilot_rules ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE freelance_copilot_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE google_accounts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE import_candidates ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE instance_links ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE job_application_fields ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE job_applications ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE job_apply_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE job_apply_memory ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE job_apply_profiles ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE job_apply_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE live_conversation_rooms ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE live_conversation_sessions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE live_conversation_turns ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE live_personal_memory ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
