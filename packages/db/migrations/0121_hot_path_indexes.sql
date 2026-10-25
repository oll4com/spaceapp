-- Hot-path indexes for read patterns that previously fell back to sequential
-- scans or blocking sorts.
--
-- space_control_records.list() runs three times per second from the control
-- tick and sorts by updated_at, which no existing index covered.
CREATE INDEX IF NOT EXISTS space_control_records_kind_updated_at
  ON space_control_records(kind, updated_at DESC);

-- listActivePaneCliSessions()/listActivePaneCliSessionsForRuntimes() filter on
-- runtime_id with is_active and status, and are called for every runtime on the
-- system-analytics ingest tick.
CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_active_runtime
  ON pane_cli_sessions(runtime_id)
  WHERE is_active = true AND status = 'RUNNING';

-- listPaneCliSessions() orders by started_at DESC, session_id DESC for a pane,
-- which did not match the existing (pane_id, updated_at DESC) index.
CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_pane_started_at
  ON pane_cli_sessions(pane_id, started_at DESC, session_id DESC);

-- listModelEvents() filters on COALESCE(ended_at, started_at), so the existing
-- started_at index could not be used for the model analytics window query.
CREATE INDEX IF NOT EXISTS idx_system_analytics_model_events_coalesced_range
  ON system_analytics_model_events((COALESCE(ended_at, started_at)));
