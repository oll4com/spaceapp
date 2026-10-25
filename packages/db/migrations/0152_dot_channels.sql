-- Space Dots Stage 6: Slack and Teams conversations with a user's Dots. Identities are linked with one-time
-- codes; each external thread maps to one Dot conversation of its owner; events are deduplicated and replies
-- go through an outbox with one row per result, question or approval.
CREATE TABLE IF NOT EXISTS channel_identities (
  identity_id text PRIMARY KEY CHECK (identity_id ~ '^channel_identity:[a-f0-9]{32}$'),
  provider text NOT NULL CHECK (provider IN ('SLACK','TEAMS')),
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 200),
  external_user_id text NOT NULL CHECK (char_length(external_user_id) BETWEEN 1 AND 200),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text CHECK (display_name IS NULL OR char_length(display_name) <= 200),
  -- Where a direct message reaches the user (Slack user id, Teams channel account id).
  reply_address text NOT NULL CHECK (char_length(reply_address) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, tenant_id, external_user_id)
);
CREATE INDEX IF NOT EXISTS channel_identities_owner_idx ON channel_identities(owner_user_id);

CREATE TABLE IF NOT EXISTS channel_link_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_threads (
  thread_id text PRIMARY KEY CHECK (thread_id ~ '^channel_thread:[a-f0-9]{32}$'),
  provider text NOT NULL CHECK (provider IN ('SLACK','TEAMS')),
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 200),
  conversation_id text NOT NULL CHECK (char_length(conversation_id) BETWEEN 1 AND 500),
  thread_key text NOT NULL CHECK (char_length(thread_key) BETWEEN 1 AND 500),
  conversation_kind text NOT NULL CHECK (conversation_kind IN ('DIRECT','GROUP')),
  identity_id text NOT NULL REFERENCES channel_identities(identity_id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dot_id text NOT NULL REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  session_id text REFERENCES space_agent_sessions(session_id) ON DELETE SET NULL,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  service_url text CHECK (service_url IS NULL OR service_url ~ '^https://'),
  reply_in_thread boolean NOT NULL DEFAULT false,
  last_delivered_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, tenant_id, conversation_id, thread_key)
);
CREATE INDEX IF NOT EXISTS channel_threads_owner_idx ON channel_threads(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS channel_threads_session_idx ON channel_threads(session_id) WHERE session_id IS NOT NULL;

-- Provider retries carry the same event id; each is handled once.
CREATE TABLE IF NOT EXISTS channel_events (
  provider text NOT NULL CHECK (provider IN ('SLACK','TEAMS')),
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 300),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX IF NOT EXISTS channel_events_received_idx ON channel_events(received_at);

-- Every message from the channel, in order: waiting for the Dot (PENDING), sent and waiting for its result (SENT),
-- answered in the channel (DELIVERED) or not sent (DROPPED). Only these requests' results go back to the channel.
CREATE TABLE IF NOT EXISTS channel_inbox (
  thread_id text NOT NULL REFERENCES channel_threads(thread_id) ON DELETE CASCADE,
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 300),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 8000),
  request_key text NOT NULL CHECK (request_key ~ '^channel-[a-f0-9]{40}$'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','DELIVERED','DROPPED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, event_id)
);
CREATE INDEX IF NOT EXISTS channel_inbox_open_idx ON channel_inbox(thread_id, created_at) WHERE status IN ('PENDING','SENT');

CREATE TABLE IF NOT EXISTS channel_outbox (
  outbox_id text PRIMARY KEY CHECK (outbox_id ~ '^channel_out:[a-f0-9]{32}$'),
  thread_id text NOT NULL REFERENCES channel_threads(thread_id) ON DELETE CASCADE,
  source_key text NOT NULL UNIQUE CHECK (char_length(source_key) BETWEEN 3 AND 300),
  kind text NOT NULL CHECK (kind IN ('RESULT','QUESTION','APPROVAL','NOTICE')),
  target text NOT NULL CHECK (target IN ('THREAD','DIRECT')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 12000),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS channel_outbox_due_idx ON channel_outbox(next_attempt_at) WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION space_channel_thread_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM channel_identities i JOIN space_dots d ON d.owner_user_id=i.owner_user_id
    WHERE i.identity_id=NEW.identity_id AND i.owner_user_id=NEW.owner_user_id AND d.dot_id=NEW.dot_id
      AND i.provider=NEW.provider AND i.tenant_id=NEW.tenant_id) THEN
    RAISE EXCEPTION 'A channel thread must belong to its linked owner and one of their Dots' USING ERRCODE='23514';
  END IF;
  IF NEW.session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM space_agent_sessions s WHERE s.session_id=NEW.session_id AND s.dot_id=NEW.dot_id) THEN
    RAISE EXCEPTION 'A channel thread conversation must belong to its Dot' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.identity_id IS DISTINCT FROM OLD.identity_id
    OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.thread_key IS DISTINCT FROM OLD.thread_key) THEN
    RAISE EXCEPTION 'A channel thread keeps its owner and conversation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS space_channel_thread_identity ON channel_threads;
CREATE TRIGGER space_channel_thread_identity BEFORE INSERT OR UPDATE ON channel_threads
  FOR EACH ROW EXECUTE FUNCTION space_channel_thread_identity();
