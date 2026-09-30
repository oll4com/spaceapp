-- Expand streaming overlay tile limit from 12 to 64
ALTER TABLE streaming_overlay_settings DROP CONSTRAINT IF EXISTS streaming_overlay_settings_tiles_check;
ALTER TABLE streaming_overlay_settings ADD CONSTRAINT streaming_overlay_settings_tiles_check CHECK (jsonb_typeof(tiles) = 'array' AND jsonb_array_length(tiles) <= 64);
