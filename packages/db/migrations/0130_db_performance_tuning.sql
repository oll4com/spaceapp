-- Hot-path indexing and autovacuum tuning for high-frequency update tables
-- and non-blocking data retention pruning.
--
-- space_control_records churns updates on a 330ms tick, and
-- pane_cli_terminal_control_leases updates leases on a 2s heartbeat.
-- Tuning autovacuum_vacuum_scale_factor to 0.05 (5%) triggers vacuuming
-- on dead tuples earlier to eliminate table bloat.
ALTER TABLE space_control_records SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE pane_cli_terminal_control_leases SET (autovacuum_vacuum_scale_factor = 0.05);

-- Index for non-blocking batch pruning of expired transcript chunks
-- from EXITED sessions older than retention cutoff (7 days).
CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_exited_updated_at
  ON pane_cli_sessions(updated_at DESC)
  WHERE status = 'EXITED';
