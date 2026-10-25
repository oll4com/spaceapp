-- Space Memory embeddings (plan clipboard:o7SATwaOHqca, 2026-10-18): the model that made each stored vector, so a model
-- switch (OpenAI text-embedding-3-small -> Gemini gemini-embedding-001, both 1536 dimensions) re-embeds every row instead of
-- comparing vectors of two models. Rows embedded before this column existed were made by the only model ever configured.
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE dot_memories ADD COLUMN IF NOT EXISTS embedding_model text;

-- A Dot memory's updated_at follows its text and source, not a re-embedding, so the backfill keeps the memory order.
CREATE OR REPLACE FUNCTION space_dot_memory_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.dot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM space_dots d WHERE d.dot_id=NEW.dot_id AND d.owner_user_id=NEW.owner_user_id) THEN
    RAISE EXCEPTION 'Dot memory does not match its owner' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.dot_id IS DISTINCT FROM OLD.dot_id
    OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.project_key IS DISTINCT FROM OLD.project_key) THEN
    RAISE EXCEPTION 'A Dot memory keeps its owner, Dot and scope; create a new one instead' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' OR NEW.text IS DISTINCT FROM OLD.text OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.source_ref IS DISTINCT FROM OLD.source_ref THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

UPDATE memory_records SET embedding_model = 'text-embedding-3-small' WHERE embedding IS NOT NULL AND embedding_model IS NULL;
UPDATE dot_memories SET embedding_model = 'text-embedding-3-small' WHERE embedding IS NOT NULL AND embedding_model IS NULL;
