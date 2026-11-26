-- K1 tenancy M1 part 1/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE activity_log_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE activity_log_settings ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE admin_operation_runs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE app_device_sessions ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE app_diagnostics_captures ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE app_diagnostics_segments ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE app_diagnostics_settings ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE app_diagnostics_video_leases ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE app_studio_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE app_studio_previews ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE audit_chain_entries ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE browser_capture_jobs ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE browser_capture_segments ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE browser_control_leases ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE browser_handoff_requests ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE channel_events ADD COLUMN IF NOT EXISTS tenant_id text;
