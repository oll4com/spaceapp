-- AMD Token Lab key pool in Space Gateway (free-tokens brief 6/11, plan clipboard:ZXXTJ1o3kIoJ): granted points, no card on file.
-- Widens the two provider CHECKs of 0305; the provider order needs nothing (gatewayProviderOrderOf adds the free route, on, when read).
ALTER TABLE space_gateway_accounts DROP CONSTRAINT IF EXISTS space_gateway_accounts_provider_check,
  ADD CONSTRAINT space_gateway_accounts_provider_check CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK',
    'OPENROUTER','GOOGLE_AI','KIMI','QWEN','GROQ','NVIDIA','CLOUDFLARE_AI','ADAPTION','AMD_TOKEN_LAB'));
ALTER TABLE space_gateway_sticky_bindings DROP CONSTRAINT IF EXISTS space_gateway_sticky_bindings_provider_check,
  ADD CONSTRAINT space_gateway_sticky_bindings_provider_check CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK',
    'OPENROUTER','GOOGLE_AI','KIMI','QWEN','GROQ','NVIDIA','CLOUDFLARE_AI','ADAPTION','AMD_TOKEN_LAB'));
