-- Goal 7365014c-e (zero approvals by 30/11): the decision ledger. Every operator answer to a Nous decision or a needs-you card
-- appends a row with what Nous predicted (a decision's «Πρόβλεψη» line, a card's recommended option), the answer and whether they
-- matched, so the daily review and space_nous_decisions learn from every yes and no after the cards themselves are pruned. The
-- copilots' rail answers stay in their own event tables (counted by the review). Class B: rows older than 180 days are pruned.
CREATE TABLE IF NOT EXISTS nous_decision_ledger (
  id bigserial PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 60),
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 2000),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  predicted text CHECK (predicted IS NULL OR char_length(predicted) <= 200),
  answer text NOT NULL CHECK (char_length(answer) BETWEEN 1 AND 500),
  match boolean,
  ref text CHECK (ref IS NULL OR char_length(ref) <= 200)
);
CREATE INDEX IF NOT EXISTS nous_decision_ledger_owner_at_idx ON nous_decision_ledger (owner_user_id, at DESC);
