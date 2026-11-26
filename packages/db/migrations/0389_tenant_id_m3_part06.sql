-- K1 tenancy M3 part 06/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
UPDATE managed_plan_execution_commands SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE managed_plan_executions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE marketing_copilot_bookmarks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE marketing_copilot_campaigns SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE marketing_copilot_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE marketing_copilot_memory SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE marketing_copilot_metrics SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE marketing_copilot_posts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE marketing_copilot_rules SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE marketing_copilot_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE memory_command_idempotency SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE memory_consolidation_findings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE memory_consolidation_operations SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE memory_consolidation_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE memory_graph_change_sets SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE memory_graph_embeddings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE memory_graph_issue_states SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE memory_records SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE monitoring_copilot_actions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE monitoring_copilot_alerts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE managed_plan_execution_commands ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE managed_plan_executions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE marketing_copilot_bookmarks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE marketing_copilot_campaigns ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE marketing_copilot_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE marketing_copilot_memory ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE marketing_copilot_metrics ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE marketing_copilot_posts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE marketing_copilot_rules ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE marketing_copilot_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE memory_command_idempotency ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE memory_consolidation_findings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE memory_consolidation_operations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE memory_consolidation_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE memory_graph_change_sets ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE memory_graph_embeddings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE memory_graph_issue_states ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE memory_records ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE monitoring_copilot_actions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE monitoring_copilot_alerts ALTER COLUMN tenant_id SET NOT NULL;
