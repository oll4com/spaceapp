-- K1 tenancy M3 part 04/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
-- space:migration statement-per-transaction
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
ALTER TABLE freelance_copilot_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE freelance_copilot_leads ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE freelance_copilot_mailboxes ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE freelance_copilot_memory ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE freelance_copilot_messages ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE freelance_copilot_rules ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE freelance_copilot_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE google_accounts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE import_candidates ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE instance_links ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE job_application_fields ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE job_applications ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE job_apply_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE job_apply_memory ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE job_apply_profiles ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE job_apply_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE live_conversation_rooms ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE live_conversation_sessions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE live_conversation_turns ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE live_personal_memory ALTER COLUMN tenant_id SET NOT NULL;
