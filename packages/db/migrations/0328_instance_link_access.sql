-- Space Link behind Cloudflare Access (plan clipboard:aGnuHjfZS8-o Λ10, Nous 13/11: a Service Auth policy, never a bypass): the Vault key
-- ids (never the values) of the service token this side sends as CF-Access-Client-Id / CF-Access-Client-Secret when it connects.
-- Null: that SpaceApp's channel is not behind Access.
ALTER TABLE instance_links ADD COLUMN IF NOT EXISTS access_keys jsonb;
