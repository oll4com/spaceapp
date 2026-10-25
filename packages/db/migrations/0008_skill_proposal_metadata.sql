ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS body text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'STATIC';

CREATE INDEX IF NOT EXISTS idx_skills_source_updated_at ON skills(source, updated_at DESC);
