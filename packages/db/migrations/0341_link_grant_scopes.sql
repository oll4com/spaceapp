-- Space Link v2 (ADR-014 v2, plan clipboard:zqVWdClsx_pA step 2): a SpaceApp link may also hold manage, upgrade and nous, which its
-- owner grants per link in Settings > Account > Devices; a phone never does. requested_scopes keeps the pairing's own set.
ALTER TABLE app_device_sessions DROP CONSTRAINT IF EXISTS app_device_sessions_scopes_check;
ALTER TABLE app_device_sessions ADD CONSTRAINT app_device_sessions_scopes_check CHECK (scopes IS NULL
  OR (scopes <@ ARRAY['read', 'act', 'decide', 'manage', 'upgrade', 'nous']::text[]
    AND (app = 'spaceapp-link' OR NOT scopes && ARRAY['manage', 'upgrade', 'nous']::text[])));
