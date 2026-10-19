import { randomBytes } from "node:crypto";
import type { DesignAsset, DesignBrandKit, DesignEvent, DesignRequest, DesignRequestStatus } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Design pane storage (migration 0230): the operator's brand kits, requests from other agents and panes (a queue a Design
// pane takes, works and delivers), the assets it made and its activity feed. Postgres live, in-memory for tests.

const newId = (prefix: string) => `${prefix}:${randomBytes(9).toString("base64url")}`;

export type DesignBrandKitCreateRecord = Omit<DesignBrandKit, "id" | "builtIn" | "createdAt" | "updatedAt"> & { ownerUserId: string };
export type DesignBrandKitPatch = Partial<Pick<DesignBrandKit, "name" | "colors" | "fonts" | "logos" | "voice">>;
export type DesignRequestCreateRecord = Omit<DesignRequest, "id" | "status" | "resultAssetIds" | "question" | "answer" | "message" | "takenAt" | "deliveredAt" | "createdAt" | "updatedAt">;
export type DesignRequestPatch = Partial<Pick<DesignRequest, "designPaneId" | "status" | "resultAssetIds" | "question" | "answer" | "message" | "takenAt" | "deliveredAt">>;
export interface DesignRequestFilter { status?: DesignRequestStatus[]; designPaneId?: string; requesterPaneId?: string; limit: number }
export type DesignAssetCreateRecord = Omit<DesignAsset, "id" | "createdAt" | "updatedAt">;
export type DesignAssetPatch = Partial<Pick<DesignAsset, "label" | "pinned" | "requestId">>;
export interface DesignAssetFilter { paneId?: string; requestId?: string; formatIds?: string[]; brandKitId?: string; ids?: string[]; limit: number }
export type DesignEventCreateRecord = Omit<DesignEvent, "id" | "createdAt">;
export interface DesignEventFilter { paneId?: string; requestId?: string; limit: number }

export interface DesignRepository {
  listBrandKits(owner: string): Promise<DesignBrandKit[]>;
  getBrandKit(owner: string, id: string): Promise<DesignBrandKit | null>;
  createBrandKit(input: DesignBrandKitCreateRecord): Promise<DesignBrandKit>;
  updateBrandKit(owner: string, id: string, patch: DesignBrandKitPatch): Promise<DesignBrandKit | null>;
  deleteBrandKit(owner: string, id: string): Promise<boolean>;
  createRequest(input: DesignRequestCreateRecord): Promise<DesignRequest>;
  getRequest(owner: string, id: string): Promise<DesignRequest | null>;
  /** Newest first. */
  listRequests(owner: string, filter: DesignRequestFilter): Promise<DesignRequest[]>;
  /** Updates a request; with `fromStatus` only while it is in one of those states (an atomic transition), else null. */
  updateRequest(owner: string, id: string, patch: DesignRequestPatch, fromStatus?: DesignRequestStatus[]): Promise<DesignRequest | null>;
  /**
   * Atomically takes the oldest QUEUED request routed to this pane or to no pane, or one TAKEN/IN_PROGRESS without an update
   * for `staleMs` (its pane stopped working on it), and marks it TAKEN by this pane.
   */
  takeNextRequest(owner: string, paneId: string, staleMs: number): Promise<DesignRequest | null>;
  createAsset(input: DesignAssetCreateRecord): Promise<DesignAsset>;
  getAsset(owner: string, id: string): Promise<DesignAsset | null>;
  /** Newest first. */
  listAssets(owner: string, filter: DesignAssetFilter): Promise<DesignAsset[]>;
  updateAsset(owner: string, id: string, patch: DesignAssetPatch): Promise<DesignAsset | null>;
  /** Deletes an asset and answers what it was (so the caller can unpin its artifact), or null. */
  deleteAsset(owner: string, id: string): Promise<DesignAsset | null>;
  createEvent(input: DesignEventCreateRecord): Promise<DesignEvent>;
  /** Newest first. */
  listEvents(owner: string, filter: DesignEventFilter): Promise<DesignEvent[]>;
  dispose(): Promise<void>;
}

