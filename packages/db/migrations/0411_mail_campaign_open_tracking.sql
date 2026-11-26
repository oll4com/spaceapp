-- Open tracking for campaign sends (plan clipboard:ES4AQEtVuDon step 2): a campaign's `track` flag (in its fingerprint when on), and the
-- send a tracked mail belongs to (campaign + contact, the mail_campaign_sends key; null for a Mail Copilot mail). Class A like 0357.
ALTER TABLE mail_campaigns ADD COLUMN IF NOT EXISTS track boolean NOT NULL DEFAULT false;
ALTER TABLE mail_open_messages ADD COLUMN IF NOT EXISTS campaign_id text REFERENCES mail_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id text;
CREATE INDEX IF NOT EXISTS mail_open_messages_campaign ON mail_open_messages (campaign_id) WHERE campaign_id IS NOT NULL;
