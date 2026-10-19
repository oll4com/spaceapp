import { randomUUID } from "node:crypto";
import { nousAttachmentSchema, type NousAttachment, type NousAttachmentKind } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Files the operator sends Nous with a message (migration 0214, plan clipboard:hQg9iKGYDqx7). The API's Nous attachments
// module is the only writer; every read and write is scoped to the owner. Postgres on the live instances, in-memory for tests.

/** What the server keeps about a file beyond what the dock shows. */
export interface NousAttachmentMeta {
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  /** Extracted text of a document (a file under the artifact root) and how much of the document it covers. */
  textPath?: string | null;
  readable?: string | null;
}

export interface NousAttachmentRecord extends NousAttachment {
  ownerUserId: string;
  sha256: string;
  storagePath: string;
  meta: NousAttachmentMeta;
}

export interface NewNousAttachment {
  ownerUserId: string; kind: NousAttachmentKind; filename: string; mimeType: string; byteSize: number; sha256: string;
  storagePath: string; meta: NousAttachmentMeta;
}

export interface NousAttachmentRepository {
  /** A new id for a file about to be stored, so its path can carry the id. */
  newId(): string;
  add(input: NewNousAttachment & { id: string }): Promise<NousAttachmentRecord>;
  get(owner: string, id: string): Promise<NousAttachmentRecord | null>;
  /** The owner's files among `ids` that no message has yet, in the order asked. */
  listUnsent(owner: string, ids: string[]): Promise<NousAttachmentRecord[]>;
  /** Gives unsent files to a message; returns how many it took. */
  link(owner: string, messageId: string, ids: string[]): Promise<number>;
  listForMessages(owner: string, messageIds: string[]): Promise<NousAttachmentRecord[]>;
  /** Removes rows and returns them, so their files can be deleted too. */
  remove(owner: string, id: string): Promise<NousAttachmentRecord | null>;
  removeAll(owner: string): Promise<NousAttachmentRecord[]>;
  /** Unsent rows older than `unsentBefore` and every row older than `before`. */
  removeExpired(unsentBefore: string, before: string): Promise<NousAttachmentRecord[]>;
  dispose(): Promise<void>;
}

const newId = () => `nous_file:${randomUUID().replace(/-/g, "").slice(0, 24)}`;

function recordOf(row: {
  id: string; ownerUserId: string; messageId: string | null; kind: string; filename: string; mimeType: string; byteSize: number | string;
  sha256: string; storagePath: string; meta: unknown; createdAt: Date | string;
}): NousAttachmentRecord {
  const meta = (row.meta && typeof row.meta === "object" ? row.meta : {}) as NousAttachmentMeta;
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString();
  const shown = nousAttachmentSchema.parse({
    id: row.id, messageId: row.messageId, kind: row.kind, filename: row.filename, mimeType: row.mimeType, byteSize: Number(row.byteSize),
    width: meta.width ?? null, height: meta.height ?? null, durationSeconds: meta.durationSeconds ?? null, readable: meta.readable ?? null, createdAt
  });
  return { ...shown, ownerUserId: row.ownerUserId, sha256: row.sha256, storagePath: row.storagePath, meta };
}

export class InMemoryNousAttachmentRepository implements NousAttachmentRepository {
  private readonly rows = new Map<string, NousAttachmentRecord>();
  newId() { return newId(); }
  async add(input: NewNousAttachment & { id: string }) {
    const record = recordOf({ ...input, messageId: null, createdAt: new Date() });
    this.rows.set(record.id, record);
    return structuredClone(record);
  }
  async get(owner: string, id: string) {
    const row = this.rows.get(id);
    return row && row.ownerUserId === owner ? structuredClone(row) : null;
  }
  async listUnsent(owner: string, ids: string[]) {
    return ids.map((id) => this.rows.get(id)).filter((row): row is NousAttachmentRecord => Boolean(row && row.ownerUserId === owner && !row.messageId))
      .map((row) => structuredClone(row));
  }
  async link(owner: string, messageId: string, ids: string[]) {
    let linked = 0;
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row && row.ownerUserId === owner && !row.messageId) { row.messageId = messageId; linked += 1; }
    }
    return linked;
  }
  async listForMessages(owner: string, messageIds: string[]) {
    const wanted = new Set(messageIds);
    return [...this.rows.values()].filter((row) => row.ownerUserId === owner && row.messageId && wanted.has(row.messageId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((row) => structuredClone(row));
  }
  async remove(owner: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.ownerUserId !== owner) return null;
    this.rows.delete(id);
    return row;
  }
  async removeAll(owner: string) {
    const removed = [...this.rows.values()].filter((row) => row.ownerUserId === owner);
    for (const row of removed) this.rows.delete(row.id);
    return removed;
  }
  async removeExpired(unsentBefore: string, before: string) {
    const removed = [...this.rows.values()].filter((row) => row.createdAt < before || (!row.messageId && row.createdAt < unsentBefore));
    for (const row of removed) this.rows.delete(row.id);
    return removed;
  }
  async dispose() {}
}

