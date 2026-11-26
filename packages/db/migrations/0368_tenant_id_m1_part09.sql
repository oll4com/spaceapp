-- K1 tenancy M1 part 9/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE review_checks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE review_decisions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE review_diff_summaries ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE room_agent_actions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE room_agent_bindings ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE room_agent_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE room_agent_missions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE room_agent_monitor_settings ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE room_agent_requests ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE room_agent_task_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE room_pane_activity ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE room_pane_commands ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE room_shares ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE saved_signatures ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE security_copilot_actions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE security_copilot_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE security_copilot_findings ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE security_copilot_hosts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE security_copilot_memory ADD COLUMN IF NOT EXISTS tenant_id text;
