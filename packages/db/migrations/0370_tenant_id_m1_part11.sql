-- K1 tenancy M1 part 11/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE streaming_moderation_actions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE swarm_locks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE swarm_messages ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE swarm_reconciles ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE swarm_tasks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE system_analytics_model_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE system_analytics_resource_buckets ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE task_title_attempts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE task_title_cooldowns ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE task_title_states ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE telegram_integrations ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE telegram_notification_outbox ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE telegram_pairing_sessions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE user_link_libraries ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE user_links ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE user_session_epochs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS tenant_id text;
