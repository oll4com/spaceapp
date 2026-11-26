-- The web version of each sent campaign mail (plan clipboard:vxtgxdSGE586 step 4): the HTML as it left, without the open pixel, gzip.
-- Class B (a copy; webVersion rebuilds a missing one from the template version), gone with its campaign.
CREATE TABLE IF NOT EXISTS mail_campaign_web_copies (
  campaign_id text NOT NULL REFERENCES mail_campaigns(id) ON DELETE CASCADE,
  contact_id text NOT NULL,
  owner_user_id text NOT NULL,
  html_gzip bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local'),
  PRIMARY KEY (campaign_id, contact_id)
);
ALTER TABLE mail_campaign_web_copies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail_campaign_web_copies;
CREATE POLICY tenant_isolation ON mail_campaign_web_copies USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
