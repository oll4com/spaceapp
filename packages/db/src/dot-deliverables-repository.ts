import { randomUUID } from "node:crypto";
import { dotDeliverableSchema, type DotDeliverable } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** Published versions of a Dot's deliverables (Space Dots Stage 5). Versions are immutable. */
export interface DotDeliverablesRepository {
  latest(dotId: string, name: string): Promise<DotDeliverable | null>;
  /** The version already published with this workspace content, if any. */
  bySource(dotId: string, name: string, sourceSha256: string): Promise<DotDeliverable | null>;
  /** Adds the next version of `name`; concurrent publishers get consecutive versions; identical content returns the existing version. */
  addVersion(input: Omit<DotDeliverable, "deliverableId" | "version" | "createdAt" | "artifactId"> & { artifactId: string; ownerUserId: string }): Promise<DotDeliverable>;
  list(owner: string, dotId: string, limit: number): Promise<DotDeliverable[]>;
  dispose(): Promise<void>;
}
const columns = `deliverable_id AS "deliverableId", dot_id AS "dotId", room_id AS "roomId", name, version, artifact_id AS "artifactId", sha256,
  source_sha256 AS "sourceSha256",
  byte_size AS "byteSize", mime_type AS "mimeType", published_by AS "publishedBy", created_at AS "createdAt"`;
function deliverable(row: Record<string, unknown>): DotDeliverable {
  return dotDeliverableSchema.parse({ ...row, byteSize: Number(row.byteSize), createdAt: new Date(row.createdAt as string).toISOString() });
}
export class PostgresDotDeliverablesRepository implements DotDeliverablesRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresDotDeliverablesRepository(createSpacePgPool(url, { max: 2 })); }
  async latest(dotId: string, name: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${columns} FROM dot_deliverables WHERE dot_id=$1 AND name=$2
      ORDER BY version DESC LIMIT 1`, [dotId, name])).rows[0];
    return row ? deliverable(row) : null;
  }
  async bySource(dotId: string, name: string, sourceSha256: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${columns} FROM dot_deliverables WHERE dot_id=$1 AND name=$2 AND source_sha256=$3
      AND artifact_id IS NOT NULL AND EXISTS (SELECT 1 FROM artifacts a WHERE a.id=dot_deliverables.artifact_id AND a.deleted_at IS NULL)`,
      [dotId, name, sourceSha256])).rows[0];
    return row ? deliverable(row) : null;
  }
  async addVersion(input: Parameters<DotDeliverablesRepository["addVersion"]>[0]) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = `dot_deliverable:${randomUUID().replace(/-/g, "")}`;
      const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO dot_deliverables(deliverable_id,dot_id,owner_user_id,room_id,name,version,
        artifact_id,sha256,source_sha256,byte_size,mime_type,published_by)
        SELECT $1,$2,$3,$4,$5,COALESCE(MAX(version),0)+1,$6,$7,$8,$9,$10,$11 FROM dot_deliverables WHERE dot_id=$2 AND name=$5
        ON CONFLICT DO NOTHING RETURNING ${columns}`, [id, input.dotId, input.ownerUserId, input.roomId, input.name,
        input.artifactId, input.sha256, input.sourceSha256, input.byteSize, input.mimeType, input.publishedBy])).rows[0];
      if (row) return deliverable(row);
      // Identical content published concurrently: return that version instead of a duplicate.
      const existing = await this.bySource(input.dotId, input.name, input.sourceSha256);
      if (existing) return existing;
    }
    throw new Error("The deliverable version could not be recorded.");
  }
  async list(owner: string, dotId: string, limit: number) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${columns} FROM dot_deliverables d WHERE owner_user_id=$1 AND dot_id=$2
      AND d.artifact_id IS NOT NULL AND EXISTS (SELECT 1 FROM artifacts a WHERE a.id=d.artifact_id AND a.deleted_at IS NULL)
      ORDER BY name, version DESC LIMIT $3`, [owner, dotId, Math.min(500, Math.max(1, limit))])).rows.map(deliverable);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
