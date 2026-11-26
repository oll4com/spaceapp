-- Slice 15 (14/11, Daily Nous errors): turn facts kept only 3 failed-call texts per tool per turn, so a 4th repeat of a held cause (tool-holds.ts) had
-- no text and the score counted it as Nous's mistake (space_task_update ×6, space_files_read, space_programs). Every failed call now keeps its text;
-- this fills the older rows from the turn's own FAILED TOOL messages (the text the call returned, already stored in the same database), first line
-- as toolFailureCause takes it (a line opening a JSON list or object goes on, spaces collapsed), 200 characters. Calls Space's own database dropped
-- count as refused at call time (SPACE_DATABASE_DOWN, a statement timeout excepted) and carry no sample, so they stay out here too.
WITH failed AS (
  SELECT m.turn_id, m.owner_user_id, m.meta->>'name' AS name, m.created_at, m.id,
    ltrim(coalesce(m.meta->>'result', ''), E' \t\r\n') AS result, m.content
  FROM nous_messages m
  WHERE m.kind = 'TOOL' AND m.status = 'FAILED' AND m.turn_id IS NOT NULL AND m.meta ? 'name'
    AND NOT (coalesce(m.meta->>'result', '') ~* '(timeout exceeded when trying to connect|Connection terminated|ECONNREFUSED|database system is (starting up|shutting down|in recovery)|too many clients|statement timeout|\m(57P01|57P03|53300)\M)'
      AND coalesce(m.meta->>'result', '') !~* '(statement timeout|\m57014\M)')
), causes AS (
  SELECT turn_id, owner_user_id, name, created_at, id,
    coalesce(nullif(CASE WHEN btrim(split_part(result, E'\n', 1)) ~ '[[{]$' THEN btrim(regexp_replace(result, '\s+', ' ', 'g'))
      ELSE btrim(split_part(result, E'\n', 1)) END, ''), content) AS cause
  FROM failed
), samples AS (
  SELECT turn_id, owner_user_id, name,
    jsonb_agg(CASE WHEN char_length(cause) > 200 THEN left(cause, 199) || '…' ELSE cause END ORDER BY created_at, id) AS errors
  FROM causes GROUP BY turn_id, owner_user_id, name
), patch AS (
  SELECT f.turn_id, jsonb_object_agg(s.name, (f.tools->s.name) || jsonb_build_object('errors', s.errors)) AS tools
  FROM nous_turn_facts f
  JOIN samples s ON s.turn_id = f.turn_id AND s.owner_user_id = f.owner_user_id AND f.tools ? s.name
  WHERE jsonb_typeof(f.tools->s.name->'errors') = 'array'
    AND coalesce((f.tools->s.name->>'failed')::int, 0) - coalesce((f.tools->s.name->>'refused')::int, 0) > jsonb_array_length(f.tools->s.name->'errors')
    AND jsonb_array_length(s.errors) > jsonb_array_length(f.tools->s.name->'errors')
  GROUP BY f.turn_id
)
UPDATE nous_turn_facts f SET tools = f.tools || p.tools FROM patch p WHERE p.turn_id = f.turn_id;
