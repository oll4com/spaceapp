-- The free key pools' model checks (operator 5/11 17:22 BKK: "every NVIDIA model that does not answer removed automatically"): the last
-- answer of each catalog model to a request or to the daily probe. A model that answered 410 (end of life) or 404 (not served to the key)
-- is dead: hidden from /models and from auto until it answers 200 again. A 429 or a timeout never changes `dead`.
CREATE TABLE IF NOT EXISTS space_gateway_model_checks (
  provider text NOT NULL,
  model text NOT NULL,
  dead boolean NOT NULL,
  -- The last HTTP status (0: no answer) and the provider's message when dead.
  status integer NOT NULL,
  reason text,
  dead_since timestamptz,
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (provider, model)
);
