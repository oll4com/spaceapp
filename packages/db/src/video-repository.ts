import { randomBytes } from "node:crypto";
import type { VideoAsset, VideoEvent, VideoRequest, VideoRequestStatus } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Video pane storage (migration 0242): requests from other agents, panes, Nous, Dots, Live and the operator (a queue a Video
// pane takes, works and delivers), the assets it made and its activity feed. Postgres live, in-memory for tests. Same shape as
// design-repository.ts without brand kits.

const newId = (prefix: string) => `${prefix}:${randomBytes(9).toString("base64url")}`;

export type VideoRequestCreateRecord = Omit<VideoRequest, "id" | "status" | "resultAssetIds" | "question" | "answer" | "message" | "takenAt" | "deliveredAt" | "createdAt" | "updatedAt">;
export type VideoRequestPatch = Partial<Pick<VideoRequest, "videoPaneId" | "sources" | "status" | "resultAssetIds" | "question" | "answer" | "message" | "takenAt" | "deliveredAt">>;
export interface VideoRequestFilter { status?: VideoRequestStatus[]; videoPaneId?: string; requesterPaneId?: string; limit: number }
export type VideoAssetCreateRecord = Omit<VideoAsset, "id" | "createdAt" | "updatedAt">;
export type VideoAssetPatch = Partial<Pick<VideoAsset, "label" | "pinned" | "requestId" | "description" | "credits" | "durationSec" | "width" | "height">>;
export interface VideoAssetFilter { paneId?: string; requestId?: string; formatIds?: string[]; kinds?: VideoAsset["kind"][]; ids?: string[]; parentIds?: string[]; artifactIds?: string[]; limit: number }
export type VideoEventCreateRecord = Omit<VideoEvent, "id" | "createdAt">;
export interface VideoEventFilter { paneId?: string; requestId?: string; limit: number }

export interface VideoRepository {
  createRequest(input: VideoRequestCreateRecord): Promise<VideoRequest>;
  getRequest(owner: string, id: string): Promise<VideoRequest | null>;
  /** Newest first. */
  listRequests(owner: string, filter: VideoRequestFilter): Promise<VideoRequest[]>;
  /** Updates a request; with `fromStatus` only while it is in one of those states (an atomic transition), else null. */
  updateRequest(owner: string, id: string, patch: VideoRequestPatch, fromStatus?: VideoRequestStatus[]): Promise<VideoRequest | null>;
  /**
   * Atomically takes the oldest QUEUED request routed to this pane or to no pane, or one TAKEN/IN_PROGRESS without an update
   * for `staleMs` (its pane stopped working on it), and marks it TAKEN by this pane.
   */
  takeNextRequest(owner: string, paneId: string, staleMs: number): Promise<VideoRequest | null>;
  createAsset(input: VideoAssetCreateRecord): Promise<VideoAsset>;
  getAsset(owner: string, id: string): Promise<VideoAsset | null>;
  /** Newest first. */
  listAssets(owner: string, filter: VideoAssetFilter): Promise<VideoAsset[]>;
  updateAsset(owner: string, id: string, patch: VideoAssetPatch): Promise<VideoAsset | null>;
  /** Deletes an asset and answers what it was (so the caller can unpin its artifacts), or null. */
  deleteAsset(owner: string, id: string): Promise<VideoAsset | null>;
  createEvent(input: VideoEventCreateRecord): Promise<VideoEvent>;
  /** Newest first. */
  listEvents(owner: string, filter: VideoEventFilter): Promise<VideoEvent[]>;
  dispose(): Promise<void>;
}

const defined = <T extends object>(patch: T) => Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
const byNewest = <T extends { createdAt: string; id: string }>(left: T, right: T) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
const copy = <T>(row: T): T => structuredClone(row);

export class InMemoryVideoRepository implements VideoRepository {
  private requests = new Map<string, VideoRequest>();
  private assets = new Map<string, VideoAsset>();
  private events: VideoEvent[] = [];
  constructor(private now: () => string = () => new Date().toISOString()) {}
  private owned<T extends { ownerUserId: string }>(map: Map<string, T>, owner: string, id: string): T | null { const row = map.get(id); return row && row.ownerUserId === owner ? row : null; }

  async createRequest(input: VideoRequestCreateRecord) {
    const at = this.now();
    const row: VideoRequest = { ...copy(input), id: newId("vreq"), status: "QUEUED", resultAssetIds: [], question: null, answer: null, message: null, takenAt: null, deliveredAt: null, createdAt: at, updatedAt: at };
    this.requests.set(row.id, row);
    return copy(row);
  }
  async getRequest(owner: string, id: string) { const row = this.owned(this.requests, owner, id); return row ? copy(row) : null; }
  async listRequests(owner: string, filter: VideoRequestFilter) {
    return [...this.requests.values()].filter((row) => row.ownerUserId === owner && (!filter.status?.length || filter.status.includes(row.status))
      && (!filter.videoPaneId || row.videoPaneId === filter.videoPaneId) && (!filter.requesterPaneId || row.requester.paneId === filter.requesterPaneId))
      .sort(byNewest).slice(0, filter.limit).map(copy);
  }
  async updateRequest(owner: string, id: string, patch: VideoRequestPatch, fromStatus?: VideoRequestStatus[]) {
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
      (row.status === "QUEUED" && (row.videoPaneId === null || row.videoPaneId === paneId))
      || ((row.status === "TAKEN" || row.status === "IN_PROGRESS") && Date.parse(row.updatedAt) < stale)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (!next) return null;
    const taken: VideoRequest = { ...next, status: "TAKEN", videoPaneId: paneId, takenAt: now, updatedAt: now };
    this.requests.set(taken.id, taken);
    return copy(taken);
  }

  async createAsset(input: VideoAssetCreateRecord) {
    const at = this.now();
    const row: VideoAsset = { ...copy(input), id: newId("vasset"), createdAt: at, updatedAt: at };
    this.assets.set(row.id, row);
    return copy(row);
  }
  async getAsset(owner: string, id: string) { const row = this.owned(this.assets, owner, id); return row ? copy(row) : null; }
  async listAssets(owner: string, filter: VideoAssetFilter) {
    return [...this.assets.values()].filter((row) => row.ownerUserId === owner && (!filter.paneId || row.paneId === filter.paneId)
      && (!filter.requestId || row.requestId === filter.requestId) && (!filter.formatIds?.length || (row.formatId !== null && filter.formatIds.includes(row.formatId)))
      && (!filter.kinds?.length || filter.kinds.includes(row.kind)) && (!filter.ids || filter.ids.includes(row.id))
      && (!filter.parentIds || (row.parentAssetId !== null && filter.parentIds.includes(row.parentAssetId))) && (!filter.artifactIds || filter.artifactIds.includes(row.artifactId)))
      .sort(byNewest).slice(0, filter.limit).map(copy);
  }
  async updateAsset(owner: string, id: string, patch: VideoAssetPatch) {
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

  async createEvent(input: VideoEventCreateRecord) {
    const row: VideoEvent = { ...copy(input), id: newId("vevt"), createdAt: this.now() };
    this.events.push(row);
    return copy(row);
  }
  async listEvents(owner: string, filter: VideoEventFilter) {
    return this.events.filter((row) => row.ownerUserId === owner && (!filter.paneId || row.paneId === filter.paneId) && (!filter.requestId || row.requestId === filter.requestId))
      .sort(byNewest).slice(0, filter.limit).map(copy);
  }
  async dispose() {}
}

// ---- Postgres ------------------------------------------------------------------------------------
const iso = (value: unknown): string | null => value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);

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

const requestTable: Table<VideoRequest> = {
  name: "video_requests",
  columns: { id: "id", ownerUserId: "owner_user_id", videoPaneId: "video_pane_id", requester: "requester", brief: "brief", sources: "sources", formatIds: "format_ids", options: "options",
    callback: "callback", status: "status", resultAssetIds: "result_asset_ids", question: "question", answer: "answer", message: "message",
    takenAt: "taken_at", deliveredAt: "delivered_at", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["requester", "sources", "options", "callback"]), arrays: new Set(["formatIds", "resultAssetIds"]),
  row: (raw) => ({ ...(raw as unknown as VideoRequest), requester: object(raw.requester) as VideoRequest["requester"], callback: raw.callback ? object(raw.callback) as VideoRequest["callback"] : null,
    sources: Array.isArray(raw.sources) ? raw.sources as VideoRequest["sources"] : [], options: object(raw.options) as VideoRequest["options"],
    formatIds: (raw.formatIds as string[] | null) ?? [], resultAssetIds: (raw.resultAssetIds as string[] | null) ?? [],
    takenAt: iso(raw.takenAt), deliveredAt: iso(raw.deliveredAt), createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const assetTable: Table<VideoAsset> = {
  name: "video_assets",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", requestId: "request_id", artifactId: "artifact_id", thumbnailArtifactId: "thumbnail_artifact_id", formatId: "format_id",
    width: "width", height: "height", durationSec: "duration_sec", mimeType: "mime_type", kind: "kind", label: "label", description: "description", madeBy: "made_by", credits: "credits",
    timeline: "timeline", parentAssetId: "parent_asset_id", pinned: "pinned", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["madeBy", "timeline"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as VideoAsset), width: number(raw.width), height: number(raw.height), durationSec: number(raw.durationSec),
    madeBy: raw.madeBy ? object(raw.madeBy) as VideoAsset["madeBy"] : null, timeline: raw.timeline ? object(raw.timeline) as unknown as VideoAsset["timeline"] : null,
    createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const eventTable: Table<VideoEvent> = {
  name: "video_events",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", requestId: "request_id", assetId: "asset_id", type: "type", message: "message", payload: "payload", createdAt: "created_at" },
  json: new Set(["payload"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as VideoEvent), payload: object(raw.payload), createdAt: iso(raw.createdAt)! })
};

export class PostgresVideoRepository implements VideoRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresVideoRepository(createSpacePgPool(url, { max: 2 })); }
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

  createRequest(input: VideoRequestCreateRecord) { return this.insert(requestTable, { ...input, id: newId("vreq"), status: "QUEUED" }); }
  getRequest(owner: string, id: string) { return this.one(requestTable, owner, id); }
  async listRequests(owner: string, filter: VideoRequestFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(requestTable as Table<unknown>)} FROM video_requests WHERE owner_user_id=$1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
        AND ($3::text IS NULL OR video_pane_id=$3) AND ($4::text IS NULL OR requester->>'paneId'=$4) ORDER BY created_at DESC, id DESC LIMIT $5`,
      [owner, filter.status?.length ? filter.status : null, filter.videoPaneId ?? null, filter.requesterPaneId ?? null, filter.limit])).rows.map(requestTable.row);
  }
  updateRequest(owner: string, id: string, patch: VideoRequestPatch, fromStatus?: VideoRequestStatus[]) {
    return fromStatus ? this.update(requestTable, owner, id, patch, "AND status = ANY($3::text[])", [fromStatus]) : this.update(requestTable, owner, id, patch);
  }
  async takeNextRequest(owner: string, paneId: string, staleMs: number) {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE video_requests SET status='TAKEN', video_pane_id=$2, taken_at=now(), updated_at=now()
      WHERE id = (SELECT id FROM video_requests WHERE owner_user_id=$1
        AND ((status='QUEUED' AND (video_pane_id IS NULL OR video_pane_id=$2))
          OR (status IN ('TAKEN','IN_PROGRESS') AND updated_at < now() - ($3::int * interval '1 millisecond')))
        ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING ${select(requestTable as Table<unknown>)}`, [owner, paneId, staleMs])).rows[0];
    return row ? requestTable.row(row) : null;
  }

  createAsset(input: VideoAssetCreateRecord) { return this.insert(assetTable, { ...input, id: newId("vasset") }); }
  getAsset(owner: string, id: string) { return this.one(assetTable, owner, id); }
  async listAssets(owner: string, filter: VideoAssetFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(assetTable as Table<unknown>)} FROM video_assets WHERE owner_user_id=$1 AND ($2::text IS NULL OR pane_id=$2)
        AND ($3::text IS NULL OR request_id=$3) AND ($4::text[] IS NULL OR format_id = ANY($4::text[])) AND ($5::text[] IS NULL OR kind = ANY($5::text[]))
        AND ($6::text[] IS NULL OR id = ANY($6::text[])) AND ($8::text[] IS NULL OR parent_asset_id = ANY($8::text[]))
        AND ($9::text[] IS NULL OR artifact_id = ANY($9::text[])) ORDER BY created_at DESC, id DESC LIMIT $7`,
      [owner, filter.paneId ?? null, filter.requestId ?? null, filter.formatIds?.length ? filter.formatIds : null, filter.kinds?.length ? filter.kinds : null, filter.ids ?? null, filter.limit,
        filter.parentIds ?? null, filter.artifactIds ?? null])).rows.map(assetTable.row);
  }
  updateAsset(owner: string, id: string, patch: VideoAssetPatch) { return this.update(assetTable, owner, id, patch); }
  async deleteAsset(owner: string, id: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`DELETE FROM video_assets WHERE owner_user_id=$1 AND id=$2 RETURNING ${select(assetTable as Table<unknown>)}`, [owner, id])).rows[0];
    return row ? assetTable.row(row) : null;
  }

  createEvent(input: VideoEventCreateRecord) { return this.insert(eventTable, { ...input, id: newId("vevt") }); }
  async listEvents(owner: string, filter: VideoEventFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(eventTable as Table<unknown>)} FROM video_events WHERE owner_user_id=$1 AND ($2::text IS NULL OR pane_id=$2)
        AND ($3::text IS NULL OR request_id=$3) ORDER BY created_at DESC, id DESC LIMIT $4`, [owner, filter.paneId ?? null, filter.requestId ?? null, filter.limit])).rows.map(eventTable.row);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
