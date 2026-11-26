-- K1 tenancy M3 part 08/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
UPDATE nous_programs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_score_snapshots SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_shared_memory_policy SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_turn_facts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE outbox_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE owner_signatures SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE pane_agent_bindings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE pane_agent_sessions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE pane_browser_routes SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE pane_browser_sessions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE pane_cli_codex_thread_ownerships SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE pane_cli_sessions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE pane_cli_terminal_control_leases SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE pane_cli_transcript_chunks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE pane_reports SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE panes SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE personal_git_connections SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE project_repository_bindings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE provider_validation_checks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE repository_publish_operations SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE nous_programs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_score_snapshots ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_shared_memory_policy ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE nous_turn_facts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE outbox_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE owner_signatures ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pane_agent_bindings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pane_agent_sessions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pane_browser_routes ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pane_browser_sessions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pane_cli_codex_thread_ownerships ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pane_cli_sessions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pane_cli_terminal_control_leases ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pane_cli_transcript_chunks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pane_reports ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE panes ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE personal_git_connections ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE project_repository_bindings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE provider_validation_checks ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE repository_publish_operations ALTER COLUMN tenant_id SET NOT NULL;
