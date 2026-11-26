-- K1 tenancy M1 part 5/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE live_personal_memory_changes ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaign_checks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaign_contacts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaign_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaign_list_members ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaign_lists ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaign_senders ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaign_sends ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaign_suppressions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaign_template_versions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaign_templates ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_campaigns ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_copilot_actions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_copilot_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_copilot_memory ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_copilot_rules ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_copilot_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_copilot_sync ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_open_hits ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mail_open_messages ADD COLUMN IF NOT EXISTS tenant_id text;
