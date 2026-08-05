ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS route_profile text,
  ADD COLUMN IF NOT EXISTS backing_provider_id text,
  ADD COLUMN IF NOT EXISTS credential_ref text,
  ADD COLUMN IF NOT EXISTS is_builtin boolean NOT NULL DEFAULT false;

ALTER TABLE providers
  DROP CONSTRAINT IF EXISTS providers_route_profile_check;

ALTER TABLE providers
  ADD CONSTRAINT providers_route_profile_check
  CHECK (
    route_profile IS NULL OR route_profile IN (
      'headroom',
      'direct-primary',
      'direct-auto',
      'direct-fallback',
      'openai-direct',
      'custom'
    )
  );

CREATE TABLE IF NOT EXISTS provider_settings (
  id text PRIMARY KEY CHECK (id = 'global'),
  default_provider_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO provider_settings (id, default_provider_id, updated_at)
VALUES ('global', 'headroom-gateway', now())
ON CONFLICT (id) DO NOTHING;
