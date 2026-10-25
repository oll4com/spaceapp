-- Second step of the codex-lb retirement (2026-10-13): the Space Gateway provider (id codex-lb, kept for existing
-- references) gets the SPACE_GATEWAY type. Builds since migration 0170 accept both types.
UPDATE providers
   SET provider_type = 'SPACE_GATEWAY', updated_at = now()
 WHERE id = 'codex-lb' AND provider_type = 'CODEX_LB';
