-- K1 tenancy M1 part 4/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE freelance_copilot_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE freelance_copilot_leads ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE freelance_copilot_mailboxes ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE freelance_copilot_memory ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE freelance_copilot_messages ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE freelance_copilot_rules ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE freelance_copilot_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE google_accounts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE instance_links ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE job_application_fields ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE job_apply_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE job_apply_memory ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE job_apply_profiles ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE job_apply_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE live_conversation_rooms ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE live_conversation_sessions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE live_conversation_turns ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE live_personal_memory ADD COLUMN IF NOT EXISTS tenant_id text;
