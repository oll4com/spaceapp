-- K1 tenancy M2 part 03/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
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
ALTER TABLE design_assets ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE design_brand_kits ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE design_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE design_requests ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_browser_panes ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_delegations ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_deliverables ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_eval_cases ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_feed_entries ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_feed_state ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_goals ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_memories ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_proactive_state ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_proactive_usage ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_schedules ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_tool_invocations ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE dot_user_settings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE event_relay_state ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE freelance_copilot_accounts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
