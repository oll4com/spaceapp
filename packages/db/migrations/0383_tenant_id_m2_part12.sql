-- K1 tenancy M2 part 12/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
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
ALTER TABLE vault_audit ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE vault_delegations ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE vault_handoff_keys ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE vault_items ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE vault_nonces ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE vault_pending ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE vault_protected_panes ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE vault_signup_grants ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE vaults ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE video_assets ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE video_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE video_requests ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE workflows ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
