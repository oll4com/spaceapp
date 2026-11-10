-- Free OpenAI-compatible key pools in Space Gateway (operator 5/11 14:34 BKK): NVIDIA, Groq, Cloudflare Workers AI.
-- Widens the two provider CHECKs of 0153 and puts the free routes, on, right after the operator's four in the provider order's default
-- (stored rows get them the same way when read: gatewayProviderOrderOf in packages/contracts/src/gateway.ts).
ALTER TABLE space_gateway_accounts DROP CONSTRAINT IF EXISTS space_gateway_accounts_provider_check,
  ADD CONSTRAINT space_gateway_accounts_provider_check CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK',
    'OPENROUTER','GOOGLE_AI','KIMI','QWEN','GROQ','NVIDIA','CLOUDFLARE_AI'));
ALTER TABLE space_gateway_sticky_bindings DROP CONSTRAINT IF EXISTS space_gateway_sticky_bindings_provider_check,
  ADD CONSTRAINT space_gateway_sticky_bindings_provider_check CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK',
    'OPENROUTER','GOOGLE_AI','KIMI','QWEN','GROQ','NVIDIA','CLOUDFLARE_AI'));
ALTER TABLE space_gateway_settings ALTER COLUMN provider_order SET DEFAULT '[{"route":"CLAUDE","enabled":true},{"route":"CODEX","enabled":true},{"route":"CLAUDE_OPENCODE","enabled":true},{"route":"ANTIGRAVITY","enabled":true},{"route":"NVIDIA","enabled":true},{"route":"GROQ","enabled":true},{"route":"CLOUDFLARE_AI","enabled":true},{"route":"OPENAI_API","enabled":false},{"route":"OPENROUTER","enabled":false},{"route":"DEEPSEEK","enabled":false}]'::jsonb;
