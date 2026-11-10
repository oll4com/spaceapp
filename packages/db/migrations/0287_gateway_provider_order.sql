-- The provider order Nous's "Space" provider tries (operator 3/11 15:03 BKK, plan clipboard:52W5YTibb65k): Claude, Codex, Claude via
-- OpenCode (the Claude API-key account, never Claude Code), Antigravity; the pay-per-token pools follow, off until the operator turns them on.
ALTER TABLE space_gateway_settings
  ADD COLUMN IF NOT EXISTS provider_order jsonb NOT NULL DEFAULT '[{"route":"CLAUDE","enabled":true},{"route":"CODEX","enabled":true},{"route":"CLAUDE_OPENCODE","enabled":true},{"route":"ANTIGRAVITY","enabled":true},{"route":"OPENAI_API","enabled":false},{"route":"OPENROUTER","enabled":false},{"route":"DEEPSEEK","enabled":false}]'::jsonb;
