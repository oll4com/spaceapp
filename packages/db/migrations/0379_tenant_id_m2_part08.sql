-- K1 tenancy M2 part 08/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
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
ALTER TABLE nous_programs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_score_snapshots ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_shared_memory_policy ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_turn_facts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE outbox_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE owner_signatures ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE pane_agent_bindings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE pane_agent_sessions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE pane_browser_routes ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE pane_browser_sessions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE pane_cli_codex_thread_ownerships ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE pane_cli_sessions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE pane_cli_terminal_control_leases ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE pane_cli_transcript_chunks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE pane_reports ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE panes ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE personal_git_connections ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE project_repository_bindings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE provider_validation_checks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE repository_publish_operations ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
