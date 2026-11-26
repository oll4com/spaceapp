-- K1 tenancy M1 part 3/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE design_brand_kits ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE design_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE design_requests ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_browser_panes ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_delegations ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_deliverables ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_eval_cases ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_feed_entries ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_feed_state ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_goals ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_memories ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_proactive_state ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_proactive_usage ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_schedules ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_tool_invocations ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE dot_user_settings ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE event_relay_state ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE freelance_copilot_accounts ADD COLUMN IF NOT EXISTS tenant_id text;
