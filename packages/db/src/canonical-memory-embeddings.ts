import pg from "pg";
import type { PgPoolLike } from "./space-store.js";

export interface CanonicalEmbeddingRow { id: string; inputHash: string }
export class CanonicalMemoryEmbeddings {
  constructor(private readonly pool: Pick<PgPoolLike, "query">, private readonly closePool?: () => Promise<void>) {}
  static fromConnectionString(connectionString: string) {
    const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    return new CanonicalMemoryEmbeddings(pool, () => pool.end());
  }
  async list(provider: string, model: string): Promise<CanonicalEmbeddingRow[]> {
    const result = await this.pool.query<CanonicalEmbeddingRow>(
      'SELECT canonical_memory_id AS id, input_hash AS "inputHash" FROM memory_graph_embeddings WHERE provider=$1 AND model=$2', [provider, model]);
    return result.rows;
  }
  async upsert(input: { id: string; hash: string; provider: string; model: string; embedding: number[] }) {
    if (input.embedding.length !== 1536 || !input.embedding.every(Number.isFinite)) throw new Error("Invalid canonical embedding dimensions.");
    await this.pool.query(`INSERT INTO memory_graph_embeddings
      (canonical_memory_id,content_hash,input_hash,provider,model,embedding)
      VALUES ($1,$2,$2,$3,$4,$5::vector)
      ON CONFLICT(canonical_memory_id) DO UPDATE SET content_hash=excluded.content_hash,
      input_hash=excluded.input_hash,provider=excluded.provider,model=excluded.model,
      embedding=excluded.embedding,updated_at=now()`,
      [input.id,input.hash,input.provider,input.model,JSON.stringify(input.embedding)]);
  }
  async search(embedding: number[], provider: string, model: string, allowedIds?: string[]): Promise<Array<CanonicalEmbeddingRow & { similarity: number }>> {
    if (embedding.length !== 1536 || !embedding.every(Number.isFinite)) throw new Error("Invalid canonical query embedding.");
    const result = await this.pool.query<CanonicalEmbeddingRow & { similarity: number }>(`SELECT canonical_memory_id AS id,
      input_hash AS "inputHash", 1-(embedding <=> $1::vector) AS similarity
      FROM memory_graph_embeddings WHERE provider=$2 AND model=$3 AND ($4::text[] IS NULL OR canonical_memory_id=ANY($4::text[]))
      ORDER BY embedding <=> $1::vector LIMIT 100`, [JSON.stringify(embedding), provider, model, allowedIds ?? null]);
    return result.rows;
  }
  async close() { await this.closePool?.(); }
}
