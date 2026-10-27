-- Vault agent access (operator decision 2026-10-18, plan clipboard:Ml8zElMcc4Ac): one switch in the dock lets agents and Nous
-- use the Vault; the dock then delegates every ACTIVE item that is not hidden from agents. Per-use approvals and the
-- operator's protected-pane step are gone: each fill protects its browser until the filled page is gone (fill_target).
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS agent_access boolean NOT NULL DEFAULT false;
-- The page a fill landed in (target, origin, document); the protection lifts once that page is gone.
ALTER TABLE vault_protected_panes ADD COLUMN IF NOT EXISTS fill_target jsonb;
-- An agent may save a login without a password (a username-only account).
ALTER TABLE vault_pending ALTER COLUMN sealed_password DROP NOT NULL;
-- agentUse used to be an opt-in that started off; it now means "not hidden from agents", so every stored item starts visible.
UPDATE vault_items SET policy = jsonb_set(policy, '{agentUse}', 'true') WHERE policy->>'agentUse' = 'false';
