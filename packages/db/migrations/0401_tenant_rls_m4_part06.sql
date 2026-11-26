-- K1 tenancy M4 part 06/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE managed_plan_execution_commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON managed_plan_execution_commands;
CREATE POLICY tenant_isolation ON managed_plan_execution_commands USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE managed_plan_executions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON managed_plan_executions;
CREATE POLICY tenant_isolation ON managed_plan_executions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE marketing_copilot_bookmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing_copilot_bookmarks;
CREATE POLICY tenant_isolation ON marketing_copilot_bookmarks USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE marketing_copilot_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing_copilot_campaigns;
CREATE POLICY tenant_isolation ON marketing_copilot_campaigns USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE marketing_copilot_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing_copilot_events;
CREATE POLICY tenant_isolation ON marketing_copilot_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE marketing_copilot_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing_copilot_memory;
CREATE POLICY tenant_isolation ON marketing_copilot_memory USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE marketing_copilot_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing_copilot_metrics;
CREATE POLICY tenant_isolation ON marketing_copilot_metrics USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE marketing_copilot_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing_copilot_posts;
CREATE POLICY tenant_isolation ON marketing_copilot_posts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE marketing_copilot_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing_copilot_rules;
CREATE POLICY tenant_isolation ON marketing_copilot_rules USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE marketing_copilot_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing_copilot_runs;
CREATE POLICY tenant_isolation ON marketing_copilot_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE memory_command_idempotency ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_command_idempotency;
CREATE POLICY tenant_isolation ON memory_command_idempotency USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE memory_consolidation_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_consolidation_findings;
CREATE POLICY tenant_isolation ON memory_consolidation_findings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE memory_consolidation_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_consolidation_operations;
CREATE POLICY tenant_isolation ON memory_consolidation_operations USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE memory_consolidation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_consolidation_runs;
CREATE POLICY tenant_isolation ON memory_consolidation_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE memory_graph_change_sets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_graph_change_sets;
CREATE POLICY tenant_isolation ON memory_graph_change_sets USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE memory_graph_embeddings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_graph_embeddings;
CREATE POLICY tenant_isolation ON memory_graph_embeddings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE memory_graph_issue_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_graph_issue_states;
CREATE POLICY tenant_isolation ON memory_graph_issue_states USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON memory_records;
CREATE POLICY tenant_isolation ON memory_records USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE monitoring_copilot_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON monitoring_copilot_actions;
CREATE POLICY tenant_isolation ON monitoring_copilot_actions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE monitoring_copilot_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON monitoring_copilot_alerts;
CREATE POLICY tenant_isolation ON monitoring_copilot_alerts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
