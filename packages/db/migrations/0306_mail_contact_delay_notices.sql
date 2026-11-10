-- Mail Campaigns (Nous 6/11, eco-led gap): every delay notice a contact got, by the notice's own Message-ID, so a delay counts once even
-- when the health job's first pass after a restart reads the whole mailbox again; the second distinct delay makes the contact INVALID.
ALTER TABLE mail_campaign_contacts ADD COLUMN IF NOT EXISTS delay_notices jsonb NOT NULL DEFAULT '[]'::jsonb;
