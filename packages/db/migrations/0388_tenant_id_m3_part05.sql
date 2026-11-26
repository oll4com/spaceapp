-- K1 tenancy M3 part 05/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
UPDATE live_personal_memory_changes SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaign_checks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaign_contacts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaign_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaign_list_members SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaign_lists SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaign_senders SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaign_sends SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaign_suppressions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaign_template_versions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaign_templates SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_campaigns SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_copilot_actions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_copilot_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_copilot_memory SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_copilot_rules SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_copilot_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_copilot_sync SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_open_hits SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE mail_open_messages SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE live_personal_memory_changes ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaign_checks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaign_contacts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaign_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaign_list_members ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaign_lists ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaign_senders ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaign_sends ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaign_suppressions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaign_template_versions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaign_templates ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_campaigns ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_copilot_actions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_copilot_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_copilot_memory ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_copilot_rules ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_copilot_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_copilot_sync ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_open_hits ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE mail_open_messages ALTER COLUMN tenant_id SET NOT NULL;
