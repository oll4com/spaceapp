-- Space Gateway: an account whose refresh token stopped working keeps serving with its current access token
-- until that expires, then waits for the operator to sign it in again (codex-lb REAUTH_REQUIRED).
ALTER TABLE space_gateway_accounts DROP CONSTRAINT IF EXISTS space_gateway_accounts_status_check;
ALTER TABLE space_gateway_accounts ADD CONSTRAINT space_gateway_accounts_status_check
  CHECK (status IN ('ACTIVE','RATE_LIMITED','QUOTA_EXCEEDED','PAUSED','REAUTH_REQUIRED','DEACTIVATED'));