const columns = `id, owner_user_id AS "ownerUserId", message_id AS "messageId", kind, filename, mime_type AS "mimeType", byte_size AS "byteSize",
  sha256, storage_path AS "storagePath", meta, created_at AS "createdAt"`;
type Row = Parameters<typeof recordOf>[0];

export class PostgresNousAttachmentRepository implements NousAttachmentRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousAttachmentRepository(createSpacePgPool(url, { max: 2 })); }
  newId() { return newId(); }
  async add(input: NewNousAttachment & { id: string }) {
    const result = await this.pool.query<Row>(`INSERT INTO nous_attachments (id, owner_user_id, kind, filename, mime_type, byte_size, sha256, storage_path, meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING ${columns}`,
    [input.id, input.ownerUserId, input.kind, input.filename, input.mimeType, input.byteSize, input.sha256, input.storagePath, JSON.stringify(input.meta)]);
    return recordOf(result.rows[0]!);
  }
  async get(owner: string, id: string) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM nous_attachments WHERE owner_user_id = $1 AND id = $2`, [owner, id]);
    return result.rows[0] ? recordOf(result.rows[0]) : null;
  }
  async listUnsent(owner: string, ids: string[]) {
    if (!ids.length) return [];
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM nous_attachments WHERE owner_user_id = $1 AND id = ANY($2::text[]) AND message_id IS NULL`, [owner, ids]);
    const byId = new Map(result.rows.map((row) => [row.id, recordOf(row)]));
    return ids.map((id) => byId.get(id)).filter((row): row is NousAttachmentRecord => Boolean(row));
  }
  async link(owner: string, messageId: string, ids: string[]) {
    if (!ids.length) return 0;
    const result = await this.pool.query(`UPDATE nous_attachments SET message_id = $2 WHERE owner_user_id = $1 AND id = ANY($3::text[]) AND message_id IS NULL`,
      [owner, messageId, ids]);
    return (result as { rowCount?: number | null }).rowCount ?? 0;
  }
  async listForMessages(owner: string, messageIds: string[]) {
    if (!messageIds.length) return [];
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM nous_attachments WHERE owner_user_id = $1 AND message_id = ANY($2::text[])
      ORDER BY created_at ASC, id ASC`, [owner, messageIds]);
    return result.rows.map(recordOf);
  }
  async remove(owner: string, id: string) {
    const result = await this.pool.query<Row>(`DELETE FROM nous_attachments WHERE owner_user_id = $1 AND id = $2 RETURNING ${columns}`, [owner, id]);
    return result.rows[0] ? recordOf(result.rows[0]) : null;
  }
  async removeAll(owner: string) {
    const result = await this.pool.query<Row>(`DELETE FROM nous_attachments WHERE owner_user_id = $1 RETURNING ${columns}`, [owner]);
    return result.rows.map(recordOf);
  }
  async removeExpired(unsentBefore: string, before: string) {
    const result = await this.pool.query<Row>(`DELETE FROM nous_attachments WHERE created_at < $2 OR (message_id IS NULL AND created_at < $1) RETURNING ${columns}`,
      [unsentBefore, before]);
    return result.rows.map(recordOf);
  }
  async dispose() { await (this.pool as { end?: () => Promise<void> }).end?.(); }
}
