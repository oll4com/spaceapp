-- K1 tenancy M1 part 6/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE managed_plan_execution_commands ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE managed_plan_executions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE marketing_copilot_bookmarks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE marketing_copilot_campaigns ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE marketing_copilot_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE marketing_copilot_memory ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE marketing_copilot_metrics ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE marketing_copilot_posts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE marketing_copilot_rules ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE marketing_copilot_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE memory_command_idempotency ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE memory_consolidation_findings ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE memory_consolidation_operations ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE memory_consolidation_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE memory_graph_change_sets ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE memory_graph_embeddings ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE memory_graph_issue_states ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE monitoring_copilot_actions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE monitoring_copilot_alerts ADD COLUMN IF NOT EXISTS tenant_id text;
