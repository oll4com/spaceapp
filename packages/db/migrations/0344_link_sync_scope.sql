-- Space Link settings and memory sync (plan clipboard:TcX66vjNuZDv step 3): "sync", a grant a link's owner gives in Settings > Account > Devices
-- so the linked SpaceApp's person's settings and its Space Memory flow into this one.
ALTER TABLE app_device_sessions DROP CONSTRAINT IF EXISTS app_device_sessions_scopes_check;
ALTER TABLE app_device_sessions ADD CONSTRAINT app_device_sessions_scopes_check CHECK (scopes IS NULL
  OR (scopes <@ ARRAY['read', 'act', 'decide', 'manage', 'upgrade', 'nous', 'ai', 'vault', 'sync']::text[]
    AND (app = 'spaceapp-link' OR NOT scopes && ARRAY['manage', 'upgrade', 'nous', 'ai', 'vault', 'sync']::text[])));
