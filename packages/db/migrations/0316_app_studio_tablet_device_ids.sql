-- Galaxy Tab S10 FE+ (operator nous_msg:5b21060a, 9/11): device ids take 3-4 digit sizes like the contract
-- (appStudioDeviceIdSchema), so android-900x1440 and android-1440x900 previews no longer fail the 0236 3-digit CHECK.
ALTER TABLE app_studio_previews DROP CONSTRAINT IF EXISTS app_studio_previews_device_id_check;
ALTER TABLE app_studio_previews ADD CONSTRAINT app_studio_previews_device_id_check
  CHECK (device_id ~ '^(android|iphone)-[0-9]{3,4}x[0-9]{3,4}$');
