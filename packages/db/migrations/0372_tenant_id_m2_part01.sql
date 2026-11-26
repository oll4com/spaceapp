-- K1 tenancy M2 part 01/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
SET LOCAL lock_timeout = '10s';
UPDATE activity_log_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE activity_log_settings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE admin_operation_runs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE app_device_sessions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE app_diagnostics_captures SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE app_diagnostics_segments SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE app_diagnostics_settings SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE app_diagnostics_video_leases SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE app_studio_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE app_studio_previews SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE appointments SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE approvals SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE artifacts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE audit_chain_entries SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE audit_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE browser_capture_jobs SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE browser_capture_segments SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE browser_control_leases SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE browser_handoff_requests SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE channel_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE activity_log_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE activity_log_settings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE admin_operation_runs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE app_device_sessions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE app_diagnostics_captures ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE app_diagnostics_segments ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE app_diagnostics_settings ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE app_diagnostics_video_leases ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE app_studio_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE app_studio_previews ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE appointments ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE approvals ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE artifacts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE audit_chain_entries ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE audit_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE browser_capture_jobs ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE browser_capture_segments ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE browser_control_leases ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE browser_handoff_requests ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE channel_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
