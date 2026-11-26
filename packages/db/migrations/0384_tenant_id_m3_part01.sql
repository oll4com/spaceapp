-- K1 tenancy M3 part 01/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
-- space:migration statement-per-transaction
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
ALTER TABLE activity_log_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE activity_log_settings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE admin_operation_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE app_device_sessions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE app_diagnostics_captures ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE app_diagnostics_segments ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE app_diagnostics_settings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE app_diagnostics_video_leases ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE app_studio_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE app_studio_previews ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE appointments ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE approvals ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE artifacts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE audit_chain_entries ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE audit_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE browser_capture_jobs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE browser_capture_segments ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE browser_control_leases ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE browser_handoff_requests ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE channel_events ALTER COLUMN tenant_id SET NOT NULL;
