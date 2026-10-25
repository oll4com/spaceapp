ALTER TABLE panes ADD COLUMN IF NOT EXISTS pane_name text;

WITH ranked AS (
  SELECT
    id,
    room_id,
    ROW_NUMBER() OVER (
      PARTITION BY room_id
      ORDER BY pane_order ASC, created_at ASC, id ASC
    ) AS rnk
  FROM panes
  WHERE is_closed = false AND pane_name IS NULL
),
names AS (
  SELECT unnest(ARRAY[
    'Andy', 'Bob', 'Cody', 'Dana', 'Emma', 'Finn', 'Hugo', 'Iris',
    'Jack', 'Kate', 'Leo', 'Max', 'Nik', 'Oscar', 'Paul', 'Zoe'
  ]) AS name,
  generate_subscripts(ARRAY[
    'Andy', 'Bob', 'Cody', 'Dana', 'Emma', 'Finn', 'Hugo', 'Iris',
    'Jack', 'Kate', 'Leo', 'Max', 'Nik', 'Oscar', 'Paul', 'Zoe'
  ], 1) AS idx
)
UPDATE panes p
SET pane_name = COALESCE(n.name, 'Pane ' || r.rnk)
FROM ranked r
LEFT JOIN names n ON n.idx = r.rnk
WHERE p.id = r.id;

CREATE UNIQUE INDEX IF NOT EXISTS panes_room_id_pane_name_open_idx
ON panes (room_id, pane_name)
WHERE is_closed = false AND pane_name IS NOT NULL;
