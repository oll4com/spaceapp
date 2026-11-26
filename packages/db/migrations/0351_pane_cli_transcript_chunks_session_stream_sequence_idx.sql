-- Speed Phase 2 Slice 7 (21/11): CLI task history's first-stdin / latest-output lookups filter one session's chunks by stream and take the
-- first or last sequence; with only (session_id, sequence) Postgres walks every stdout chunk of a session to find its first stdin row.
-- One ascending index serves both directions (btree scans backwards). (session_id, sequence) is unique, so no created_at tiebreak is needed.
CREATE INDEX IF NOT EXISTS idx_pane_cli_transcript_chunks_session_stream_sequence
  ON pane_cli_transcript_chunks (session_id, stream, sequence);
