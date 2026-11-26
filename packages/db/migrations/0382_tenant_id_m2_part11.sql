-- K1 tenancy M2 part 11/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
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
ALTER TABLE streaming_moderation_actions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE swarm_locks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE swarm_messages ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE swarm_reconciles ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE swarm_tasks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE system_analytics_model_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE system_analytics_resource_buckets ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE task_items ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE task_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE task_title_attempts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE task_title_cooldowns ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE task_title_states ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE telegram_integrations ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE telegram_notification_outbox ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE telegram_pairing_sessions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE turns ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE user_link_libraries ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE user_links ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE user_session_epochs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE user_settings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
