-- Space Link Vault sync (plan clipboard:TcX66vjNuZDv step 2): "vault", a grant a link's owner gives in Settings > Account > Devices so the
-- linked SpaceApp keeps this one's Vault a copy of its own; and, on the sending side, the operator's signed consent per link (vault_sync).
ALTER TABLE app_device_sessions DROP CONSTRAINT IF EXISTS app_device_sessions_scopes_check;
ALTER TABLE app_device_sessions ADD CONSTRAINT app_device_sessions_scopes_check CHECK (scopes IS NULL
  OR (scopes <@ ARRAY['read', 'act', 'decide', 'manage', 'upgrade', 'nous', 'ai', 'vault']::text[]
    AND (app = 'spaceapp-link' OR NOT scopes && ARRAY['manage', 'upgrade', 'nous', 'ai', 'vault']::text[])));
ALTER TABLE instance_links ADD COLUMN IF NOT EXISTS vault_sync jsonb;
