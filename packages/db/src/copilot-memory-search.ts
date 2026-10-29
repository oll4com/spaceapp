import type { PgClientLike } from "./space-store.js";

/** The owner's copilot memories (and Live personal memory) Nous searches next to Space Memory: table, label and id column. */
export const COPILOT_MEMORY_SOURCES = [
  { table: "job_apply_memory", label: "Job Copilot memory" },
  { table: "freelance_copilot_memory", label: "Freelance Copilot memory" },
  { table: "marketing_copilot_memory", label: "Marketing Copilot memory" },
  { table: "mail_copilot_memory", label: "Mail Copilot memory" },
  { table: "security_copilot_memory", label: "Security Copilot memory" },
  { table: "monitoring_copilot_memory", label: "Monitoring Copilot memory" }
] as const;

export interface CopilotMemoryHit { source: string; id: string; key: string | null; text: string; updatedAt: string }

/** The query's words as ILIKE patterns (at most 8 words of 2+ characters; the split drops %, _ and \, so no wildcard comes from a query). */
export function copilotMemoryPatterns(query: string): string[] {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}@.+-]+/u).filter((word) => word.length >= 2))].slice(0, 8);
  return words.map((word) => `%${word}%`);
}

/**
 * Nous's recall beyond Space Memory (Ask Last step 6, 2026-10-27: Nous asked the operator for a postal code Job Copilot memory had
 * held since 13/10). Per table at most `perTable` of the owner's rows whose key or text holds one of the query's words, the rows
 * matching most words first, then the newest. Only id, key and text are read: no sealed or secret-named column.
 */
export async function searchCopilotMemories(client: PgClientLike, owner: string, query: string, perTable = 5): Promise<CopilotMemoryHit[]> {
  const patterns = copilotMemoryPatterns(query);
  if (!patterns.length) return [];
  const score = (expression: string) => `(SELECT count(*) FROM unnest($2::text[]) AS pattern WHERE ${expression} ILIKE pattern)`;
  const tables = COPILOT_MEMORY_SOURCES.map(({ table, label }, ord) => `(SELECT ${ord} AS ord, '${label}' AS source, id, key, text, to_json(updated_at)#>>'{}' AS updated_at,
      ${score("coalesce(key, '') || ' ' || text")} AS score FROM ${table}
    WHERE owner_user_id = $1 AND (coalesce(key, '') || ' ' || text) ILIKE ANY($2::text[]) ORDER BY score DESC, updated_at DESC LIMIT $3)`);
  const live = `(SELECT ${COPILOT_MEMORY_SOURCES.length} AS ord, 'Live personal memory' AS source, item->>'id' AS id, item->>'key' AS key, item->>'value' AS text, item->>'updatedAt' AS updated_at,
      ${score("(item->>'key') || ' ' || (item->>'value')")} AS score
    FROM live_personal_memory, jsonb_array_elements(CASE WHEN jsonb_typeof(value->'items') = 'array' THEN value->'items' ELSE '[]'::jsonb END) AS item
    WHERE owner_user_id = $1 AND ((item->>'key') || ' ' || (item->>'value')) ILIKE ANY($2::text[]) ORDER BY score DESC, updated_at DESC LIMIT $3)`;
  const result = await client.query<{ source: string; id: string; key: string | null; text: string; updated_at: string | null }>(
    `SELECT * FROM (${[...tables, live].join("\nUNION ALL\n")}) AS hits ORDER BY ord, score DESC, updated_at DESC`, [owner, patterns, perTable]);
  return result.rows.map((row) => ({ source: row.source, id: row.id, key: row.key, text: row.text, updatedAt: row.updated_at ?? "" }));
}
