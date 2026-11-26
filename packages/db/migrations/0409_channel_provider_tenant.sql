-- K1 tenancy for channel_identities and channel_threads (plan clipboard:ZGz1LnD51ELH step 17, Nous decision 23/11): their 0152
-- tenant_id is the provider's tenant (a Slack team or Teams tenant), so it becomes provider_tenant_id, data kept, and the tables
-- then get Space's own tenant_id exactly as M1-M4 gave every other TENANT table (nullable, filled with tenant:local and the
-- session's default, NOT NULL, row-level security). Nothing changes for the owner (today's API); SPACE_TENANCY_ENABLED stays off.
-- Every line is safe to run again after a failed deploy: the renames run only while provider_tenant_id is missing, so a re-run
-- never renames our own tenant_id. Until the function is replaced the trigger fails a new thread; seconds, during the deploy.
-- space:migration statement-per-transaction
SET LOCAL lock_timeout = '10s';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'channel_identities' AND column_name = 'provider_tenant_id') THEN ALTER TABLE channel_identities RENAME COLUMN tenant_id TO provider_tenant_id; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'channel_threads' AND column_name = 'provider_tenant_id') THEN ALTER TABLE channel_threads RENAME COLUMN tenant_id TO provider_tenant_id; END IF; END $$;
CREATE OR REPLACE FUNCTION space_channel_thread_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS (SELECT 1 FROM channel_identities i JOIN space_dots d ON d.owner_user_id=i.owner_user_id WHERE i.identity_id=NEW.identity_id AND i.owner_user_id=NEW.owner_user_id AND d.dot_id=NEW.dot_id AND i.provider=NEW.provider AND i.provider_tenant_id=NEW.provider_tenant_id) THEN RAISE EXCEPTION 'A channel thread must belong to its linked owner and one of their Dots' USING ERRCODE='23514'; END IF; IF NEW.session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM space_agent_sessions s WHERE s.session_id=NEW.session_id AND s.dot_id=NEW.dot_id) THEN RAISE EXCEPTION 'A channel thread conversation must belong to its Dot' USING ERRCODE='23514'; END IF; IF TG_OP='UPDATE' AND (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.identity_id IS DISTINCT FROM OLD.identity_id OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.thread_key IS DISTINCT FROM OLD.thread_key) THEN RAISE EXCEPTION 'A channel thread keeps its owner and conversation' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
ALTER TABLE channel_identities ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE channel_threads ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE channel_identities SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE channel_threads SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE channel_identities ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
ALTER TABLE channel_threads ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local');
UPDATE channel_identities SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
UPDATE channel_threads SET tenant_id = 'tenant:local' WHERE tenant_id IS NULL;
ALTER TABLE channel_identities ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE channel_threads ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE channel_identities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON channel_identities;
CREATE POLICY tenant_isolation ON channel_identities USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
ALTER TABLE channel_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON channel_threads;
CREATE POLICY tenant_isolation ON channel_threads USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
