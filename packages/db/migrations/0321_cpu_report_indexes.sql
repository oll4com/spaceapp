-- CPU report 12/11 (plan clipboard:Yx4YemupYuwQ, step 3.1): indexes for the queries whose EXPLAIN scanned whole tables.
-- Plain CREATE INDEX, as the runner wraps each migration in a transaction (no CONCURRENTLY): each build holds writes to its table
-- for the seconds it takes, space_gateway_usage_history (~0.9M rows) the longest.

-- listOperatorMessages and listOperatorMessageRefs (read 31,895 rows for 500), listAnswerLinks (read all 176k rows).
CREATE INDEX IF NOT EXISTS nous_messages_operator_idx ON nous_messages (owner_user_id, created_at, id) WHERE kind = 'OPERATOR';
CREATE INDEX IF NOT EXISTS nous_messages_answer_idx ON nous_messages (owner_user_id, created_at, id) WHERE kind = 'ANSWER';

-- listTurnOutcomes (read 14,405 for 2,765). Not jsonb_array_length: on an outcomes value that is not an array it would fail the insert.
CREATE INDEX IF NOT EXISTS nous_turn_facts_outcomes_idx ON nous_turn_facts (owner_user_id, ended_at, turn_id) WHERE outcomes <> '[]'::jsonb;

-- Requests' done notifications (read 13,364 for 200) and unresolvedBySource (read 13,364 for 29).
CREATE INDEX IF NOT EXISTS space_notifications_owner_source_kind_idx ON space_notifications (owner_user_id, source, kind, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS space_notifications_unresolved_source_idx ON space_notifications (source, created_at DESC, id DESC)
  WHERE status IN ('OPEN', 'READ');

-- Moving a pane to another room and the panes foreign key's ON DELETE SET NULL (read all 17,037 artifacts to change none).
CREATE INDEX IF NOT EXISTS idx_artifacts_pane ON artifacts (pane_id);

-- weeklyPeaks (read ~0.9M rows, its sort spilled 24.6 MB to disk): an index-only range scan of the weekly samples.
CREATE INDEX IF NOT EXISTS space_gateway_usage_history_secondary_reset_idx ON space_gateway_usage_history (reset_at)
  INCLUDE (account_id, quota_key, used_percent, recorded_at) WHERE usage_window = 'SECONDARY' AND reset_at IS NOT NULL;

-- The audit page (read and sorted all 255k rows for 25).
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events (created_at DESC, id DESC);

-- Job Copilot's events by type: pending questions and reviews, mails (read all 31,061 rows for 685 and 2,311).
CREATE INDEX IF NOT EXISTS job_apply_events_owner_type_idx ON job_apply_events (owner_user_id, type, created_at DESC, id DESC);
