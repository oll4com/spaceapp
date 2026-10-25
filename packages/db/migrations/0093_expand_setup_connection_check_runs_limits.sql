ALTER TABLE space_setup_connection_check_runs
  DROP CONSTRAINT IF EXISTS space_setup_connection_check_runs_connection_ids_check,
  DROP CONSTRAINT IF EXISTS space_setup_connection_check_runs_total_count_check,
  DROP CONSTRAINT IF EXISTS space_setup_connection_check_runs_completed_count_check;

ALTER TABLE space_setup_connection_check_runs
  ADD CONSTRAINT space_setup_connection_check_runs_connection_ids_check
    CHECK (cardinality(connection_ids) BETWEEN 1 AND 64),
  ADD CONSTRAINT space_setup_connection_check_runs_total_count_check
    CHECK (total_count BETWEEN 1 AND 64),
  ADD CONSTRAINT space_setup_connection_check_runs_completed_count_check
    CHECK (completed_count BETWEEN 0 AND 64);
