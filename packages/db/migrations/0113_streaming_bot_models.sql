ALTER TABLE streaming_bot_settings ADD COLUMN IF NOT EXISTS model_selection jsonb;
ALTER TABLE streaming_bot_settings ADD COLUMN IF NOT EXISTS fallback_model_selection jsonb;
