-- The retired codex-lb name must not show anywhere in Space (operator decision 2026-10-14). Ids such as the
-- Space Gateway provider's 'codex-lb' stay, because stored settings and sessions refer to them; only the text
-- people see changes.
UPDATE providers
   SET display_name = 'Space Gateway', updated_at = now()
 WHERE id = 'codex-lb' AND display_name ~* 'codex[- ]?lb';

UPDATE providers
   SET status_reason = 'Retired on 2026-10-13; Codex runs through Space Gateway.', updated_at = now()
 WHERE status_reason = 'Retired with codex-lb on 2026-10-13; Codex runs through Space Gateway.';

UPDATE providers
   SET display_name = regexp_replace(display_name, 'codex[- ]?lb', 'Codex', 'gi'), updated_at = now()
 WHERE display_name ~* 'codex[- ]?lb';

UPDATE providers
   SET status_reason = regexp_replace(status_reason, 'codex[- ]?lb', 'Space Gateway', 'gi'), updated_at = now()
 WHERE status_reason ~* 'codex[- ]?lb';

UPDATE models
   SET display_name = regexp_replace(display_name, 'codex[- ]?lb', 'Space Gateway', 'gi'), updated_at = now()
 WHERE display_name ~* 'codex[- ]?lb';
