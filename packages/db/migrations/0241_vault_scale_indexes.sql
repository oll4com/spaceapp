-- Operator request 2026-10-21 (no limits, indexes instead): a Vault of thousands of logins. A fill's same-login lookup reads
-- vault_items by login key, and the item list's use counts join only successful FILL audit events by item.
CREATE INDEX IF NOT EXISTS vault_items_login_key_idx ON vault_items (owner_user_id, login_key) WHERE login_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS vault_audit_item_fills_idx ON vault_audit (vault_id, (event->>'itemId'))
  WHERE event->>'action' = 'FILL' AND event->>'result' IN ('FILLED', 'SUBMITTED');
