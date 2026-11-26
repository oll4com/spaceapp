-- K1 tenancy M3 part 03/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
UPDATE design_assets SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE design_brand_kits SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE design_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE design_requests SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_browser_panes SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_delegations SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_deliverables SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_eval_cases SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_feed_entries SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_feed_state SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_goals SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_memories SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_proactive_state SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_proactive_usage SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_schedules SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_tool_invocations SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE dot_user_settings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE event_relay_state SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE freelance_copilot_accounts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE design_assets ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE design_brand_kits ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE design_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE design_requests ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_browser_panes ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_delegations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_deliverables ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_eval_cases ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_feed_entries ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_feed_state ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_goals ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_memories ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_proactive_state ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_proactive_usage ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_schedules ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_tool_invocations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dot_user_settings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE event_relay_state ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE freelance_copilot_accounts ALTER COLUMN tenant_id SET NOT NULL;
