-- K1 tenancy M2 part 06/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
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
ALTER TABLE managed_plan_execution_commands ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE managed_plan_executions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE marketing_copilot_bookmarks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE marketing_copilot_campaigns ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE marketing_copilot_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE marketing_copilot_memory ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE marketing_copilot_metrics ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE marketing_copilot_posts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE marketing_copilot_rules ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE marketing_copilot_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE memory_command_idempotency ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE memory_consolidation_findings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE memory_consolidation_operations ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE memory_consolidation_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE memory_graph_change_sets ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE memory_graph_embeddings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE memory_graph_issue_states ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE memory_records ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE monitoring_copilot_actions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE monitoring_copilot_alerts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
