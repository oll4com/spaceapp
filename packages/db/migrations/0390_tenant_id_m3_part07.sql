-- K1 tenancy M3 part 07/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
UPDATE monitoring_copilot_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE monitoring_copilot_memory SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_attachments SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_away_log SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_away_sessions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_conversation_marks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_decision_ledger SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_decisions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_file_shares SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_followups SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_goal_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_goals SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_load_rollups SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_load_samples SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_messages SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_notes SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_pane_checks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_pane_closeouts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_pane_summaries SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_plan_marks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE monitoring_copilot_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE monitoring_copilot_memory ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_attachments ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_away_log ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_away_sessions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_conversation_marks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_decision_ledger ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_decisions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_file_shares ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_followups ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_goal_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_goals ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_load_rollups ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_load_samples ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_messages ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_notes ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_pane_checks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_pane_closeouts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_pane_summaries ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_plan_marks ALTER COLUMN tenant_id SET NOT NULL;
