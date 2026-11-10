import { randomUUID } from "node:crypto";
import { signatureFieldsSchema, signaturePlacementsSchema, type SavedSignature, type SignatureField, type SignaturePlacement, type SignatureRequest } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// The owner's saved signatures (migration 0302: many, one default), the phone (0297) and the signature requests (class A; plan clipboard:2qSLIT_csvPm).
export interface SignaturesRepository {
  /** The owner's saved signatures, oldest first, without their PNGs. */
  listSignatures(owner: string): Promise<SavedSignature[]>;
  /** One saved signature with its PNG: by id, else the default (the oldest when none is marked). */
  getSignature(owner: string, id?: string): Promise<(SavedSignature & { png: Buffer }) | null>;
  /** A new saved signature; the owner's first, or one asked as the default, becomes the default. */
  addSignature(owner: string, png: Buffer, size: { width: number; height: number }, input: { label: string; isDefault?: boolean | undefined }, at?: string): Promise<SavedSignature>;
  updateSignature(owner: string, id: string, patch: { label?: string | undefined; isDefault?: true | undefined; artifactId?: string | null }, at?: string): Promise<SavedSignature | null>;
  /** The owner's explicit delete; when it was the default, the oldest left becomes the default. Answers the deleted one. */
  deleteSignature(owner: string, id: string): Promise<SavedSignature | null>;
  getPhone(owner: string): Promise<string | null>;
  setPhone(owner: string, phone: string | null, at?: string): Promise<void>;
  /** Test requests (App Studio, Agent Proof rooms) only with `tests`. */
  listRequests(owner: string, status?: SignatureRequest["status"], tests?: boolean): Promise<SignatureRequest[]>;
  getRequest(owner: string, id: string): Promise<SignatureRequest | null>;
  createRequest(owner: string, input: { artifactId: string; title: string; note?: string | null | undefined; placements: SignaturePlacement[]; fields?: SignatureField[] | undefined;
    roomId: string | null; paneId: string | null; test?: boolean }, at?: string): Promise<SignatureRequest>;
  /** Moves a PENDING request on; null when it is not PENDING any more (signed or cancelled meanwhile). */
  finishRequest(owner: string, id: string, patch: { status: "SIGNED"; signedArtifactId: string } | { status: "CANCELLED" }, at?: string): Promise<SignatureRequest | null>;
  dispose(): Promise<void>;
}

