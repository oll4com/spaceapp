-- K1 tenancy M0 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.1, §5): the tenant is the isolation
-- boundary of a shared database. Additive only: a self-hosted SpaceApp is one tenant, tenant:local, and every user is put in it.
-- Nothing reads tenants or users.tenant_id until SPACE_TENANCY_ENABLED code lands (M6); guard: scripts/tests/tenant-scope.test.mjs.
CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY CHECK (id ~ '^tenant:[A-Za-z0-9_-]+$'),
  kind text NOT NULL DEFAULT 'PERSONAL' CHECK (kind IN ('PERSONAL', 'TEAM')),
  region text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'DELETING')),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenants (id) VALUES ('tenant:local') ON CONFLICT (id) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id text REFERENCES tenants(id);
UPDATE users SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
-- Every insert path that names no tenant (all of today's) keeps landing in the one local tenant.
ALTER TABLE users ALTER COLUMN tenant_id SET DEFAULT 'tenant:local';
ALTER TABLE users ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS users_tenant_id_idx ON users (tenant_id);
