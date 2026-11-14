-- Daily tasks -95 (13/11): 0326 found the audited clear of Andy's 9/11 Azure pause but no set after it on 17 daily tasks: their 12/11
-- restore came through Nous's space_task_update, which wrote no audit before b3c6665f93, so the Score still charged the paused 11-12/11.
-- Every occurrence a schedule handles writes a task_runs row (claimTaskSchedule): the first row after the last clear is the first
-- occurrence the restored schedule owed, so it applied from that due time (the Score judges from 12 h before it). Unaudited clears
-- (Nous's own 9/11 pauses) leave nothing to anchor on and stay judged from createdAt.
WITH cleared AS (
  SELECT target_id, max(created_at) AS at FROM audit_events
  WHERE action = 'task.agent.update' AND metadata->>'schedule' = 'false' GROUP BY target_id
), first_run AS (
  SELECT task_runs.task_id, min(task_runs.due_at) AS due_at FROM task_runs
  JOIN cleared ON cleared.target_id = task_runs.task_id AND task_runs.at > cleared.at
  GROUP BY task_runs.task_id
)
UPDATE task_items SET scheduled_since = first_run.due_at FROM first_run
WHERE task_items.id = first_run.task_id AND task_items.scheduled_since IS NULL AND task_items.next_run_at IS NOT NULL;
