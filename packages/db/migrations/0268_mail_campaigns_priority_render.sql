-- Mail Campaigns (plan clipboard:IJ2ovfLg1Lbw step 9): lists that are kept but never mailed in bulk (NO_CONSENT, Nous decision 29/10),
-- and per recipient its send priority (the first campaign list holding it) and the hash of the mail the operator approved for it.
ALTER TABLE mail_campaign_lists DROP CONSTRAINT IF EXISTS mail_campaign_lists_consent_basis_check;
ALTER TABLE mail_campaign_lists ADD CONSTRAINT mail_campaign_lists_consent_basis_check
  CHECK (consent_basis IN ('CONSENT', 'CUSTOMER', 'B2B', 'CONTACT', 'IMPORTED', 'NO_CONSENT'));
ALTER TABLE mail_campaign_sends ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE mail_campaign_sends ADD COLUMN IF NOT EXISTS render_hash text;
