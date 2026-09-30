ALTER TABLE admin_operation_runs DROP CONSTRAINT IF EXISTS admin_operation_runs_operation_type_check;
ALTER TABLE admin_operation_runs ADD CONSTRAINT admin_operation_runs_operation_type_check CHECK
(operation_type IN ('CLI_MAINTENANCE_CHECK','CLI_MAINTENANCE_UPDATE','CLI_MAINTENANCE_REPAIR','CLI_MAINTENANCE_PLAN','CLI_MAINTENANCE_APPLY','SPACE_RELEASE'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_apply_plan ON admin_operation_runs ((result->>'planId'))
WHERE operation_type = 'CLI_MAINTENANCE_APPLY';
CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_apply_idempotency ON admin_operation_runs (actor_user_id, (result->>'idempotencyKey'))
WHERE operation_type = 'CLI_MAINTENANCE_APPLY';
