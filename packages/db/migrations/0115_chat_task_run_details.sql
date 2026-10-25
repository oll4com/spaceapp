-- Additive, nullable metadata: old runs remain explicitly unknown.
ALTER TABLE space_agent_runs
  ADD COLUMN execution_context jsonb,
  ADD COLUMN runtime_model_at_start text,
  ADD COLUMN started_at timestamptz;
