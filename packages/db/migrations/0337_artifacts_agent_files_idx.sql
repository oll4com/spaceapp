-- Speed audit 14/11: every open tab reads the whole Agent Files list once a minute (the terminal's file links: 15 pages, each a COUNT
-- and a page). Both statements scanned all of artifacts for the 1,497 Agent Files among its 22,124 rows: 10.5 ms and 1,767 pages each,
-- 20,048 statements and 200 s of Postgres since the statistics' reset. The predicate is artifactListWhere's AGENT_FILES clause word for
-- word: the planner matches a partial index by the clause itself. Plain CREATE INDEX (the runner's transaction): writes to the 17 MB
-- table wait well under a second.
CREATE INDEX IF NOT EXISTS idx_artifacts_agent_files ON artifacts (created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND storage_uri LIKE 'space-artifact://agent-files/%';