const defined = <T extends object>(patch: T) => Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
const byNewest = <T extends { createdAt: string; id: string }>(left: T, right: T) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
const copy = <T>(row: T): T => structuredClone(row);

export class InMemoryDesignRepository implements DesignRepository {
  private kits = new Map<string, DesignBrandKit>();
  private requests = new Map<string, DesignRequest>();
  private assets = new Map<string, DesignAsset>();
  private events: DesignEvent[] = [];
  constructor(private now: () => string = () => new Date().toISOString()) {}
  private owned<T extends { ownerUserId: string | null }>(map: Map<string, T>, owner: string, id: string): T | null { const row = map.get(id); return row && row.ownerUserId === owner ? row : null; }

  async listBrandKits(owner: string) { return [...this.kits.values()].filter((row) => row.ownerUserId === owner).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(copy); }
  async getBrandKit(owner: string, id: string) { const row = this.owned(this.kits, owner, id); return row ? copy(row) : null; }
  async createBrandKit(input: DesignBrandKitCreateRecord) {
    const at = this.now();
    const row: DesignBrandKit = { ...copy(input), id: newId("dbrand"), builtIn: false, createdAt: at, updatedAt: at };
    this.kits.set(row.id, row);
    return copy(row);
  }
  async updateBrandKit(owner: string, id: string, patch: DesignBrandKitPatch) {
    const row = this.owned(this.kits, owner, id);
    if (!row) return null;
    const next = { ...row, ...defined(copy(patch)), updatedAt: this.now() };
    this.kits.set(id, next);
    return copy(next);
  }
  async deleteBrandKit(owner: string, id: string) { return this.owned(this.kits, owner, id) ? this.kits.delete(id) : false; }

