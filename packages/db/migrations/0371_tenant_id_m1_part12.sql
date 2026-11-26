-- K1 tenancy M1 part 12/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id, nullable, on
-- TENANT tables of scripts/tests/tenant-scope.test.mjs. Metadata only (no default, no rewrite); nothing reads or writes it until M2.
-- A table held by a long query fails this migration (and the deploy, nothing applied) instead of queueing traffic behind its lock.
SET LOCAL lock_timeout = '10s';
ALTER TABLE vault_audit ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE vault_delegations ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE vault_handoff_keys ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE vault_nonces ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE vault_pending ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE vault_protected_panes ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE vault_signup_grants ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE video_assets ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE video_events ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE video_requests ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS tenant_id text;
