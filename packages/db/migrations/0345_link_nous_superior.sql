-- Nous hierarchy (Space Link v2, plan clipboard:zqVWdClsx_pA step 9): the Nous a SpaceApp link names as this Nous's superior, signed by its identity
-- key: {identityPublic, label, host, chain, since, at}. Null: none. It goes when the link loses the nous grant.
ALTER TABLE app_device_sessions ADD COLUMN IF NOT EXISTS nous_superior jsonb;
