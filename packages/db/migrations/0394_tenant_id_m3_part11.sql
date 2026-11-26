-- K1 tenancy M3 part 11/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
UPDATE streaming_moderation_actions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE swarm_locks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE swarm_messages SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE swarm_reconciles SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE swarm_tasks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE system_analytics_model_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE system_analytics_resource_buckets SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE task_items SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE task_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE task_title_attempts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE task_title_cooldowns SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE task_title_states SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE telegram_integrations SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE telegram_notification_outbox SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE telegram_pairing_sessions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE turns SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE user_link_libraries SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE user_links SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE user_session_epochs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE user_settings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE streaming_moderation_actions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE swarm_locks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE swarm_messages ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE swarm_reconciles ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE swarm_tasks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE system_analytics_model_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE system_analytics_resource_buckets ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE task_items ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE task_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE task_title_attempts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE task_title_cooldowns ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE task_title_states ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE telegram_integrations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE telegram_notification_outbox ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE telegram_pairing_sessions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE turns ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE user_link_libraries ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE user_links ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE user_session_epochs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE user_settings ALTER COLUMN tenant_id SET NOT NULL;