  async createRequest(input: DesignRequestCreateRecord) {
    const at = this.now();
    const row: DesignRequest = { ...copy(input), id: newId("dreq"), status: "QUEUED", resultAssetIds: [], question: null, answer: null, message: null, takenAt: null, deliveredAt: null, createdAt: at, updatedAt: at };
    this.requests.set(row.id, row);
    return copy(row);
  }
  async getRequest(owner: string, id: string) { const row = this.owned(this.requests, owner, id); return row ? copy(row) : null; }
  async listRequests(owner: string, filter: DesignRequestFilter) {
    return [...this.requests.values()].filter((row) => row.ownerUserId === owner && (!filter.status?.length || filter.status.includes(row.status))
      && (!filter.designPaneId || row.designPaneId === filter.designPaneId) && (!filter.requesterPaneId || row.requester.paneId === filter.requesterPaneId))
      .sort(byNewest).slice(0, filter.limit).map(copy);
  }
  async updateRequest(owner: string, id: string, patch: DesignRequestPatch, fromStatus?: DesignRequestStatus[]) {
    const row = this.owned(this.requests, owner, id);
    if (!row || (fromStatus && !fromStatus.includes(row.status))) return null;
    const next = { ...row, ...defined(copy(patch)), updatedAt: this.now() };
    this.requests.set(id, next);
    return copy(next);
  }
  async takeNextRequest(owner: string, paneId: string, staleMs: number) {
    const now = this.now();
    const stale = Date.parse(now) - staleMs;
    const next = [...this.requests.values()].filter((row) => row.ownerUserId === owner && (
      (row.status === "QUEUED" && (row.designPaneId === null || row.designPaneId === paneId))
      || ((row.status === "TAKEN" || row.status === "IN_PROGRESS") && Date.parse(row.updatedAt) < stale)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (!next) return null;
    const taken: DesignRequest = { ...next, status: "TAKEN", designPaneId: paneId, takenAt: now, updatedAt: now };
    this.requests.set(taken.id, taken);
    return copy(taken);
  }

  async createAsset(input: DesignAssetCreateRecord) {
    const at = this.now();
    const row: DesignAsset = { ...copy(input), id: newId("dasset"), createdAt: at, updatedAt: at };
    this.assets.set(row.id, row);
    return copy(row);
  }
  async getAsset(owner: string, id: string) { const row = this.owned(this.assets, owner, id); return row ? copy(row) : null; }
  async listAssets(owner: string, filter: DesignAssetFilter) {
    return [...this.assets.values()].filter((row) => row.ownerUserId === owner && (!filter.paneId || row.paneId === filter.paneId)
      && (!filter.requestId || row.requestId === filter.requestId) && (!filter.formatIds?.length || filter.formatIds.includes(row.formatId))
      && (!filter.brandKitId || row.brandKitId === filter.brandKitId) && (!filter.ids || filter.ids.includes(row.id)))
      .sort(byNewest).slice(0, filter.limit).map(copy);
  }
  async updateAsset(owner: string, id: string, patch: DesignAssetPatch) {
    const row = this.owned(this.assets, owner, id);
    if (!row) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() };
    this.assets.set(id, next);
    return copy(next);
  }
  async deleteAsset(owner: string, id: string) {
    const row = this.owned(this.assets, owner, id);
    if (!row) return null;
    this.assets.delete(id);
    for (const [key, asset] of this.assets) if (asset.parentAssetId === id) this.assets.set(key, { ...asset, parentAssetId: null });
    return copy(row);
  }

  async createEvent(input: DesignEventCreateRecord) {
    const row: DesignEvent = { ...copy(input), id: newId("devt"), createdAt: this.now() };
    this.events.push(row);
    return copy(row);
  }
  async listEvents(owner: string, filter: DesignEventFilter) {
    return this.events.filter((row) => row.ownerUserId === owner && (!filter.paneId || row.paneId === filter.paneId) && (!filter.requestId || row.requestId === filter.requestId))
      .sort(byNewest).slice(0, filter.limit).map(copy);
  }
  async dispose() {}
}

// ---- Postgres ------------------------------------------------------------------------------------
const iso = (value: unknown): string | null => value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

interface Table<T> { name: string; columns: Record<string, string>; json: ReadonlySet<string>; arrays: ReadonlySet<string>; row(raw: Record<string, unknown>): T }
const select = (table: Table<unknown>) => Object.entries(table.columns).map(([field, column]) => `${column} AS "${field}"`).join(", ");
const cast = (table: Table<unknown>, field: string) => table.json.has(field) ? "::jsonb" : table.arrays.has(field) ? "::text[]" : "";
const value = (table: Table<unknown>, field: string, raw: unknown) => table.json.has(field) && raw !== null ? JSON.stringify(raw) : raw;
/** `SET col = $n, ...` for the defined fields of a patch, numbering placeholders from `start`. */
function setClause(table: Table<unknown>, patch: Record<string, unknown>, start: number): { sql: string; values: unknown[] } {
  const entries = Object.entries(patch).filter(([field, raw]) => raw !== undefined && table.columns[field]);
  const sql = entries.map(([field], index) => `${table.columns[field]} = $${start + index}${cast(table, field)}`);
  return { sql: [...sql, ...(table.columns.updatedAt ? ["updated_at = now()"] : [])].join(", "), values: entries.map(([field, raw]) => value(table, field, raw)) };
}

const kitTable: Table<DesignBrandKit> = {
  name: "design_brand_kits",
  columns: { id: "id", ownerUserId: "owner_user_id", name: "name", colors: "colors", fonts: "fonts", logos: "logos", voice: "voice", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["colors", "fonts"]), arrays: new Set(["logos"]),
  row: (raw) => ({ ...(raw as unknown as DesignBrandKit), builtIn: false, colors: object(raw.colors) as DesignBrandKit["colors"], fonts: object(raw.fonts) as DesignBrandKit["fonts"],
    logos: (raw.logos as string[] | null) ?? [], createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const requestTable: Table<DesignRequest> = {
  name: "design_requests",
  columns: { id: "id", ownerUserId: "owner_user_id", designPaneId: "design_pane_id", requester: "requester", brief: "brief", formatIds: "format_ids", engine: "engine", brandKitId: "brand_kit_id",
    referenceArtifactIds: "reference_artifact_ids", callback: "callback", status: "status", resultAssetIds: "result_asset_ids", question: "question", answer: "answer", message: "message",
    takenAt: "taken_at", deliveredAt: "delivered_at", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["requester", "callback"]), arrays: new Set(["formatIds", "referenceArtifactIds", "resultAssetIds"]),
  row: (raw) => ({ ...(raw as unknown as DesignRequest), requester: object(raw.requester) as DesignRequest["requester"], callback: raw.callback ? object(raw.callback) as DesignRequest["callback"] : null,
    formatIds: (raw.formatIds as string[] | null) ?? [], referenceArtifactIds: (raw.referenceArtifactIds as string[] | null) ?? [], resultAssetIds: (raw.resultAssetIds as string[] | null) ?? [],
    takenAt: iso(raw.takenAt), deliveredAt: iso(raw.deliveredAt), createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const assetTable: Table<DesignAsset> = {
  name: "design_assets",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", requestId: "request_id", artifactId: "artifact_id", formatId: "format_id", width: "width", height: "height",
    mimeType: "mime_type", engine: "engine", model: "model", label: "label", prompt: "prompt", templateId: "template_id", params: "params", brandKitId: "brand_kit_id",
    parentAssetId: "parent_asset_id", pinned: "pinned", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["params"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as DesignAsset), width: Number(raw.width), height: Number(raw.height), params: raw.params ? object(raw.params) : null,
    createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const eventTable: Table<DesignEvent> = {
  name: "design_events",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", requestId: "request_id", assetId: "asset_id", type: "type", message: "message", payload: "payload", createdAt: "created_at" },
  json: new Set(["payload"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as DesignEvent), payload: object(raw.payload), createdAt: iso(raw.createdAt)! })
};

export class PostgresDesignRepository implements DesignRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresDesignRepository(createSpacePgPool(url, { max: 2 })); }
  private async insert<T>(table: Table<T>, values: Record<string, unknown>): Promise<T> {
    const fields = Object.keys(values).filter((field) => table.columns[field] && values[field] !== undefined);
    const placeholders = fields.map((field, index) => `$${index + 1}${cast(table as Table<unknown>, field)}`);
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO ${table.name}(${fields.map((field) => table.columns[field]).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING ${select(table as Table<unknown>)}`,
      fields.map((field) => value(table as Table<unknown>, field, values[field])))).rows[0]!;
    return table.row(row);
  }
  private async update<T>(table: Table<T>, owner: string, id: string, patch: Record<string, unknown>, extraWhere = "", extraValues: unknown[] = []): Promise<T | null> {
    const { sql, values } = setClause(table as Table<unknown>, patch, 3 + extraValues.length);
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE ${table.name} SET ${sql} WHERE owner_user_id=$1 AND id=$2 ${extraWhere} RETURNING ${select(table as Table<unknown>)}`,
      [owner, id, ...extraValues, ...values])).rows[0];
    return row ? table.row(row) : null;
  }
  private async one<T>(table: Table<T>, owner: string, id: string): Promise<T | null> {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${select(table as Table<unknown>)} FROM ${table.name} WHERE owner_user_id=$1 AND id=$2`, [owner, id])).rows[0];
    return row ? table.row(row) : null;
  }

  async listBrandKits(owner: string) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(kitTable as Table<unknown>)} FROM design_brand_kits WHERE owner_user_id=$1 ORDER BY created_at, id LIMIT 200`, [owner])).rows.map(kitTable.row);
  }
  getBrandKit(owner: string, id: string) { return this.one(kitTable, owner, id); }
  createBrandKit(input: DesignBrandKitCreateRecord) { return this.insert(kitTable, { ...input, id: newId("dbrand") }); }
  updateBrandKit(owner: string, id: string, patch: DesignBrandKitPatch) { return this.update(kitTable, owner, id, patch); }
  async deleteBrandKit(owner: string, id: string) {
    return ((await this.pool.query("DELETE FROM design_brand_kits WHERE owner_user_id=$1 AND id=$2", [owner, id])) as { rowCount?: number | null }).rowCount! > 0;
  }

  createRequest(input: DesignRequestCreateRecord) { return this.insert(requestTable, { ...input, id: newId("dreq"), status: "QUEUED" }); }
  getRequest(owner: string, id: string) { return this.one(requestTable, owner, id); }
  async listRequests(owner: string, filter: DesignRequestFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(requestTable as Table<unknown>)} FROM design_requests WHERE owner_user_id=$1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
        AND ($3::text IS NULL OR design_pane_id=$3) AND ($4::text IS NULL OR requester->>'paneId'=$4) ORDER BY created_at DESC, id DESC LIMIT $5`,
      [owner, filter.status?.length ? filter.status : null, filter.designPaneId ?? null, filter.requesterPaneId ?? null, filter.limit])).rows.map(requestTable.row);
  }
  updateRequest(owner: string, id: string, patch: DesignRequestPatch, fromStatus?: DesignRequestStatus[]) {
    return fromStatus ? this.update(requestTable, owner, id, patch, "AND status = ANY($3::text[])", [fromStatus]) : this.update(requestTable, owner, id, patch);
  }
  async takeNextRequest(owner: string, paneId: string, staleMs: number) {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE design_requests SET status='TAKEN', design_pane_id=$2, taken_at=now(), updated_at=now()
      WHERE id = (SELECT id FROM design_requests WHERE owner_user_id=$1
        AND ((status='QUEUED' AND (design_pane_id IS NULL OR design_pane_id=$2))
          OR (status IN ('TAKEN','IN_PROGRESS') AND updated_at < now() - ($3::int * interval '1 millisecond')))
        ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING ${select(requestTable as Table<unknown>)}`, [owner, paneId, staleMs])).rows[0];
    return row ? requestTable.row(row) : null;
  }

