-- Space Dots Stage 8 follow-up: every model call of a proactive check (the Dot's own messages), with the usage the
-- model gateway reported and the cost estimate from the operator's price catalog (the Stage 7 measurement). These
-- calls have no Chat run, so the run ledger cannot hold them. Settings → Dots shows the totals. Additive.
CREATE TABLE IF NOT EXISTS dot_proactive_usage (
  usage_id text PRIMARY KEY CHECK (usage_id ~ '^dot_proactive_usage:[a-f0-9]{32}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dot_id text REFERENCES space_dots(dot_id) ON DELETE SET NULL,
  called_at timestamptz NOT NULL DEFAULT now(),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('COMPLETED','FAILED')),
  candidates integer NOT NULL CHECK (candidates >= 0),
  notices integer NOT NULL DEFAULT 0 CHECK (notices >= 0),
  -- The ledger's usage and cost shapes (agentRunUsageSchema, agentRunCostSchema).
  usage jsonb NOT NULL CHECK (jsonb_typeof(usage) = 'object' AND usage->>'status' IN ('MEASURED','UNKNOWN')),
  cost jsonb NOT NULL CHECK (jsonb_typeof(cost) = 'object' AND cost->>'status' IN ('ESTIMATED','ACTUAL','UNKNOWN'))
);
CREATE INDEX IF NOT EXISTS dot_proactive_usage_owner ON dot_proactive_usage(owner_user_id, called_at DESC);
