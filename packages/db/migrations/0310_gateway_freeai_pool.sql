-- Free.ai key pool in Space Gateway (Cleo's audit 7/11 for nous_msg:bb80f10b): free chat from a third party. Widens the two provider CHECKs of 0309.
ALTER TABLE space_gateway_accounts DROP CONSTRAINT IF EXISTS space_gateway_accounts_provider_check,
  ADD CONSTRAINT space_gateway_accounts_provider_check CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK',
    'OPENROUTER','GOOGLE_AI','KIMI','QWEN','GROQ','NVIDIA','CLOUDFLARE_AI','ADAPTION','AMD_TOKEN_LAB','INCEPTION','JINA','MIXEDBREAD','AGENTROUTER','FREEAI'));
ALTER TABLE space_gateway_sticky_bindings DROP CONSTRAINT IF EXISTS space_gateway_sticky_bindings_provider_check,
  ADD CONSTRAINT space_gateway_sticky_bindings_provider_check CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK',
    'OPENROUTER','GOOGLE_AI','KIMI','QWEN','GROQ','NVIDIA','CLOUDFLARE_AI','ADAPTION','AMD_TOKEN_LAB','INCEPTION','JINA','MIXEDBREAD','AGENTROUTER','FREEAI'));
