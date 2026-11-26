-- K1 tenancy M3 part 09/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
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
ALTER TABLE review_checks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE review_decisions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE review_diff_summaries ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE room_agent_actions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE room_agent_bindings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE room_agent_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE room_agent_missions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE room_agent_monitor_settings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE room_agent_requests ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE room_agent_task_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE room_pane_activity ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE room_pane_commands ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE room_shares ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE rooms ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE saved_signatures ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE security_copilot_actions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE security_copilot_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE security_copilot_findings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE security_copilot_hosts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE security_copilot_memory ALTER COLUMN tenant_id SET NOT NULL;
