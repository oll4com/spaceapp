-- Goal 84ba917a, plan clipboard:ro5ukMcJnIk4 step 6: lessons written before created_at (0294) get their creation date, so a rewrite never counts
-- again in the Score's daily errors (5/11: 278 of 289 lessons had none; 103 without incidents counted on every rewrite, ~-515 points).
-- The date in the key (lessons-MMDD-..., 2026), else the earliest incident line, else 2026-10-28 (they predate the column, before the 7-day
-- window of 5/11); never after the note's own update. Only created_at changes; the text is never touched.
UPDATE nous_notes SET created_at = LEAST(updated_at, COALESCE(
  CASE WHEN key ~ '^lessons-(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])-'
    THEN (make_date(2026, substring(key from 9 for 2)::int, 1) + (substring(key from 11 for 2)::int - 1))::timestamp AT TIME ZONE 'UTC' END,
  (SELECT CASE WHEN length(min(m[1])) = 10 THEN (min(m[1]) || 'T00:00:00Z')::timestamptz ELSE min(m[1])::timestamptz END
     FROM regexp_matches(text, '^--- Incident \((?:merged from \S+, )?(\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z)?)', 'gn') AS m),
  TIMESTAMPTZ '2026-10-28 00:00:00+00'))
WHERE created_at IS NULL AND key ~ '^lessons(-|$)';
