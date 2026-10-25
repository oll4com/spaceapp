-- Marketing Copilot analytics: one value per owner, day, source and key (GitHub stars, npm downloads, ...).
CREATE TABLE IF NOT EXISTS marketing_copilot_metrics (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 40),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 80),
  value double precision NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, day, source, key)
);
