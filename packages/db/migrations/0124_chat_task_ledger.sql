-- Additive: older writers remain compatible. Historical rows keep NULL rather
-- than inventing model observation times, token counts or quality evidence.
ALTER TABLE space_agent_runs ADD COLUMN task_ledger jsonb;
ALTER TABLE space_agent_runs ADD CONSTRAINT space_agent_runs_task_ledger_object
  CHECK (task_ledger IS NULL OR (jsonb_typeof(task_ledger) = 'object' AND COALESCE(task_ledger->>'version' = '1', false)));
