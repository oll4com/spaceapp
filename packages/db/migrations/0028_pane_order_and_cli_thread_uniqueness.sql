WITH ordered_open_panes AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY room_id
      ORDER BY pane_order ASC, created_at ASC, id ASC
    ) - 1 AS next_order
  FROM panes
  WHERE is_closed = false
)
UPDATE panes
SET
  pane_order = ordered_open_panes.next_order,
  updated_at = CASE
    WHEN panes.pane_order IS DISTINCT FROM ordered_open_panes.next_order THEN now()
    ELSE panes.updated_at
  END
FROM ordered_open_panes
WHERE panes.id = ordered_open_panes.id;

WITH ranked_active_claims AS (
  SELECT
    session_id,
    row_number() OVER (
      PARTITION BY codex_thread_id
      ORDER BY started_at ASC, updated_at ASC, session_id ASC
    ) AS claim_rank
  FROM pane_cli_sessions
  WHERE is_active = true
    AND codex_thread_id IS NOT NULL
)
UPDATE pane_cli_sessions
SET
  codex_thread_id = NULL,
  updated_at = now()
FROM ranked_active_claims
WHERE pane_cli_sessions.session_id = ranked_active_claims.session_id
  AND ranked_active_claims.claim_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pane_cli_sessions_one_active_codex_thread
  ON pane_cli_sessions(codex_thread_id)
  WHERE is_active = true
    AND codex_thread_id IS NOT NULL;
