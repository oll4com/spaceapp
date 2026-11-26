-- K1 tenancy M4 part 11/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE streaming_moderation_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON streaming_moderation_actions;
CREATE POLICY tenant_isolation ON streaming_moderation_actions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE swarm_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON swarm_locks;
CREATE POLICY tenant_isolation ON swarm_locks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE swarm_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON swarm_messages;
CREATE POLICY tenant_isolation ON swarm_messages USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE swarm_reconciles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON swarm_reconciles;
CREATE POLICY tenant_isolation ON swarm_reconciles USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE swarm_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON swarm_tasks;
CREATE POLICY tenant_isolation ON swarm_tasks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE system_analytics_model_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON system_analytics_model_events;
CREATE POLICY tenant_isolation ON system_analytics_model_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE system_analytics_resource_buckets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON system_analytics_resource_buckets;
CREATE POLICY tenant_isolation ON system_analytics_resource_buckets USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE task_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON task_items;
CREATE POLICY tenant_isolation ON task_items USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE task_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON task_runs;
CREATE POLICY tenant_isolation ON task_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE task_title_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON task_title_attempts;
CREATE POLICY tenant_isolation ON task_title_attempts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE task_title_cooldowns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON task_title_cooldowns;
CREATE POLICY tenant_isolation ON task_title_cooldowns USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE task_title_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON task_title_states;
CREATE POLICY tenant_isolation ON task_title_states USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE telegram_integrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON telegram_integrations;
CREATE POLICY tenant_isolation ON telegram_integrations USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE telegram_notification_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON telegram_notification_outbox;
CREATE POLICY tenant_isolation ON telegram_notification_outbox USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE telegram_pairing_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON telegram_pairing_sessions;
CREATE POLICY tenant_isolation ON telegram_pairing_sessions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE turns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON turns;
CREATE POLICY tenant_isolation ON turns USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE user_link_libraries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_link_libraries;
CREATE POLICY tenant_isolation ON user_link_libraries USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE user_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_links;
CREATE POLICY tenant_isolation ON user_links USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE user_session_epochs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_session_epochs;
CREATE POLICY tenant_isolation ON user_session_epochs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_settings;
CREATE POLICY tenant_isolation ON user_settings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