const newId = (prefix = "sigreq") => `${prefix}:${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const oldest = (a: SavedSignature, b: SavedSignature) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const newest = (a: SignatureRequest, b: SignatureRequest) => b.createdAt.localeCompare(a.createdAt);

function fresh(owner: string, input: Parameters<SignaturesRepository["createRequest"]>[1], at: string): SignatureRequest {
  return { id: newId(), ownerUserId: owner, artifactId: input.artifactId, title: input.title, note: input.note ?? null,
    placements: signaturePlacementsSchema.parse(input.placements), fields: signatureFieldsSchema.parse(input.fields ?? []), roomId: input.roomId, paneId: input.paneId, status: "PENDING", test: input.test ?? false,
    signedArtifactId: null, signedAt: null, createdAt: at, updatedAt: at };
}

export class InMemorySignaturesRepository implements SignaturesRepository {
  /** A saved signature beside its owner and PNG, so the row itself is what the interface answers. */
  private signatures = new Map<string, { owner: string; png: Buffer; row: SavedSignature }>();
  private phones = new Map<string, string | null>();
  async getPhone(owner: string) { return this.phones.get(owner) ?? null; }
  async setPhone(owner: string, phone: string | null) { this.phones.set(owner, phone); }
  private requests = new Map<string, SignatureRequest>();
  private own(owner: string) { return [...this.signatures.values()].filter((entry) => entry.owner === owner).sort((a, b) => oldest(a.row, b.row)); }
  async listSignatures(owner: string) { return this.own(owner).map((entry) => ({ ...entry.row })); }
  async getSignature(owner: string, id?: string) {
    const entries = this.own(owner);
    const entry = id ? entries.find((item) => item.row.id === id) : entries.find((item) => item.row.isDefault) ?? entries[0];
    return entry ? { ...entry.row, png: Buffer.from(entry.png) } : null;
  }
  async addSignature(owner: string, png: Buffer, size: { width: number; height: number }, input: { label: string; isDefault?: boolean | undefined }, at = new Date().toISOString()) {
    const first = !this.own(owner).some((entry) => entry.row.isDefault);
    if (input.isDefault) for (const entry of this.own(owner)) entry.row.isDefault = false;
    const row: SavedSignature = { id: newId("sig"), label: input.label, width: size.width, height: size.height, isDefault: first || Boolean(input.isDefault), artifactId: null, createdAt: at, updatedAt: at };
    this.signatures.set(row.id, { owner, png: Buffer.from(png), row });
    return { ...row };
  }
  async updateSignature(owner: string, id: string, patch: { label?: string | undefined; isDefault?: true | undefined; artifactId?: string | null }, at = new Date().toISOString()) {
    const entry = this.signatures.get(id);
    if (entry?.owner !== owner) return null;
    if (patch.isDefault) for (const other of this.own(owner)) other.row.isDefault = other.row.id === id;
    if (patch.label !== undefined) entry.row.label = patch.label;
    if (patch.artifactId !== undefined) entry.row.artifactId = patch.artifactId;
    entry.row.updatedAt = at;
    return { ...entry.row };
  }
  async deleteSignature(owner: string, id: string) {
    const entry = this.signatures.get(id);
    if (entry?.owner !== owner) return null;
    this.signatures.delete(id);
    const next = this.own(owner)[0];
    if (entry.row.isDefault && next) next.row.isDefault = true;
    return { ...entry.row };
  }
  async listRequests(owner: string, status?: SignatureRequest["status"], tests = false) {
    return structuredClone([...this.requests.values()].filter((row) => row.ownerUserId === owner && (!status || row.status === status) && (tests || !row.test)).sort(newest));
  }
  async getRequest(owner: string, id: string) { const row = this.requests.get(id); return row?.ownerUserId === owner ? structuredClone(row) : null; }
  async createRequest(owner: string, input: Parameters<SignaturesRepository["createRequest"]>[1], at = new Date().toISOString()) {
    const row = fresh(owner, input, at); this.requests.set(row.id, row); return structuredClone(row);
  }
  async finishRequest(owner: string, id: string, patch: Parameters<SignaturesRepository["finishRequest"]>[2], at = new Date().toISOString()) {
    const row = this.requests.get(id);
    if (row?.ownerUserId !== owner || row.status !== "PENDING") return null;
    Object.assign(row, { status: patch.status, updatedAt: at, ...(patch.status === "SIGNED" ? { signedArtifactId: patch.signedArtifactId, signedAt: at } : {}) });
    return structuredClone(row);
  }
  async dispose() {}
}

interface RequestRow { id: string; owner_user_id: string; artifact_id: string; title: string; note: string | null; placements: SignaturePlacement[]; fields: SignatureField[] | null; room_id: string | null;
  pane_id: string | null; status: SignatureRequest["status"]; test: boolean; signed_artifact_id: string | null; signed_at: Date | string | null; created_at: Date | string; updated_at: Date | string }
const COLUMNS = "id, owner_user_id, artifact_id, title, note, placements, fields, room_id, pane_id, status, test, signed_artifact_id, signed_at, created_at, updated_at";
const iso = (value: Date | string) => new Date(value).toISOString();
const fromRow = (row: RequestRow): SignatureRequest => ({ id: row.id, ownerUserId: row.owner_user_id, artifactId: row.artifact_id, title: row.title, note: row.note,
  placements: row.placements, fields: row.fields ?? [], roomId: row.room_id, paneId: row.pane_id, status: row.status, test: row.test, signedArtifactId: row.signed_artifact_id,
  signedAt: row.signed_at ? iso(row.signed_at) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

interface SignatureRow { id: string; label: string; width: number; height: number; is_default: boolean; artifact_id: string | null; created_at: Date | string; updated_at: Date | string }
const SIGNATURE_COLUMNS = "id, label, width, height, is_default, artifact_id, created_at, updated_at";
const fromSignatureRow = (row: SignatureRow): SavedSignature => ({ id: row.id, label: row.label, width: row.width, height: row.height, isDefault: row.is_default,
  artifactId: row.artifact_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

export class PostgresSignaturesRepository implements SignaturesRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresSignaturesRepository(createSpacePgPool(url, { max: 2 })); }
  async listSignatures(owner: string) {
    return (await this.pool.query<SignatureRow>(`SELECT ${SIGNATURE_COLUMNS} FROM saved_signatures WHERE owner_user_id = $1 ORDER BY created_at, id`, [owner])).rows.map(fromSignatureRow);
  }
  async getSignature(owner: string, id?: string) {
    const row = (await this.pool.query<SignatureRow & { png: Buffer }>(`SELECT ${SIGNATURE_COLUMNS}, png FROM saved_signatures WHERE owner_user_id = $1 AND ($2::text IS NULL OR id = $2)
      ORDER BY is_default DESC, created_at, id LIMIT 1`, [owner, id ?? null])).rows[0];
    return row ? { ...fromSignatureRow(row), png: row.png } : null;
  }
  async addSignature(owner: string, png: Buffer, size: { width: number; height: number }, input: { label: string; isDefault?: boolean | undefined }, at = new Date().toISOString()) {
    if (input.isDefault) await this.pool.query("UPDATE saved_signatures SET is_default = false, updated_at = $2 WHERE owner_user_id = $1 AND is_default", [owner, at]);
    const row = (await this.pool.query<SignatureRow>(`INSERT INTO saved_signatures (id, owner_user_id, label, png, width, height, is_default, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOT EXISTS (SELECT 1 FROM saved_signatures WHERE owner_user_id = $2 AND is_default), $7, $7) RETURNING ${SIGNATURE_COLUMNS}`,
    [newId("sig"), owner, input.label, png, size.width, size.height, at])).rows[0]!;
    return fromSignatureRow(row);
  }
  async updateSignature(owner: string, id: string, patch: { label?: string | undefined; isDefault?: true | undefined; artifactId?: string | null }, at = new Date().toISOString()) {
    // Two statements: the one-default index is checked row by row, so the old default goes first.
    if (patch.isDefault) await this.pool.query("UPDATE saved_signatures SET is_default = false, updated_at = $3 WHERE owner_user_id = $1 AND is_default AND id <> $2", [owner, id, at]);
    const row = (await this.pool.query<SignatureRow>(`UPDATE saved_signatures SET label = COALESCE($3, label), is_default = is_default OR $4, artifact_id = CASE WHEN $5 THEN $6 ELSE artifact_id END,
      updated_at = $7 WHERE owner_user_id = $1 AND id = $2 RETURNING ${SIGNATURE_COLUMNS}`,
    [owner, id, patch.label ?? null, Boolean(patch.isDefault), patch.artifactId !== undefined, patch.artifactId ?? null, at])).rows[0];
    return row ? fromSignatureRow(row) : null;
  }
  async deleteSignature(owner: string, id: string) {
    const row = (await this.pool.query<SignatureRow>(`DELETE FROM saved_signatures WHERE owner_user_id = $1 AND id = $2 RETURNING ${SIGNATURE_COLUMNS}`, [owner, id])).rows[0];
    if (row?.is_default) {
      await this.pool.query(`UPDATE saved_signatures SET is_default = true WHERE id = (SELECT id FROM saved_signatures WHERE owner_user_id = $1 ORDER BY created_at, id LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM saved_signatures WHERE owner_user_id = $1 AND is_default)`, [owner]);
    }
    return row ? fromSignatureRow(row) : null;
  }
  async getPhone(owner: string) {
    return (await this.pool.query<{ phone: string | null }>("SELECT phone FROM owner_signatures WHERE owner_user_id = $1", [owner])).rows[0]?.phone ?? null;
  }
  async setPhone(owner: string, phone: string | null, at = new Date().toISOString()) {
    await this.pool.query(`INSERT INTO owner_signatures (owner_user_id, phone, updated_at) VALUES ($1, $2, $3)
      ON CONFLICT (owner_user_id) DO UPDATE SET phone = EXCLUDED.phone`, [owner, phone, at]);
  }
  async listRequests(owner: string, status?: SignatureRequest["status"], tests = false) {
    return (await this.pool.query<RequestRow>(`SELECT ${COLUMNS} FROM signature_requests WHERE owner_user_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::boolean OR NOT test)
      ORDER BY created_at DESC`, [owner, status ?? null, tests])).rows.map(fromRow);
  }
  async getRequest(owner: string, id: string) {
    const row = (await this.pool.query<RequestRow>(`SELECT ${COLUMNS} FROM signature_requests WHERE owner_user_id = $1 AND id = $2`, [owner, id])).rows[0];
    return row ? fromRow(row) : null;
  }
  async createRequest(owner: string, input: Parameters<SignaturesRepository["createRequest"]>[1], at = new Date().toISOString()) {
    const row = fresh(owner, input, at);
    await this.pool.query(`INSERT INTO signature_requests (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [row.id, row.ownerUserId, row.artifactId, row.title, row.note, JSON.stringify(row.placements), JSON.stringify(row.fields), row.roomId, row.paneId, row.status, row.test, null, null, row.createdAt, row.updatedAt]);
    return row;
  }
  async finishRequest(owner: string, id: string, patch: Parameters<SignaturesRepository["finishRequest"]>[2], at = new Date().toISOString()) {
    const row = (await this.pool.query<RequestRow>(`UPDATE signature_requests SET status = $3, signed_artifact_id = $4, signed_at = $5, updated_at = $6
      WHERE owner_user_id = $1 AND id = $2 AND status = 'PENDING' RETURNING ${COLUMNS}`,
    [owner, id, patch.status, patch.status === "SIGNED" ? patch.signedArtifactId : null, patch.status === "SIGNED" ? at : null, at])).rows[0];
    return row ? fromRow(row) : null;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
