CREATE TABLE IF NOT EXISTS app_diagnostics_settings (
  singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  enabled boolean NOT NULL DEFAULT false,
  active_capture_id text,
  enabled_at timestamptz,
  enabled_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  disabled_at timestamptz,
  disabled_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  dropped_events bigint NOT NULL DEFAULT 0 CHECK (dropped_events >= 0),
  quota_drops bigint NOT NULL DEFAULT 0 CHECK (quota_drops >= 0),
  rejected_uploads bigint NOT NULL DEFAULT 0 CHECK (rejected_uploads >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (enabled = true AND active_capture_id IS NOT NULL AND enabled_at IS NOT NULL)
    OR (enabled = false AND active_capture_id IS NULL)
  )
);

INSERT INTO app_diagnostics_settings (singleton_id, enabled)
VALUES (1, false)
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_diagnostics_captures (
  capture_id text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  started_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  ended_at timestamptz,
  ended_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE IF NOT EXISTS app_diagnostics_video_leases (
  lease_id text PRIMARY KEY,
  capture_id text NOT NULL REFERENCES app_diagnostics_captures(capture_id) ON DELETE CASCADE,
  client_id text NOT NULL,
  page_client_id text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED')),
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CHECK (heartbeat_at >= acquired_at),
  CHECK (expires_at > acquired_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_diagnostics_one_active_video_lease
  ON app_diagnostics_video_leases ((status))
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_app_diagnostics_video_leases_capture
  ON app_diagnostics_video_leases (capture_id, acquired_at DESC);

CREATE TABLE IF NOT EXISTS app_diagnostics_segments (
  segment_id text PRIMARY KEY,
  capture_id text NOT NULL REFERENCES app_diagnostics_captures(capture_id) ON DELETE CASCADE,
  client_id text NOT NULL,
  batch_id text,
  batch_fingerprint text,
  lease_id text REFERENCES app_diagnostics_video_leases(lease_id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('TECHNICAL', 'DOM_SNAPSHOT', 'VIDEO')),
  relative_path text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('application/x-ndjson+gzip', 'application/json+gzip', 'video/webm')),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  first_event_sequence bigint,
  last_event_sequence bigint,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at >= started_at),
  CHECK (expires_at = ended_at + interval '24 hours'),
  CHECK (
    (first_event_sequence IS NULL AND last_event_sequence IS NULL)
    OR (
      first_event_sequence IS NOT NULL
      AND last_event_sequence IS NOT NULL
      AND first_event_sequence >= 0
      AND last_event_sequence >= first_event_sequence
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_app_diagnostics_segments_expiry
  ON app_diagnostics_segments (expires_at, ended_at, segment_id);

CREATE INDEX IF NOT EXISTS idx_app_diagnostics_segments_capture
  ON app_diagnostics_segments (capture_id, ended_at DESC, segment_id DESC);

CREATE INDEX IF NOT EXISTS idx_app_diagnostics_segments_kind_ended
  ON app_diagnostics_segments (kind, ended_at, segment_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_diagnostics_segments_technical_batch
  ON app_diagnostics_segments (capture_id, client_id, batch_id)
  WHERE kind = 'TECHNICAL' AND batch_id IS NOT NULL;
