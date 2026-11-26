-- Speed audit 21/11: nous_world, boardSnapshot and inbox.tick query unresolved non-INFO notifications
-- while thousands of MAIL_RECEIVED INFO rows remain OPEN/READ.
CREATE INDEX IF NOT EXISTS space_notifications_owner_waiting_above_info_idx
  ON space_notifications (owner_user_id, created_at DESC, id DESC)
  WHERE status IN ('OPEN', 'READ') AND severity <> 'INFO';
