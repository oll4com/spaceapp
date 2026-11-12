-- Stable (public-host) filed broker-session clipboard rows under user:dev-operator until 12/11: its .env names no operator e-mail, so the
-- broker signed space@space.local, the dev login's row (operator 12/11 18:47 BKK: move them to the operator). Exactly these six rows,
-- checked by Nous; pre-change dump ~/agent-workspace/nous/clipboard-move-1112/pre-change-rows.json. A database without these rows or
-- without user:operator (dev, a fresh install) changes nothing. The operator's 9/11 order pauses every plan, so the open one pauses.
UPDATE clipboard_items
SET owner_user_id = 'user:operator',
    execution_status = CASE WHEN id = 'clipboard:plan-sensevoice-e00e2efe' THEN 'PAUSED' ELSE execution_status END
WHERE owner_user_id = 'user:dev-operator'
  AND id IN ('clipboard:plan-sensevoice-e00e2efe', 'clipboard:plan-custom-max-env-4b320b53', 'clipboard:plan_user_sync_user_dev-operator',
             'clipboard:e01d15ac1946', 'clipboard:mcp_live_audio_pg58jf', 'clipboard:DJkwzi2JeVwo')
  AND EXISTS (SELECT 1 FROM users WHERE id = 'user:operator')
  -- UNIQUE (owner_user_id, content_hash): a row whose content the operator already holds stays (the copy is there), never a failed deploy.
  AND NOT EXISTS (SELECT 1 FROM clipboard_items mine WHERE mine.owner_user_id = 'user:operator' AND mine.content_hash = clipboard_items.content_hash);
