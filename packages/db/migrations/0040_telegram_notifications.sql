CREATE TABLE IF NOT EXISTS telegram_integrations (
  id text PRIMARY KEY CHECK (id = 'global'),
  connection_status text NOT NULL DEFAULT 'DISCONNECTED'
    CHECK (connection_status IN ('DISCONNECTED', 'PAIRING', 'CONNECTED', 'DISABLED', 'ERROR')),
  is_enabled boolean NOT NULL DEFAULT false,
  bot_user_id text,
  bot_username text,
  chat_id text,
  chat_display_name text,
  secret_version text,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  polling_offset bigint NOT NULL DEFAULT 0 CHECK (polling_offset >= 0),
  legacy_suppression_active boolean NOT NULL DEFAULT false,
  paired_at timestamptz,
  enabled_at timestamptz,
  disabled_at timestamptz,
  last_tested_at timestamptz,
  last_delivered_at timestamptz,
  error_code text,
  error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((is_enabled = false) OR (connection_status = 'CONNECTED')),
  CHECK (secret_version IS NULL OR bot_username IS NOT NULL)
);

INSERT INTO telegram_integrations (id)
VALUES ('global')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS telegram_pairing_sessions (
  pairing_id text PRIMARY KEY,
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  secret_version text NOT NULL,
  bot_user_id text NOT NULL,
  bot_username text NOT NULL,
  polling_offset bigint NOT NULL DEFAULT 0 CHECK (polling_offset >= 0),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED')),
  expires_at timestamptz NOT NULL,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_pairing_sessions_one_pending
  ON telegram_pairing_sessions ((true))
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_telegram_pairing_sessions_expiry
  ON telegram_pairing_sessions (expires_at)
  WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS codex_cli_turn_markers (
  marker_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES pane_cli_sessions(session_id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  client_turn_marker text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'IGNORED', 'FAILED')),
  codex_thread_id text,
  rollout_path text,
  completion_event_id text REFERENCES events(id) ON DELETE SET NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  check_attempt_count integer NOT NULL DEFAULT 0 CHECK (check_attempt_count >= 0),
  locked_at timestamptz,
  locked_by text,
  safe_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, client_turn_marker)
);

CREATE INDEX IF NOT EXISTS idx_codex_cli_turn_markers_pending
  ON codex_cli_turn_markers (next_check_at, submitted_at)
  WHERE status IN ('PENDING', 'PROCESSING');

CREATE TABLE IF NOT EXISTS telegram_notification_outbox (
  delivery_id text PRIMARY KEY,
  integration_generation bigint NOT NULL CHECK (integration_generation >= 0),
  source_key text NOT NULL UNIQUE,
  source_type text NOT NULL CHECK (source_type IN ('CHAT', 'ROOM_AGENT', 'TERMINAL', 'TEST')),
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  turn_id text REFERENCES turns(id) ON DELETE SET NULL,
  room_name text NOT NULL,
  pane_title text NOT NULL,
  final_response text NOT NULL CHECK (char_length(final_response) > 0),
  completed_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SENDING', 'RETRY', 'DELIVERED', 'CANCELLED', 'FAILED')),
  next_part_index integer NOT NULL DEFAULT 0 CHECK (next_part_index >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  safe_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_telegram_notification_outbox_claim
  ON telegram_notification_outbox (available_at, created_at)
  WHERE status IN ('PENDING', 'RETRY', 'SENDING');
