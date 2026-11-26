-- K1 tenancy M4 part 12/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.2, §5): row-level security.
-- A role that does not own the table sees and writes only rows of the tenant its transaction set in space.tenant_id; none set,
-- nothing. The owner (the API and worker today, on every install) is not subject to it, so nothing changes until M5-M6 add the
-- non-owner space_app. Not FORCE yet: FORCE would need an owner policy naming a role, which every dump carries to an install
-- without that role (dev refresh, portable restore). It comes with the cutover (M7). Metadata only; lock_timeout as in M1.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
ALTER TABLE vault_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vault_audit;
CREATE POLICY tenant_isolation ON vault_audit USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE vault_delegations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vault_delegations;
CREATE POLICY tenant_isolation ON vault_delegations USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE vault_handoff_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vault_handoff_keys;
CREATE POLICY tenant_isolation ON vault_handoff_keys USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE vault_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vault_items;
CREATE POLICY tenant_isolation ON vault_items USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE vault_nonces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vault_nonces;
CREATE POLICY tenant_isolation ON vault_nonces USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE vault_pending ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vault_pending;
CREATE POLICY tenant_isolation ON vault_pending USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE vault_protected_panes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vault_protected_panes;
CREATE POLICY tenant_isolation ON vault_protected_panes USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE vault_signup_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vault_signup_grants;
CREATE POLICY tenant_isolation ON vault_signup_grants USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE vaults ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vaults;
CREATE POLICY tenant_isolation ON vaults USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE video_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON video_assets;
CREATE POLICY tenant_isolation ON video_assets USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE video_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON video_events;
CREATE POLICY tenant_isolation ON video_events USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE video_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON video_requests;
CREATE POLICY tenant_isolation ON video_requests USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workflows;
CREATE POLICY tenant_isolation ON workflows USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
