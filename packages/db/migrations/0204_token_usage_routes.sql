-- Token usage page (operator request 2026-10-15): every token once, Claude included, per account, through Space
-- Gateway or direct, with its API value. Only adds: stored events keep their values and keep counting as before.
ALTER TABLE system_analytics_model_events DROP CONSTRAINT IF EXISTS system_analytics_model_events_source_check;
ALTER TABLE system_analytics_model_events ADD CONSTRAINT system_analytics_model_events_source_check
  CHECK (source IN ('codex', 'opencode', 'session', 'claude', 'gateway'));

-- route: GATEWAY events from CLI transcripts are also in the gateway's logs, so only the gateway's copy counts.
-- NULL is an event stored before routes existed; it counts as before.
ALTER TABLE system_analytics_model_events
  ADD COLUMN IF NOT EXISTS route text CHECK (route IS NULL OR route IN ('GATEWAY', 'DIRECT')),
  ADD COLUMN IF NOT EXISTS account_key text CHECK (account_key IS NULL OR char_length(account_key) BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS cost_usd double precision CHECK (cost_usd IS NULL OR cost_usd >= 0),
  ADD COLUMN IF NOT EXISTS tokens_cache_read bigint CHECK (tokens_cache_read IS NULL OR tokens_cache_read >= 0),
  ADD COLUMN IF NOT EXISTS tokens_cache_write bigint CHECK (tokens_cache_write IS NULL OR tokens_cache_write >= 0);

-- The Anthropic request id the Claude proxy passes back; Claude Code stores it as the message's requestId.
ALTER TABLE space_gateway_request_logs
  ADD COLUMN IF NOT EXISTS upstream_request_id text CHECK (upstream_request_id IS NULL OR char_length(upstream_request_id) <= 120);
CREATE INDEX IF NOT EXISTS space_gateway_request_logs_upstream_request_idx
  ON space_gateway_request_logs(upstream_request_id) WHERE upstream_request_id IS NOT NULL;
