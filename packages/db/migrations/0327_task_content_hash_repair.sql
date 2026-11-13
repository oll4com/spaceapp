-- Daily tasks (13/11): updateTaskItem changed a task's objective but kept the old content_hash, so a rebind (Nous's space_task_update bind,
-- the scheduler's new pane for a gone one) keyed by the objective inserted a new unscheduled copy and left the task on its dead pane (Temu
-- 12/11 "pane no longer exists"). Re-key such rows: one per objective (the scheduled one first), none whose objective another row already
-- holds (those keep their hash; no merge, no delete).
WITH keyed AS (
  SELECT id, owner_user_id, next_run_at, created_at, content_hash, encode(sha256(convert_to(objective, 'UTF8')), 'hex') AS objective_hash FROM task_items
), fixed AS (
  SELECT DISTINCT ON (owner_user_id, objective_hash) id, objective_hash FROM keyed
  WHERE content_hash <> objective_hash
    AND NOT EXISTS (SELECT 1 FROM task_items AS other WHERE other.owner_user_id = keyed.owner_user_id AND other.content_hash = keyed.objective_hash)
  ORDER BY owner_user_id, objective_hash, next_run_at IS NULL, created_at DESC
)
UPDATE task_items SET content_hash = fixed.objective_hash FROM fixed WHERE task_items.id = fixed.id;
