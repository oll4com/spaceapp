-- Z.AI, SiliconFlow and OVHcloud AI Endpoints pools in Space Gateway (7/11, nous_msg:c1272a0c): free sign-ups. Widens the two provider CHECKs of 0311.
ALTER TABLE space_gateway_accounts DROP CONSTRAINT IF EXISTS space_gateway_accounts_provider_check,
  ADD CONSTRAINT space_gateway_accounts_provider_check CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK',
    'OPENROUTER','GOOGLE_AI','KIMI','QWEN','GROQ','NVIDIA','CLOUDFLARE_AI','ADAPTION','AMD_TOKEN_LAB','INCEPTION','JINA','MIXEDBREAD','AGENTROUTER','FREEAI','AZURE_OPENAI','ZAI','SILICONFLOW','OVH'));
ALTER TABLE space_gateway_sticky_bindings DROP CONSTRAINT IF EXISTS space_gateway_sticky_bindings_provider_check,
  ADD CONSTRAINT space_gateway_sticky_bindings_provider_check CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK',
    'OPENROUTER','GOOGLE_AI','KIMI','QWEN','GROQ','NVIDIA','CLOUDFLARE_AI','ADAPTION','AMD_TOKEN_LAB','INCEPTION','JINA','MIXEDBREAD','AGENTROUTER','FREEAI','AZURE_OPENAI','ZAI','SILICONFLOW','OVH'));
