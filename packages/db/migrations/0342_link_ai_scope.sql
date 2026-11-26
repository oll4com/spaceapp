-- Space Link v2 step 6 (ADR-014): "ai", a grant a link's owner gives in Settings > Account > Devices so the linked SpaceApp lends this one
-- its AI accounts through its Gateway. Like manage/upgrade/nous, only a SpaceApp link holds it.
ALTER TABLE app_device_sessions DROP CONSTRAINT IF EXISTS app_device_sessions_scopes_check;
ALTER TABLE app_device_sessions ADD CONSTRAINT app_device_sessions_scopes_check CHECK (scopes IS NULL
  OR (scopes <@ ARRAY['read', 'act', 'decide', 'manage', 'upgrade', 'nous', 'ai']::text[]
    AND (app = 'spaceapp-link' OR NOT scopes && ARRAY['manage', 'upgrade', 'nous', 'ai']::text[])));
