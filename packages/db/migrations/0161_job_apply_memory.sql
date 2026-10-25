-- Job Copilot memory: per-owner facts, answers, site/company notes, lessons and preferences the
-- agent recalls before it asks. Dedicated to the copilot; never Dot memory or operator memory.
CREATE TABLE IF NOT EXISTS job_apply_memory (
  id text PRIMARY KEY CHECK (id ~ '^jobmem:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('FACT','ANSWER','SITE','COMPANY','LESSON','PREFERENCE')),
  key text CHECK (key IS NULL OR char_length(key) BETWEEN 1 AND 300),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  site text CHECK (site IS NULL OR site IN ('linkedin','greenhouse','ashby','lever','workday','indeed','other')),
  company text CHECK (company IS NULL OR char_length(company) BETWEEN 1 AND 200),
  tags text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(tags) <= 20),
  source text NOT NULL CHECK (source IN ('PROFILE','CV','USER','AGENT')),
  confidence real NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  pinned boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One answer per question per scope (site/company); free facts have no key.
  scope text GENERATED ALWAYS AS (coalesce(site, '') || '|' || coalesce(company, '')) STORED,
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(key, '') || ' ' || text || ' ' || coalesce(company, '') || ' ' || coalesce(site, ''))
  ) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS job_apply_memory_owner_key_scope_idx ON job_apply_memory(owner_user_id, kind, key, scope) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_apply_memory_owner_kind_idx ON job_apply_memory(owner_user_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS job_apply_memory_owner_site_idx ON job_apply_memory(owner_user_id, site) WHERE site IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_apply_memory_owner_company_idx ON job_apply_memory(owner_user_id, lower(company)) WHERE company IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_apply_memory_search_idx ON job_apply_memory USING GIN (search);
CREATE INDEX IF NOT EXISTS job_apply_memory_tags_idx ON job_apply_memory USING GIN (tags);
