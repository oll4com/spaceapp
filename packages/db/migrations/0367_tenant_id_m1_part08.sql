-- K1 tenancy M1 part 8/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE nous_programs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_score_snapshots ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_shared_memory_policy ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE nous_turn_facts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE owner_signatures ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE pane_agent_bindings ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE pane_agent_sessions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE pane_browser_routes ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE pane_browser_sessions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE pane_cli_codex_thread_ownerships ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE pane_cli_sessions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE pane_cli_terminal_control_leases ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE pane_cli_transcript_chunks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE pane_reports ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE panes ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE personal_git_connections ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE project_repository_bindings ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE provider_validation_checks ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE repository_publish_operations ADD COLUMN IF NOT EXISTS tenant_id text;
