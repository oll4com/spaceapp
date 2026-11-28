-- Nous Computer K5 (plan clipboard:ZGz1LnD51ELH step 7, Nous decision 27387eef): the tenant's own Anthropic key, sealed by the hub
-- (apps/api/src/computer/ai-key.ts, AES-256-GCM bound to the tenant id), its last four characters, and when a real call accepted it.
-- The key reaches only the cells host's relay, never the cell; the K1 purge clears it with the account.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_key_sealed text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_key_hint text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_key_checked_at timestamptz;
