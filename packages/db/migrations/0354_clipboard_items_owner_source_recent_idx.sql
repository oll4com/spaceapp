-- Speed audit 22/11: nous_board (plans step: 364-783 ms) and nous_world query clipboard_items filtered by
-- (owner_user_id, source = 'PLAN', ...) ordered by (last_used_at DESC, id DESC), previously scanning all
-- COPY/PASTE/NOTE rows through idx_clipboard_items_owner_recent.
CREATE INDEX IF NOT EXISTS idx_clipboard_items_owner_source_recent
  ON clipboard_items (owner_user_id, source, last_used_at DESC, id DESC);
