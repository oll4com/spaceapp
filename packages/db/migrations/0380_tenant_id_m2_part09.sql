-- K1 tenancy M2 part 09/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
UPDATE review_checks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE review_decisions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE review_diff_summaries SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE room_agent_actions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE room_agent_bindings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE room_agent_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE room_agent_missions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE room_agent_monitor_settings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE room_agent_requests SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE room_agent_task_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE room_pane_activity SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE room_pane_commands SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE room_shares SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE rooms SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE saved_signatures SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE security_copilot_actions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE security_copilot_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE security_copilot_findings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE security_copilot_hosts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE security_copilot_memory SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE review_checks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE review_decisions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE review_diff_summaries ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE room_agent_actions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE room_agent_bindings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE room_agent_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE room_agent_missions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE room_agent_monitor_settings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE room_agent_requests ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE room_agent_task_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE room_pane_activity ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE room_pane_commands ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE room_shares ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE rooms ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE saved_signatures ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE security_copilot_actions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE security_copilot_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE security_copilot_findings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE security_copilot_hosts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE security_copilot_memory ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
