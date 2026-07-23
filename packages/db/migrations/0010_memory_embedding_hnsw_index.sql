CREATE INDEX IF NOT EXISTS idx_memory_records_embedding_hnsw
  ON memory_records USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
