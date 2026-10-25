-- codex-lb (public-host) and Headroom (public-host) were powered off on 2026-10-13 (operator approval): Codex runs through
-- Space Gateway. The global default provider moves to the Space Gateway provider (id codex-lb, whose base URL is
-- the gateway), and the three built-in codex-lb routes are disabled so nothing sends a request or a key to the
-- retired hosts. Rows are kept (disabled), not deleted.
UPDATE provider_settings
   SET default_provider_id = 'codex-lb', updated_at = now()
 WHERE default_provider_id IN ('headroom-gateway', 'direct-246-primary', 'direct-auto-failover')
   AND EXISTS (SELECT 1 FROM providers WHERE id = 'codex-lb');

UPDATE providers
   SET status = 'DISABLED',
       status_reason = 'Retired with codex-lb on 2026-10-13; Codex runs through Space Gateway.',
       updated_at = now()
 WHERE id IN ('headroom-gateway', 'direct-246-primary', 'direct-auto-failover')
   AND status <> 'DISABLED';
