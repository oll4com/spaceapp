-- Daily tasks (13/11): 0324 left scheduled_since NULL (judged from createdAt) on every schedule restored before it existed, so the Score
-- still charged the days the 9/11 Azure pause had unscheduled (X and Reddit sessions 11/11, pve VM/CT check 12/11). A pane's PATCH audits
-- each schedule it clears or sets (task.agent.update, metadata.schedule): the first set after the last clear is when it last began to apply.
WITH changes AS (
  SELECT target_id, created_at, (metadata->>'schedule')::boolean AS scheduled FROM audit_events
  WHERE action = 'task.agent.update' AND metadata->>'schedule' IN ('true', 'false')
), cleared AS (
  SELECT target_id, max(created_at) AS at FROM changes WHERE NOT scheduled GROUP BY target_id
), restored AS (
  SELECT changes.target_id, min(changes.created_at) AS at FROM changes
  JOIN cleared ON cleared.target_id = changes.target_id AND changes.created_at > cleared.at
  WHERE changes.scheduled GROUP BY changes.target_id
)
UPDATE task_items SET scheduled_since = restored.at FROM restored
WHERE task_items.id = restored.target_id AND task_items.scheduled_since IS NULL AND task_items.next_run_at IS NOT NULL;
