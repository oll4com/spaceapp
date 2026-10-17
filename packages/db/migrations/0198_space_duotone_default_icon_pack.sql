-- Space Duotone becomes the default icon pack (operator decision 2026-10-14). Stored settings carry the old
-- default "lucide" for every account that ever saved a setting, so they move once; Lucide stays selectable.
UPDATE user_settings
SET settings = jsonb_set(settings, '{modernIconPack}', '"space"')
WHERE settings->>'modernIconPack' = 'lucide';
