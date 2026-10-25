-- Nous's pane board (operator request 2026-10-19, plan clipboard:Y9cgKVHFaHrr): one line per pane saying what it does and what
-- it waits on, written by a cheap Claude model only when the pane's data changed (fingerprint), or Space's own FALLBACK line.
-- The newest row per pane is the board's line; older rows are kept 14 days. Pane text in the input is untrusted data.
CREATE TABLE IF NOT EXISTS nous_pane_summaries (
  id bigserial PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL,
  room_id text NOT NULL,
  fingerprint text NOT NULL,
  line text NOT NULL,
  waits_on text NOT NULL CHECK (waits_on IN ('OPERATOR', 'DATE', 'PROMOTE', 'THIRD_PARTY', 'NOUS', 'NONE')),
  needs_operator boolean NOT NULL DEFAULT false,
  until timestamptz,
  detail text,
  model text,
  source text NOT NULL CHECK (source IN ('MODEL', 'FALLBACK')),
  -- One model call writes one batch; the daily cap counts batches.
  batch_id text,
  generated_at timestamptz NOT NULL,
  input_report_id text,
  tokens_in integer,
  tokens_out integer
);
CREATE INDEX IF NOT EXISTS nous_pane_summaries_pane ON nous_pane_summaries (owner_user_id, pane_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS nous_pane_summaries_batch ON nous_pane_summaries (owner_user_id, generated_at) WHERE batch_id IS NOT NULL;
