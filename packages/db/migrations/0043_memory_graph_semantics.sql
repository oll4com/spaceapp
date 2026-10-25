CREATE TABLE IF NOT EXISTS memory_graph_embeddings (
  canonical_memory_id text PRIMARY KEY CHECK (char_length(canonical_memory_id) BETWEEN 8 AND 240),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  input_version smallint NOT NULL DEFAULT 1 CHECK (input_version = 1),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 80),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 240),
  dimensions smallint NOT NULL DEFAULT 1536 CHECK (dimensions = 1536),
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_memory_graph_embeddings_lookup
  ON memory_graph_embeddings(content_hash, input_hash, model);

CREATE INDEX IF NOT EXISTS idx_memory_graph_embeddings_hnsw
  ON memory_graph_embeddings USING hnsw (embedding vector_cosine_ops);
