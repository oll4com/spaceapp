import { randomUUID } from "node:crypto";
import { dotMemorySchema, type DotMemory, type DotMemoryScope } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/**
 * Dot memories (Space Dots Stage 5). A Dot sees its own DOT memories, its
 * PROJECT memories for the current project, and SHARED memories. Deletion
 * removes the row, including its embedding.
 */
export interface DotMemoryRepository {
  create(input: { ownerUserId: string; dotId: string | null; scope: DotMemoryScope; projectKey: string | null; text: string;
    source: "USER" | "DOT"; sourceRef: string | null; embedding: number[] | null }): Promise<DotMemory>;
  /** Memories this Dot can see, newest first; `projectKey` limits PROJECT memories to one project. */
  list(owner: string, dotId: string, filter: { scope?: DotMemoryScope; projectKey?: string | null; q?: string; limit: number }): Promise<DotMemory[]>;
  get(owner: string, dotId: string, memoryId: string): Promise<DotMemory | null>;
  /** Replaces the text; the source records who changed it last. */
  update(owner: string, dotId: string, memoryId: string, text: string, embedding: number[] | null, editor?: { source: "USER" | "DOT"; sourceRef: string | null }): Promise<DotMemory | null>;
  /** Real deletion; true when a visible memory was removed. */
  delete(owner: string, dotId: string, memoryId: string): Promise<boolean>;
  /** Most relevant memories for a query: by embedding when both sides have one of the same size, else by text. */
  recall(owner: string, dotId: string, projectKey: string | null, query: { text: string; embedding: number[] | null }, limit: number): Promise<DotMemory[]>;
  dispose(): Promise<void>;
}
const columns = `memory_id AS "memoryId", dot_id AS "dotId", scope, project_key AS "projectKey", text, source, source_ref AS "sourceRef",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
/** Rows visible to a Dot ($1 owner, $2 Dot). PROJECT rows of other projects stay hidden unless a project filter allows them. */
const visible = `owner_user_id=$1 AND (dot_id=$2 OR scope='SHARED')`;
function memory(row: Record<string, unknown>): DotMemory {
  return dotMemorySchema.parse({ ...row, createdAt: new Date(row.createdAt as string).toISOString(), updatedAt: new Date(row.updatedAt as string).toISOString() });
}
/** Re-embedding a Dot's memories with another model (Space Memory backfill); the in-API fakes need not implement it. */
export interface DotMemoryEmbeddings {
  /** Memories to (re-)embed for `model`: those without a vector first, then the newest. */
  listToEmbed(model: string, limit: number): Promise<Array<{ memoryId: string; text: string }>>;
  setEmbedding(memoryId: string, embedding: number[], model: string): Promise<void>;
  countEmbeddings(): Promise<{ total: number; withoutEmbedding: number; byModel: Array<{ model: string; count: number }> }>;
}
const vector = (values: number[] | null) => values && values.length && values.every(Number.isFinite) ? `[${values.join(",")}]` : null;

export class PostgresDotMemoryRepository implements DotMemoryRepository, DotMemoryEmbeddings {
  /** `embeddingModel`: the model of the vectors this repository is given; recall compares only vectors of that model. */
  constructor(private pool: PgPoolLike, private readonly embeddingModel: string | null = null) {}
  static fromConnectionString(url: string, embeddingModel: string | null = null) {
    return new PostgresDotMemoryRepository(createSpacePgPool(url, { max: 2 }), embeddingModel);
  }
  private async rows(sql: string, params: unknown[]) { return (await this.pool.query<Record<string, unknown>>(sql, params)).rows.map(memory); }
  async create(input: Parameters<DotMemoryRepository["create"]>[0]) {
    const memoryId = `dot_memory:${randomUUID().replace(/-/g, "")}`;
    const embedding = vector(input.embedding);
    return (await this.rows(`INSERT INTO dot_memories(memory_id,owner_user_id,dot_id,scope,project_key,text,source,source_ref,embedding,embedding_model)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10) RETURNING ${columns}`, [memoryId, input.ownerUserId, input.dotId, input.scope, input.projectKey,
      input.text, input.source, input.sourceRef, embedding, embedding ? this.embeddingModel : null]))[0]!;
  }
  async list(owner: string, dotId: string, filter: Parameters<DotMemoryRepository["list"]>[2]) {
    const terms = (filter.q ?? "").split(/\s+/).filter(Boolean).slice(0, 8);
    return this.rows(`SELECT ${columns} FROM dot_memories WHERE ${visible}
      AND ($3::text IS NULL OR scope=$3) AND ($4::text IS NULL OR scope<>'PROJECT' OR project_key=$4)
      AND (cardinality($5::text[])=0 OR (SELECT bool_and(text ILIKE '%' || replace(replace(term,'%','\\%'),'_','\\_') || '%') FROM unnest($5::text[]) term))
      ORDER BY updated_at DESC, memory_id LIMIT $6`, [owner, dotId, filter.scope ?? null, filter.projectKey ?? null, terms, Math.min(200, Math.max(1, filter.limit))]);
  }
  async get(owner: string, dotId: string, memoryId: string) {
    return (await this.rows(`SELECT ${columns} FROM dot_memories WHERE ${visible} AND memory_id=$3`, [owner, dotId, memoryId]))[0] ?? null;
  }
  async update(owner: string, dotId: string, memoryId: string, text: string, embedding: number[] | null, editor?: { source: "USER" | "DOT"; sourceRef: string | null }) {
    return (await this.rows(`UPDATE dot_memories SET text=$4, embedding=$5::vector, embedding_model=CASE WHEN $5::vector IS NULL THEN NULL ELSE $8 END,
      source=COALESCE($6, source), source_ref=CASE WHEN $6::text IS NULL THEN source_ref ELSE $7 END
      WHERE ${visible} AND memory_id=$3 RETURNING ${columns}`,
      [owner, dotId, memoryId, text, vector(embedding), editor?.source ?? null, editor?.sourceRef ?? null, this.embeddingModel]))[0] ?? null;
  }
  async delete(owner: string, dotId: string, memoryId: string) {
    return (await this.pool.query(`DELETE FROM dot_memories WHERE ${visible} AND memory_id=$3 RETURNING memory_id`, [owner, dotId, memoryId])).rows.length === 1;
  }
  async recall(owner: string, dotId: string, projectKey: string | null, query: { text: string; embedding: number[] | null }, limit: number) {
    const scoped = `${visible} AND (scope<>'PROJECT' OR project_key=$3)`;
    const bounded = Math.min(50, Math.max(1, limit));
    const embedding = vector(query.embedding);
    const semantic = embedding ? await this.rows(`SELECT ${columns} FROM dot_memories WHERE ${scoped}
      AND embedding IS NOT NULL AND vector_dims(embedding)=$5 AND ($7::text IS NULL OR embedding_model=$7) ORDER BY embedding <=> $4::vector LIMIT $6`,
      [owner, dotId, projectKey, embedding, query.embedding!.length, bounded, this.embeddingModel]) : [];
    if (semantic.length >= bounded) return semantic;
    // Text matches fill the rest, so memories without an embedding are still found.
    const terms = query.text.split(/\s+/).filter((term) => term.length > 1).slice(0, 8);
    const lexical = await this.rows(`SELECT ${columns} FROM dot_memories WHERE ${scoped}
      AND (cardinality($4::text[])=0 OR (SELECT bool_or(text ILIKE '%' || replace(replace(term,'%','\\%'),'_','\\_') || '%') FROM unnest($4::text[]) term))
      ORDER BY updated_at DESC, memory_id LIMIT $5`, [owner, dotId, projectKey, terms, bounded]);
    const seen = new Set(semantic.map((item) => item.memoryId));
    return [...semantic, ...lexical.filter((item) => !seen.has(item.memoryId))].slice(0, bounded);
  }
  async listToEmbed(model: string, limit: number) {
    const result = await this.pool.query<{ memoryId: string; text: string }>(`SELECT memory_id AS "memoryId", text FROM dot_memories
      WHERE embedding_model IS DISTINCT FROM $1 ORDER BY (embedding IS NULL) DESC, updated_at DESC, memory_id LIMIT $2`, [model, Math.min(500, Math.max(1, limit))]);
    return result.rows;
  }
  async setEmbedding(memoryId: string, embedding: number[], model: string) {
    const literal = vector(embedding);
    if (!literal) throw new Error("A Dot memory embedding must be a finite vector.");
    await this.pool.query("UPDATE dot_memories SET embedding=$2::vector, embedding_model=$3 WHERE memory_id=$1", [memoryId, literal, model]);
  }
  async countEmbeddings() {
    const totals = await this.pool.query<{ total: string; withoutEmbedding: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE embedding IS NULL) AS "withoutEmbedding" FROM dot_memories`);
    const models = await this.pool.query<{ model: string; count: string }>(
      `SELECT coalesce(embedding_model, 'unknown') AS model, count(*) AS count FROM dot_memories WHERE embedding IS NOT NULL GROUP BY 1 ORDER BY 1`);
    return { total: Number(totals.rows[0]?.total ?? 0), withoutEmbedding: Number(totals.rows[0]?.withoutEmbedding ?? 0),
      byModel: models.rows.map((row) => ({ model: row.model, count: Number(row.count) })) };
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
