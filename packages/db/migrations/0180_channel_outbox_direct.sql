-- Space Dots Stage 8 follow-up: a Dot's own messages can also reach its owner in Slack (Settings → Dots →
-- Messages from your Dot → Also send to Slack). A linked account may never have started a thread, so such an
-- outbox row names the linked account instead of a thread and is always a direct message. Additive.
ALTER TABLE channel_outbox ADD COLUMN IF NOT EXISTS identity_id text REFERENCES channel_identities(identity_id) ON DELETE CASCADE;
ALTER TABLE channel_outbox ALTER COLUMN thread_id DROP NOT NULL;
ALTER TABLE channel_outbox DROP CONSTRAINT IF EXISTS channel_outbox_thread_or_identity;
ALTER TABLE channel_outbox ADD CONSTRAINT channel_outbox_thread_or_identity
  CHECK (thread_id IS NOT NULL OR (identity_id IS NOT NULL AND target = 'DIRECT'));
