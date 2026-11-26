-- Mail open tracking, who and from where (operator order 22/11, nous_msg:7763c6c7): a tracked mail's recipient display name and its tracked
-- links, and for every open or click its kind, the clicked URL and what the IP and user agent tell. Class A like 0357.
ALTER TABLE mail_open_messages ADD COLUMN IF NOT EXISTS recipient_name text NOT NULL DEFAULT '';
-- The original URLs of the mail's tracked links, by index (/api/public/mail/c/<token>/<index> redirects there).
ALTER TABLE mail_open_messages ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]';
ALTER TABLE mail_open_hits ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'OPEN';
DO $$ BEGIN
  ALTER TABLE mail_open_hits ADD CONSTRAINT mail_open_hits_kind CHECK (kind IN ('OPEN', 'CLICK'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Filled right after the hit: client and device from the user agent, reverse DNS, ISP and rough geo of the IP, and the mail proxy
-- (Google Image Proxy, Apple Mail Privacy, Outlook, Yahoo) when the IP is one and not the reader's.
ALTER TABLE mail_open_hits ADD COLUMN IF NOT EXISTS url text, ADD COLUMN IF NOT EXISTS client text, ADD COLUMN IF NOT EXISTS device text,
  ADD COLUMN IF NOT EXISTS proxy text, ADD COLUMN IF NOT EXISTS rdns text, ADD COLUMN IF NOT EXISTS isp text, ADD COLUMN IF NOT EXISTS geo text;
