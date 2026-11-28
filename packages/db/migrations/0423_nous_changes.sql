-- Nous RSI (plan clipboard:CCIzkVBIbPpG step 1): one row per change Nous made to itself, measured before and after from raw
-- turn-facts counts copied at measure time, so a later reclassification of old failures cannot move a verdict.
-- Durable record (class A): never deleted by age.
CREATE TABLE IF NOT EXISTS nous_changes (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('LESSON', 'PROMPT', 'CODE', 'ROUTING')),
  ref text NOT NULL,
  cause text NOT NULL,
  metric text,
  deployed_at timestamptz NOT NULL,
  before_count integer,
  before_turns integer,
  after_count integer,
  after_turns integer,
  verdict text CHECK (verdict IN ('KEPT', 'NO_EFFECT', 'WORSE', 'UNMEASURED')),
  measured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  tenant_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('space.tenant_id', true), ''), 'tenant:local'),
  PRIMARY KEY (owner_user_id, kind, ref)
);
ALTER TABLE nous_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nous_changes;
CREATE POLICY tenant_isolation ON nous_changes USING (tenant_id = current_setting('space.tenant_id', true)) WITH CHECK (tenant_id = current_setting('space.tenant_id', true));
