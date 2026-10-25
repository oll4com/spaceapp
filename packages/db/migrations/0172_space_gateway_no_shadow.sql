-- Operator decision 2026-10-13: Shadow (measure compression without sending it) is no longer a setting; it confused
-- users. Each setting keeps what Shadow did: the global mode and per-key overrides become OFF (Shadow never changed
-- a request) and Code and prose becomes ON (it applies only while compression is ON). The compression rollups and
-- signals keep their SHADOW history rows.
UPDATE space_gateway_settings SET compression_mode = 'OFF' WHERE compression_mode = 'SHADOW';
UPDATE space_gateway_settings SET compression_code_text = 'ON' WHERE compression_code_text = 'SHADOW';
UPDATE space_gateway_api_keys SET compression_override = 'OFF' WHERE compression_override = 'SHADOW';

ALTER TABLE space_gateway_settings DROP CONSTRAINT IF EXISTS space_gateway_settings_compression_mode_check;
ALTER TABLE space_gateway_settings
  ADD CONSTRAINT space_gateway_settings_compression_mode_check CHECK (compression_mode IN ('OFF', 'ON'));
ALTER TABLE space_gateway_settings DROP CONSTRAINT IF EXISTS space_gateway_settings_compression_code_text_check;
ALTER TABLE space_gateway_settings
  ADD CONSTRAINT space_gateway_settings_compression_code_text_check CHECK (compression_code_text IN ('OFF', 'ON'));
ALTER TABLE space_gateway_settings ALTER COLUMN compression_code_text SET DEFAULT 'ON';
ALTER TABLE space_gateway_api_keys DROP CONSTRAINT IF EXISTS space_gateway_api_keys_compression_override_check;
ALTER TABLE space_gateway_api_keys
  ADD CONSTRAINT space_gateway_api_keys_compression_override_check
  CHECK (compression_override IS NULL OR compression_override IN ('OFF', 'ON'));
