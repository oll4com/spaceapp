CREATE TABLE IF NOT EXISTS cli_tasks (
  task_id text PRIMARY KEY,
  current_revision_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cli_task_revisions (
  revision_id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES cli_tasks(task_id) ON DELETE CASCADE,
  runtime_id text NOT NULL,
  provider_id text NOT NULL,
  agent_id text NOT NULL,
  native_task_ref text,
  source_revision_id text REFERENCES cli_task_revisions(revision_id) ON DELETE SET NULL,
  latest_space_session_id text REFERENCES pane_cli_sessions(session_id) ON DELETE SET NULL,
  display_title text NOT NULL,
  first_user_message text NOT NULL DEFAULT '',
  preview text NOT NULL DEFAULT '',
  cwd text,
  model_id text,
  reasoning_effort text NOT NULL CHECK (
    length(reasoning_effort) BETWEEN 1 AND 80
    AND reasoning_effort ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cli_task_revisions_native_ref_check CHECK (
    native_task_ref IS NULL
    OR (
      length(native_task_ref) BETWEEN 1 AND 256
      AND native_task_ref !~ '[[:space:][:cntrl:]]'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cli_task_revisions_runtime_native_ref
  ON cli_task_revisions(runtime_id, native_task_ref)
  WHERE native_task_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cli_task_revisions_task_updated_at
  ON cli_task_revisions(task_id, updated_at DESC, revision_id DESC);

ALTER TABLE pane_cli_sessions
  ADD COLUMN IF NOT EXISTS cli_task_id text;

ALTER TABLE pane_cli_sessions
  ADD COLUMN IF NOT EXISTS cli_task_revision_id text;

ALTER TABLE pane_cli_sessions
  DROP CONSTRAINT IF EXISTS pane_cli_sessions_cli_task_id_fkey;

ALTER TABLE pane_cli_sessions
  ADD CONSTRAINT pane_cli_sessions_cli_task_id_fkey
  FOREIGN KEY (cli_task_id) REFERENCES cli_tasks(task_id) ON DELETE SET NULL;

ALTER TABLE pane_cli_sessions
  DROP CONSTRAINT IF EXISTS pane_cli_sessions_cli_task_revision_id_fkey;

ALTER TABLE pane_cli_sessions
  ADD CONSTRAINT pane_cli_sessions_cli_task_revision_id_fkey
  FOREIGN KEY (cli_task_revision_id) REFERENCES cli_task_revisions(revision_id) ON DELETE SET NULL;

CREATE TEMPORARY TABLE cli_task_backfill_edges (
  left_session_id text NOT NULL,
  right_session_id text NOT NULL,
  PRIMARY KEY (left_session_id, right_session_id)
) ON COMMIT DROP;

INSERT INTO cli_task_backfill_edges (left_session_id, right_session_id)
SELECT DISTINCT
  least(session_id, first_value(session_id) OVER (PARTITION BY codex_thread_id ORDER BY started_at, session_id)),
  greatest(session_id, first_value(session_id) OVER (PARTITION BY codex_thread_id ORDER BY started_at, session_id))
FROM pane_cli_sessions
WHERE purpose = 'NORMAL'
  AND codex_thread_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO cli_task_backfill_edges (left_session_id, right_session_id)
SELECT DISTINCT
  least(source_session.session_id, target_session.session_id),
  greatest(source_session.session_id, target_session.session_id)
FROM audit_events audit
JOIN pane_cli_sessions target_session
  ON target_session.session_id = audit.metadata->>'sessionId'
 AND target_session.purpose = 'NORMAL'
JOIN pane_cli_sessions source_session
  ON source_session.purpose = 'NORMAL'
 AND (
   source_session.session_id = audit.metadata->>'sourceTaskId'
   OR source_session.codex_thread_id = audit.metadata->>'sourceTaskId'
 )
WHERE audit.action = 'pane.cli.resume'
  AND audit.metadata ? 'sourceTaskId'
  AND source_session.session_id <> target_session.session_id
ON CONFLICT DO NOTHING;

INSERT INTO cli_task_backfill_edges (left_session_id, right_session_id)
SELECT DISTINCT
  least(source_session.session_id, target_session.session_id),
  greatest(source_session.session_id, target_session.session_id)
FROM audit_events audit
JOIN pane_cli_sessions target_session
  ON target_session.session_id = audit.metadata->>'sessionId'
 AND target_session.purpose = 'NORMAL'
JOIN pane_cli_sessions source_session
  ON source_session.codex_thread_id = audit.metadata->>'codexThreadId'
 AND source_session.purpose = 'NORMAL'
WHERE audit.action = 'pane.cli.resume'
  AND audit.metadata ? 'codexThreadId'
  AND source_session.session_id <> target_session.session_id
ON CONFLICT DO NOTHING;

CREATE TEMPORARY TABLE cli_task_backfill_map (
  session_id text PRIMARY KEY,
  task_id text NOT NULL
) ON COMMIT DROP;

WITH RECURSIVE connected(session_id, member_id) AS (
  SELECT session_id, session_id
  FROM pane_cli_sessions
  WHERE purpose = 'NORMAL'
  UNION
  SELECT
    connected.session_id,
    CASE
      WHEN edge.left_session_id = connected.member_id THEN edge.right_session_id
      ELSE edge.left_session_id
    END
  FROM connected
  JOIN cli_task_backfill_edges edge
    ON edge.left_session_id = connected.member_id
    OR edge.right_session_id = connected.member_id
)
INSERT INTO cli_task_backfill_map (session_id, task_id)
SELECT session_id, min(member_id)
FROM connected
GROUP BY session_id;

INSERT INTO cli_tasks (task_id, current_revision_id, created_at, updated_at)
SELECT
  mapping.task_id,
  NULL,
  min(session.started_at),
  max(session.updated_at)
FROM cli_task_backfill_map mapping
JOIN pane_cli_sessions session ON session.session_id = mapping.session_id
GROUP BY mapping.task_id
ON CONFLICT (task_id) DO NOTHING;

WITH revision_rows AS (
  SELECT
    session.session_id AS revision_id,
    mapping.task_id,
    session.runtime_id,
    session.provider_id,
    session.agent_id,
    CASE
      WHEN session.codex_thread_id IS NOT NULL
       AND row_number() OVER (
         PARTITION BY session.runtime_id, session.codex_thread_id
         ORDER BY session.updated_at DESC, session.started_at DESC, session.session_id DESC
       ) = 1
      THEN session.codex_thread_id
      ELSE NULL
    END AS native_task_ref,
    source_revision.source_session_id AS source_revision_id,
    session.session_id AS latest_space_session_id,
    coalesce(nullif(trim(pane.title), ''), 'Space CLI task') AS display_title,
    coalesce(first_input.content, '') AS first_user_message,
    coalesce(latest_output.content, first_input.content, '') AS preview,
    session.cwd,
    session.model_id,
    session.reasoning_effort,
    session.started_at AS created_at,
    session.updated_at
  FROM cli_task_backfill_map mapping
  JOIN pane_cli_sessions session ON session.session_id = mapping.session_id
  JOIN panes pane ON pane.id = session.pane_id
  LEFT JOIN LATERAL (
    SELECT content
    FROM pane_cli_transcript_chunks
    WHERE session_id = session.session_id
      AND stream = 'stdin'
      AND length(trim(content)) > 0
    ORDER BY sequence ASC, created_at ASC
    LIMIT 1
  ) first_input ON true
  LEFT JOIN LATERAL (
    SELECT content
    FROM pane_cli_transcript_chunks
    WHERE session_id = session.session_id
      AND stream IN ('stdout', 'stderr')
      AND length(trim(content)) > 0
    ORDER BY sequence DESC, created_at DESC
    LIMIT 1
  ) latest_output ON true
  LEFT JOIN LATERAL (
    SELECT source_session.session_id AS source_session_id
    FROM audit_events audit
    JOIN pane_cli_sessions source_session
      ON source_session.session_id = audit.metadata->>'sourceTaskId'
      OR source_session.codex_thread_id = audit.metadata->>'codexThreadId'
    JOIN cli_task_backfill_map source_mapping ON source_mapping.session_id = source_session.session_id
    WHERE audit.action = 'pane.cli.resume'
      AND audit.metadata->>'sessionId' = session.session_id
      AND source_mapping.task_id = mapping.task_id
    ORDER BY audit.created_at DESC, audit.id DESC
    LIMIT 1
  ) source_revision ON true
)
INSERT INTO cli_task_revisions (
  revision_id,
  task_id,
  runtime_id,
  provider_id,
  agent_id,
  native_task_ref,
  source_revision_id,
  latest_space_session_id,
  display_title,
  first_user_message,
  preview,
  cwd,
  model_id,
  reasoning_effort,
  created_at,
  updated_at
)
SELECT
  revision_id,
  task_id,
  runtime_id,
  provider_id,
  agent_id,
  native_task_ref,
  source_revision_id,
  latest_space_session_id,
  display_title,
  first_user_message,
  preview,
  cwd,
  model_id,
  reasoning_effort,
  created_at,
  updated_at
FROM revision_rows
ON CONFLICT (revision_id) DO NOTHING;

UPDATE pane_cli_sessions session
SET
  cli_task_id = mapping.task_id,
  cli_task_revision_id = session.session_id
FROM cli_task_backfill_map mapping
WHERE mapping.session_id = session.session_id;

WITH current_revisions AS (
  SELECT DISTINCT ON (revision.task_id)
    revision.task_id,
    revision.revision_id,
    revision.updated_at
  FROM cli_task_revisions revision
  ORDER BY revision.task_id, revision.updated_at DESC, revision.created_at DESC, revision.revision_id DESC
)
UPDATE cli_tasks task
SET
  current_revision_id = current.revision_id,
  updated_at = greatest(task.updated_at, current.updated_at)
FROM current_revisions current
WHERE current.task_id = task.task_id;

ALTER TABLE cli_tasks
  DROP CONSTRAINT IF EXISTS cli_tasks_current_revision_id_fkey;

ALTER TABLE cli_tasks
  ADD CONSTRAINT cli_tasks_current_revision_id_fkey
  FOREIGN KEY (current_revision_id) REFERENCES cli_task_revisions(revision_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_cli_task
  ON pane_cli_sessions(cli_task_id, updated_at DESC)
  WHERE cli_task_id IS NOT NULL;
