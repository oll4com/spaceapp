-- K1 tenancy M2 part 07/12 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §5): fill tenant_id and give it a
-- default. tenant:local is exactly the owner-derived value: M0 put every user in it and nothing creates another tenant before M6.
-- The default is the request's tenant (space.tenant_id, set only by M6 code behind SPACE_TENANCY_ENABLED) and tenant:local
-- without one, so every insert of today lands in the one local tenant. The UPDATEs take row locks only; the ALTERs come last
-- so their brief ACCESS EXCLUSIVE locks are held only to commit. Rows inserted mid-run stay NULL until M3 fills them again.
SET LOCAL lock_timeout = '10s';
UPDATE monitoring_copilot_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE monitoring_copilot_memory SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_attachments SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_away_log SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_away_sessions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_conversation_marks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_decision_ledger SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_decisions SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_file_shares SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_followups SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_goal_events SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_goals SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_load_rollups SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_load_samples SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_messages SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_notes SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_pane_checks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_pane_closeouts SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_pane_summaries SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE nous_plan_marks SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE monitoring_copilot_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE monitoring_copilot_memory ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_attachments ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_away_log ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_away_sessions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_conversation_marks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_decision_ledger ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_decisions ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_file_shares ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_followups ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_goal_events ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_goals ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_load_rollups ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_load_samples ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_messages ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_notes ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_pane_checks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_pane_closeouts ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_pane_summaries ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE nous_plan_marks ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
