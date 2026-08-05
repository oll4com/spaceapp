ALTER TABLE app_diagnostics_settings
  DROP CONSTRAINT IF EXISTS app_diagnostics_settings_enabled_by_user_id_fkey,
  DROP CONSTRAINT IF EXISTS app_diagnostics_settings_disabled_by_user_id_fkey;

ALTER TABLE app_diagnostics_captures
  DROP CONSTRAINT IF EXISTS app_diagnostics_captures_started_by_user_id_fkey,
  DROP CONSTRAINT IF EXISTS app_diagnostics_captures_ended_by_user_id_fkey;

ALTER TABLE app_diagnostics_video_leases
  DROP CONSTRAINT IF EXISTS app_diagnostics_video_leases_user_id_fkey;
