-- Additive: legacy assignments and runtime configuration remain available for rollback.
CREATE TABLE IF NOT EXISTS tool_routing_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