  createAsset(input: DesignAssetCreateRecord) { return this.insert(assetTable, { ...input, id: newId("dasset") }); }
  getAsset(owner: string, id: string) { return this.one(assetTable, owner, id); }
  async listAssets(owner: string, filter: DesignAssetFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(assetTable as Table<unknown>)} FROM design_assets WHERE owner_user_id=$1 AND ($2::text IS NULL OR pane_id=$2)
        AND ($3::text IS NULL OR request_id=$3) AND ($4::text[] IS NULL OR format_id = ANY($4::text[])) AND ($5::text IS NULL OR brand_kit_id=$5)
        AND ($6::text[] IS NULL OR id = ANY($6::text[])) ORDER BY created_at DESC, id DESC LIMIT $7`,
      [owner, filter.paneId ?? null, filter.requestId ?? null, filter.formatIds?.length ? filter.formatIds : null, filter.brandKitId ?? null, filter.ids ?? null, filter.limit])).rows.map(assetTable.row);
  }
  updateAsset(owner: string, id: string, patch: DesignAssetPatch) { return this.update(assetTable, owner, id, patch); }
  async deleteAsset(owner: string, id: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`DELETE FROM design_assets WHERE owner_user_id=$1 AND id=$2 RETURNING ${select(assetTable as Table<unknown>)}`, [owner, id])).rows[0];
    return row ? assetTable.row(row) : null;
  }

  createEvent(input: DesignEventCreateRecord) { return this.insert(eventTable, { ...input, id: newId("devt") }); }
  async listEvents(owner: string, filter: DesignEventFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(eventTable as Table<unknown>)} FROM design_events WHERE owner_user_id=$1 AND ($2::text IS NULL OR pane_id=$2)
        AND ($3::text IS NULL OR request_id=$3) ORDER BY created_at DESC, id DESC LIMIT $4`, [owner, filter.paneId ?? null, filter.requestId ?? null, filter.limit])).rows.map(eventTable.row);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
