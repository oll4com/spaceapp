-- K1 tenancy M1 part 7/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE monitoring_copilot_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE monitoring_copilot_memory ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_attachments ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_away_log ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_away_sessions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_conversation_marks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_decision_ledger ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_decisions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_file_shares ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_followups ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_goal_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_goals ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_load_rollups ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_load_samples ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_messages ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_notes ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_pane_checks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_pane_closeouts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_pane_summaries ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_plan_marks ADD COLUMN IF NOT EXISTS tenant_id text;
