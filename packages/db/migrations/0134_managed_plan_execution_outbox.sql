-- Reconcile already committed states, including terminal states, into the durable
-- revision outbox. New writes append outbox entries inside the execution/PLAN txn.
UPDATE managed_plan_executions SET record = record || jsonb_build_object(
  'eventCursor', -1,
  'events', jsonb_build_array(jsonb_build_object('revision',revision,'status',status,
    'activeStageIndex',record->'activeStageIndex','createdAt',record->>'updatedAt'))
) WHERE NOT record ? 'events';
CREATE INDEX IF NOT EXISTS managed_plan_pending_events ON managed_plan_executions(created_at)
WHERE COALESCE((record->>'eventCursor')::integer,-1)<revision;
-- Historical mutable-default observations are not turn evidence. Preserve attempt
-- history and progress, but remove the unsupported attribution; never invent proof.
UPDATE managed_plan_executions e SET record=jsonb_set(record,'{attempts}',
  (SELECT COALESCE(jsonb_agg(CASE WHEN a->'actualSelection'->>'source'='NATIVE_CURRENT_TURN'
    THEN jsonb_set(a,'{actualSelection}','null'::jsonb) ELSE a END),'[]'::jsonb)
   FROM jsonb_array_elements(record->'attempts') a))
WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(record->'attempts') a WHERE a->'actualSelection'->>'source'='NATIVE_CURRENT_TURN');
