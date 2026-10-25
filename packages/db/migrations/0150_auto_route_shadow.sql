-- Space Dots Stage 7: find recent Chat tasks that carry an Auto shadow decision.
CREATE INDEX IF NOT EXISTS space_runs_auto_route ON space_agent_runs(created_at DESC) WHERE execution_context ? 'autoRoute';
