-- Inception Labs, Jina AI, Mixedbread and AgentRouter key pools in Space Gateway (operator 7/11 10:53 BKK, nous_msg:c1272a0c): granted free tokens.
-- Widens the two provider CHECKs of 0307; the provider order needs nothing (gatewayProviderOrderOf adds the free route, on, when read).
ALTER TABLE space_gateway_accounts DROP CONSTRAINT IF EXISTS space_gateway_accounts_provider_check,
  ADD CONSTRAINT space_gateway_accounts_provider_check CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK',
    'OPENROUTER','GOOGLE_AI','KIMI','QWEN','GROQ','NVIDIA','CLOUDFLARE_AI','ADAPTION','AMD_TOKEN_LAB','INCEPTION','JINA','MIXEDBREAD','AGENTROUTER'));
ALTER TABLE space_gateway_sticky_bindings DROP CONSTRAINT IF EXISTS space_gateway_sticky_bindings_provider_check,
  ADD CONSTRAINT space_gateway_sticky_bindings_provider_check CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK',
    'OPENROUTER','GOOGLE_AI','KIMI','QWEN','GROQ','NVIDIA','CLOUDFLARE_AI','ADAPTION','AMD_TOKEN_LAB','INCEPTION','JINA','MIXEDBREAD','AGENTROUTER'));
