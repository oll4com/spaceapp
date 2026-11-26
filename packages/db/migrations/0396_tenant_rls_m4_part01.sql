-- K1 tenancy M4 part 01/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE activity_log_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON activity_log_events;
CREATE POLICY tenant_isolation ON activity_log_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE activity_log_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON activity_log_settings;
CREATE POLICY tenant_isolation ON activity_log_settings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE admin_operation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON admin_operation_runs;
CREATE POLICY tenant_isolation ON admin_operation_runs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE app_device_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app_device_sessions;
CREATE POLICY tenant_isolation ON app_device_sessions USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE app_diagnostics_captures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app_diagnostics_captures;
CREATE POLICY tenant_isolation ON app_diagnostics_captures USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE app_diagnostics_segments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app_diagnostics_segments;
CREATE POLICY tenant_isolation ON app_diagnostics_segments USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE app_diagnostics_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app_diagnostics_settings;
CREATE POLICY tenant_isolation ON app_diagnostics_settings USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE app_diagnostics_video_leases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app_diagnostics_video_leases;
CREATE POLICY tenant_isolation ON app_diagnostics_video_leases USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE app_studio_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app_studio_events;
CREATE POLICY tenant_isolation ON app_studio_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE app_studio_previews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app_studio_previews;
CREATE POLICY tenant_isolation ON app_studio_previews USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON appointments;
CREATE POLICY tenant_isolation ON appointments USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON approvals;
CREATE POLICY tenant_isolation ON approvals USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON artifacts;
CREATE POLICY tenant_isolation ON artifacts USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE audit_chain_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_chain_entries;
CREATE POLICY tenant_isolation ON audit_chain_entries USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_events;
CREATE POLICY tenant_isolation ON audit_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE browser_capture_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON browser_capture_jobs;
CREATE POLICY tenant_isolation ON browser_capture_jobs USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE browser_capture_segments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON browser_capture_segments;
CREATE POLICY tenant_isolation ON browser_capture_segments USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE browser_control_leases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON browser_control_leases;
CREATE POLICY tenant_isolation ON browser_control_leases USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE browser_handoff_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON browser_handoff_requests;
CREATE POLICY tenant_isolation ON browser_handoff_requests USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE channel_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON channel_events;
CREATE POLICY tenant_isolation ON channel_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
