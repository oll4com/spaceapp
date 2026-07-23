CREATE TABLE IF NOT EXISTS codex_cli_mode_defaults (
  id text PRIMARY KEY CHECK (id = 'global'),
  build_model_id text NOT NULL,
  build_reasoning_effort text NOT NULL,
  plan_model_id text NOT NULL,
  plan_reasoning_effort text NOT NULL,
  runtime_initialized boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT codex_cli_mode_defaults_build_model_check
    CHECK (char_length(build_model_id) BETWEEN 1 AND 160 AND build_model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CONSTRAINT codex_cli_mode_defaults_plan_model_check
    CHECK (char_length(plan_model_id) BETWEEN 1 AND 160 AND plan_model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CONSTRAINT codex_cli_mode_defaults_build_effort_check
    CHECK (char_length(build_reasoning_effort) BETWEEN 1 AND 80 AND build_reasoning_effort ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  CONSTRAINT codex_cli_mode_defaults_plan_effort_check
    CHECK (char_length(plan_reasoning_effort) BETWEEN 1 AND 80 AND plan_reasoning_effort ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$')
);

INSERT INTO codex_cli_mode_defaults (
  id,
  build_model_id,
  build_reasoning_effort,
  plan_model_id,
  plan_reasoning_effort,
  runtime_initialized,
  updated_at
)
VALUES ('global', 'gpt-5.6-sol', 'xhigh', 'gpt-5.6-sol', 'xhigh', false, now())
ON CONFLICT (id) DO NOTHING;
