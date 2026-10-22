-- Vault (plan clipboard:vEYtT6-bEN0J step 2, ADR-012): per-user encrypted credentials. These tables hold ciphertext
-- envelopes, public keys and non-secret metadata only. No plaintext secret, VRK, password, password-derived key or
-- ARK is ever stored: the browser seals the password share and item fields, the root-owned broker seals the server
-- share and delegation keys. Every row carries its owner and every read is owner-scoped.
CREATE TABLE IF NOT EXISTS vaults (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  format_version integer NOT NULL CHECK (format_version = 1),
  kdf jsonb NOT NULL,                    -- Argon2id parameters and salt (non-secret)
  password_envelope jsonb NOT NULL,      -- password share + unlock signing key, under the password KEK
  server_share_envelope jsonb NOT NULL,  -- server share under the ARK-derived key (broker)
  unlock_public_key text NOT NULL,       -- Ed25519 SPKI that verifies unlock challenges
  unlock_key_version integer NOT NULL CHECK (unlock_key_version >= 1),
  recovery jsonb,                        -- recovery envelope; null until the operator sets one up
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch >= 1),                       -- raised by lock, logout, rotation, revoke, restart
  delegation_generation integer NOT NULL DEFAULT 0 CHECK (delegation_generation >= 0),  -- 0: never delegated
  audit_seq bigint NOT NULL DEFAULT 0,
  audit_head text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vault_items (
  id text PRIMARY KEY,                   -- opaque handle, never reused
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL,
  origins text[] NOT NULL,
  field_roles text[] NOT NULL,
  policy jsonb NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  dek_envelope jsonb NOT NULL,           -- item key under the VRK
  fields jsonb NOT NULL,                 -- field role -> envelope under the item key
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vault_items_owner_idx ON vault_items (owner_user_id, vault_id);

CREATE TABLE IF NOT EXISTS vault_delegations (
  id text PRIMARY KEY,                   -- the certificate id
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation >= 1),
  certificate jsonb NOT NULL,            -- broker-signed claims
  key_envelope jsonb,                    -- fill key under the generation's ARK-derived key; null once revoked
  fill_envelopes jsonb,                  -- item -> field -> envelope under the fill key; null once revoked
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((status = 'ACTIVE') = (key_envelope IS NOT NULL AND fill_envelopes IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS vault_delegations_generation_idx ON vault_delegations (vault_id, generation);

-- One-time nonces (unlock challenges, fill capabilities, request ids): consumed once, only in their epoch/generation.
CREATE TABLE IF NOT EXISTS vault_nonces (
  nonce text PRIMARY KEY,
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('UNLOCK_CHALLENGE', 'FILL_USE', 'REQUEST')),
  epoch integer NOT NULL,
  generation integer,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vault_nonces_expiry_idx ON vault_nonces (expires_at);

-- Per-vault hash chain; payload is ids, enums and short codes only.
CREATE TABLE IF NOT EXISTS vault_audit (
  id text PRIMARY KEY,
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  event jsonb NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (vault_id, seq)
);
