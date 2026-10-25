-- Space Gateway output policy (PLAN clipboard:1QB_tqacF15X, B2) and the defaults measured in Phase A (2026-10-13,
-- 21 paired tasks per provider, quality unchanged): LEAN cut Claude Code cost 15% and Antigravity 17%; nothing helped
-- Codex. Gateway compression (Headroom) raised cost on Claude (+30%) and Antigravity (+16%) and is turned off for them;
-- Codex keeps the global mode. Only an untouched per-provider object is filled, so an operator's choice is kept.
ALTER TABLE space_gateway_api_keys
  ADD COLUMN IF NOT EXISTS output_policy_override text;
ALTER TABLE space_gateway_api_keys DROP CONSTRAINT IF EXISTS space_gateway_api_keys_output_policy_override_check;
ALTER TABLE space_gateway_api_keys
  ADD CONSTRAINT space_gateway_api_keys_output_policy_override_check
  CHECK (output_policy_override IS NULL OR output_policy_override IN ('OFF', 'CONCISE', 'LEAN', 'BOTH'));

UPDATE space_gateway_settings
  SET compression_providers = '{"CLAUDE":{"mode":"OFF","outputPolicy":"LEAN"},"ANTIGRAVITY":{"mode":"OFF","outputPolicy":"LEAN"},"CODEX":{"outputPolicy":"OFF"}}'::jsonb,
      updated_at = now()
  WHERE compression_providers = '{}'::jsonb;
