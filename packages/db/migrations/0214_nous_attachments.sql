-- Files the operator sends Nous with a message (plan clipboard:hQg9iKGYDqx7): images, documents, video and other files.
-- Stored under the artifact root (nous-uploads/<owner>/...), owner-scoped; message_id stays null until the message is
-- sent. The API removes unsent files after a day, every file when the conversation is cleared, and all after 30 days.
CREATE TABLE IF NOT EXISTS nous_attachments (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id text,
  kind text NOT NULL CHECK (kind IN ('IMAGE', 'DOCUMENT', 'VIDEO', 'FILE')),
  filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 text NOT NULL,
  storage_path text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nous_attachments_owner_message_idx ON nous_attachments (owner_user_id, message_id);
CREATE INDEX IF NOT EXISTS nous_attachments_created_idx ON nous_attachments (created_at);
