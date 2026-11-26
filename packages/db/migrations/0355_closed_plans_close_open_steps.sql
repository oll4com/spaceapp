-- Operator 22/11: 50 plans closed at 100% still listed steps PENDING/IN_PROGRESS/BLOCKED (most closed 26/10), so they stayed in
-- "Closed with work left". A closing plan now takes its open steps with it (closeOpenPlanSteps); this closes the ones already closed.
-- Parked plans and managed executions keep theirs.
UPDATE clipboard_items c
SET steps_json = (SELECT jsonb_agg(CASE WHEN step->>'status' IN ('COMPLETED', 'FAILED') THEN step
    ELSE step || jsonb_build_object('status', 'COMPLETED', 'progress', 100, 'completedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END
    ORDER BY position) FROM jsonb_array_elements(c.steps_json) WITH ORDINALITY AS each_step(step, position))
WHERE c.is_completed = true AND c.progress_percentage >= 100
  AND jsonb_typeof(c.steps_json) = 'array'
  AND jsonb_path_exists(c.steps_json, '$[*] ? (@.status != "COMPLETED" && @.status != "FAILED")')
  AND (c.parked_json IS NULL OR c.parked_json->>'resumedAt' IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM managed_plan_executions m WHERE m.plan_id = c.id AND m.owner_user_id = c.owner_user_id);
