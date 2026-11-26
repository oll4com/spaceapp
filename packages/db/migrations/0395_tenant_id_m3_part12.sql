-- K1 tenancy M3 part 12/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): tenant_id NOT NULL, so no
-- row can be left outside a tenant once RLS (M4) filters on it. First the rows inserted while M2 ran (M2's default fills every
-- insert since). SET NOT NULL scans the table under its lock; lock_timeout fails the deploy instead of queueing traffic.
-- shortcut: no tenant indexes, UNIQUE (tenant_id, id) or composite FKs yet; with one tenant they filter nothing. Build them
-- CONCURRENTLY (outside this transactional runner) before a second tenant shares the database (M7).
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
UPDATE vault_audit SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE vault_delegations SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE vault_handoff_keys SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE vault_items SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE vault_nonces SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE vault_pending SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE vault_protected_panes SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE vault_signup_grants SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE vaults SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE video_assets SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE video_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE video_requests SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE workflows SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE vault_audit ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE vault_delegations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE vault_handoff_keys ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE vault_items ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE vault_nonces ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE vault_pending ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE vault_protected_panes ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE vault_signup_grants ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE vaults ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE video_assets ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE video_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE video_requests ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE workflows ALTER COLUMN tenant_id SET NOT NULL;
