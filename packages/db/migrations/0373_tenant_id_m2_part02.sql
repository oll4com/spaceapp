-- K1 tenancy M2 part 02/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
SET LOCAL lock_timeout = '10s';
UPDATE channel_inbox SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE channel_link_codes SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE channel_outbox SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE cli_maintenance_auth_handoffs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE cli_maintenance_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE cli_task_revisions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE cli_tasks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE clipboard_items SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE codex_app_server_turn_smoke_checks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE codex_cli_turn_markers SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE connector_accounts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE council_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE database_connections SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_connections SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_oauth_attempts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_operations SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_preferences SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_sheets_targets SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE demo_test_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE channel_inbox ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE channel_link_codes ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE channel_outbox ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE cli_maintenance_auth_handoffs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE cli_maintenance_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE cli_task_revisions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE cli_tasks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE clipboard_items ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE codex_app_server_turn_smoke_checks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE codex_cli_turn_markers ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE connector_accounts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE council_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE database_connections ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE demo_connections ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE demo_oauth_attempts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE demo_operations ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE demo_preferences ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE demo_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE demo_sheets_targets ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE demo_test_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
