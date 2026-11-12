-- Operator 12/11: panes Nous opened are blue (room-pane-commands.ts colors new ones). The open ones it opened before, found by its
-- "nous:" request ids in room_pane_commands, turn blue too; a color the operator already chose stays.
UPDATE panes SET category_color = 'blue', updated_at = now()
WHERE is_closed = false
  AND category_color IS NULL
  AND id IN (
    SELECT opened->>'id'
    FROM room_pane_commands, jsonb_array_elements(result) AS opened
    WHERE request_id LIKE 'nous:%'
  );
