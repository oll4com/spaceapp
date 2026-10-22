import { randomBytes } from "node:crypto";
import type { AppStudioEvent, AppStudioEventStatus, AppStudioEventType, AppStudioPreview } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// App Studio pane storage (migration 0236): one feed per pane (briefs and questions carry a status, the rest is the activity
// timeline) and the latest preview per pane, device and route. Postgres live, in-memory for tests.

const newId = () => `asevt:${randomBytes(9).toString("base64url")}`;

export type AppStudioEventCreateRecord = Omit<AppStudioEvent, "id" | "createdAt" | "updatedAt">;
export interface AppStudioEventFilter { types?: AppStudioEventType[]; status?: AppStudioEventStatus[]; limit: number }
export type AppStudioPreviewRecord = Omit<AppStudioPreview, "capturedAt"> & { ownerUserId: string };

export interface AppStudioRepository {
  createEvent(input: AppStudioEventCreateRecord): Promise<AppStudioEvent>;
  getEvent(owner: string, id: string): Promise<AppStudioEvent | null>;
  /** Newest first. */
  listEvents(owner: string, paneId: string, filter: AppStudioEventFilter): Promise<AppStudioEvent[]>;
  /** Changes status and merges `payload` only while the row is in one of `fromStatus`; null otherwise. */
  updateEvent(owner: string, id: string, patch: { status: AppStudioEventStatus; payload?: Record<string, unknown> }, fromStatus: AppStudioEventStatus[]): Promise<AppStudioEvent | null>;
  /** The oldest PENDING brief of the pane becomes TAKEN. */
  takeNextBrief(owner: string, paneId: string): Promise<AppStudioEvent | null>;
  /** Stores the preview and returns the artifact it replaced (null for a new device and route). */
  putPreview(input: AppStudioPreviewRecord): Promise<{ preview: AppStudioPreview; replacedArtifactId: string | null }>;
  listPreviews(owner: string, paneId: string): Promise<AppStudioPreview[]>;
  /** Drops the routes past the newest `keepRoutes` and returns their artifacts. */
  trimPreviewRoutes(owner: string, paneId: string, keepRoutes: number): Promise<string[]>;
  dispose(): Promise<void>;
}

const copy = <T>(row: T): T => structuredClone(row);
const byNewest = (left: AppStudioEvent, right: AppStudioEvent) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);

export class InMemoryAppStudioRepository implements AppStudioRepository {
  private events = new Map<string, AppStudioEvent>();
  private previews = new Map<string, AppStudioPreview & { ownerUserId: string }>();
  constructor(private now: () => string = () => new Date().toISOString()) {}

  async createEvent(input: AppStudioEventCreateRecord) {
    const at = this.now();
    const row: AppStudioEvent = { ...copy(input), id: newId(), createdAt: at, updatedAt: at };
    this.events.set(row.id, row);
    return copy(row);
  }
  async getEvent(owner: string, id: string) { const row = this.events.get(id); return row && row.ownerUserId === owner ? copy(row) : null; }
  async listEvents(owner: string, paneId: string, filter: AppStudioEventFilter) {
    return [...this.events.values()].filter((row) => row.ownerUserId === owner && row.paneId === paneId
      && (!filter.types?.length || filter.types.includes(row.type)) && (!filter.status?.length || (row.status !== null && filter.status.includes(row.status))))
      .sort(byNewest).slice(0, filter.limit).map(copy);
  }
  async updateEvent(owner: string, id: string, patch: { status: AppStudioEventStatus; payload?: Record<string, unknown> }, fromStatus: AppStudioEventStatus[]) {
    const row = this.events.get(id);
    if (!row || row.ownerUserId !== owner || row.status === null || !fromStatus.includes(row.status)) return null;
    const next = { ...row, status: patch.status, payload: { ...row.payload, ...copy(patch.payload ?? {}) }, updatedAt: this.now() };
    this.events.set(id, next);
    return copy(next);
  }
  async takeNextBrief(owner: string, paneId: string) {
    const next = [...this.events.values()].filter((row) => row.ownerUserId === owner && row.paneId === paneId && row.type === "BRIEF" && row.status === "PENDING")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
    return next ? this.updateEvent(owner, next.id, { status: "TAKEN" }, ["PENDING"]) : null;
  }
  async putPreview(input: AppStudioPreviewRecord) {
    const key = `${input.paneId}\n${input.deviceId}\n${input.route}`;
    const replaced = this.previews.get(key)?.artifactId ?? null;
    const row = { ...copy(input), capturedAt: this.now() };
    this.previews.set(key, row);
    const { ownerUserId: _owner, ...preview } = row;
    return { preview, replacedArtifactId: replaced };
  }
  async listPreviews(owner: string, paneId: string) {
    return [...this.previews.values()].filter((row) => row.ownerUserId === owner && row.paneId === paneId)
      .sort((left, right) => left.route.localeCompare(right.route) || left.deviceId.localeCompare(right.deviceId))
      .map(({ ownerUserId: _owner, ...preview }) => copy(preview));
  }
  async trimPreviewRoutes(owner: string, paneId: string, keepRoutes: number) {
    const rows = [...this.previews.entries()].filter(([, row]) => row.ownerUserId === owner && row.paneId === paneId);
    const newest = new Map<string, string>();
    for (const [, row] of rows) if ((newest.get(row.route) ?? "") < row.capturedAt) newest.set(row.route, row.capturedAt);
    const keep = new Set([...newest.entries()].sort((left, right) => right[1].localeCompare(left[1])).slice(0, keepRoutes).map(([route]) => route));
    const dropped: string[] = [];
    for (const [key, row] of rows) if (!keep.has(row.route)) { this.previews.delete(key); dropped.push(row.artifactId); }
    return dropped;
  }
  async dispose() {}
}

// ---- Postgres ------------------------------------------------------------------------------------
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const EVENT_COLUMNS = `id, owner_user_id AS "ownerUserId", pane_id AS "paneId", type, status, message, payload, created_at AS "createdAt", updated_at AS "updatedAt"`;
const PREVIEW_COLUMNS = `pane_id AS "paneId", device_id AS "deviceId", route, artifact_id AS "artifactId", captured_at AS "capturedAt"`;
const eventRow = (raw: Record<string, unknown>): AppStudioEvent => ({ ...(raw as unknown as AppStudioEvent), status: (raw.status as AppStudioEventStatus | null) ?? null,
  payload: object(raw.payload), createdAt: iso(raw.createdAt), updatedAt: iso(raw.updatedAt) });
const previewRow = (raw: Record<string, unknown>): AppStudioPreview => ({ ...(raw as unknown as AppStudioPreview), capturedAt: iso(raw.capturedAt) });

export class PostgresAppStudioRepository implements AppStudioRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresAppStudioRepository(createSpacePgPool(url, { max: 2 })); }
  private async event(sql: string, values: unknown[]) {
    const row = (await this.pool.query<Record<string, unknown>>(sql, values)).rows[0];
    return row ? eventRow(row) : null;
  }

  async createEvent(input: AppStudioEventCreateRecord) {
    return (await this.event(`INSERT INTO app_studio_events(id, owner_user_id, pane_id, type, status, message, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING ${EVENT_COLUMNS}`,
      [newId(), input.ownerUserId, input.paneId, input.type, input.status, input.message, JSON.stringify(input.payload)]))!;
  }
  getEvent(owner: string, id: string) { return this.event(`SELECT ${EVENT_COLUMNS} FROM app_studio_events WHERE owner_user_id=$1 AND id=$2`, [owner, id]); }
  async listEvents(owner: string, paneId: string, filter: AppStudioEventFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${EVENT_COLUMNS} FROM app_studio_events WHERE owner_user_id=$1 AND pane_id=$2
        AND ($3::text[] IS NULL OR type = ANY($3::text[])) AND ($4::text[] IS NULL OR status = ANY($4::text[])) ORDER BY created_at DESC, id DESC LIMIT $5`,
      [owner, paneId, filter.types?.length ? filter.types : null, filter.status?.length ? filter.status : null, filter.limit])).rows.map(eventRow);
  }
  updateEvent(owner: string, id: string, patch: { status: AppStudioEventStatus; payload?: Record<string, unknown> }, fromStatus: AppStudioEventStatus[]) {
    return this.event(`UPDATE app_studio_events SET status=$3, payload = payload || $4::jsonb, updated_at=now()
      WHERE owner_user_id=$1 AND id=$2 AND status = ANY($5::text[]) RETURNING ${EVENT_COLUMNS}`, [owner, id, patch.status, JSON.stringify(patch.payload ?? {}), fromStatus]);
  }
  takeNextBrief(owner: string, paneId: string) {
    return this.event(`UPDATE app_studio_events SET status='TAKEN', updated_at=now() WHERE id = (SELECT id FROM app_studio_events
      WHERE owner_user_id=$1 AND pane_id=$2 AND type='BRIEF' AND status='PENDING' ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${EVENT_COLUMNS}`, [owner, paneId]);
  }
  async putPreview(input: AppStudioPreviewRecord) {
    // The CTE reads the row as it was before the upsert, so the replaced artifact comes back in the same statement.
    const row = (await this.pool.query<Record<string, unknown>>(`WITH previous AS (SELECT artifact_id FROM app_studio_previews WHERE pane_id=$1 AND device_id=$2 AND route=$3)
      INSERT INTO app_studio_previews(pane_id, device_id, route, owner_user_id, artifact_id) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (pane_id, device_id, route) DO UPDATE SET artifact_id=EXCLUDED.artifact_id, owner_user_id=EXCLUDED.owner_user_id, captured_at=now()
      RETURNING ${PREVIEW_COLUMNS}, (SELECT artifact_id FROM previous) AS "replaced"`, [input.paneId, input.deviceId, input.route, input.ownerUserId, input.artifactId])).rows[0]!;
    const { replaced, ...preview } = row;
    return { preview: previewRow(preview), replacedArtifactId: (replaced as string | null) ?? null };
  }
  async listPreviews(owner: string, paneId: string) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${PREVIEW_COLUMNS} FROM app_studio_previews WHERE owner_user_id=$1 AND pane_id=$2 ORDER BY route, device_id`,
      [owner, paneId])).rows.map(previewRow);
  }
  async trimPreviewRoutes(owner: string, paneId: string, keepRoutes: number) {
    return (await this.pool.query<{ artifact_id: string }>(`DELETE FROM app_studio_previews WHERE owner_user_id=$1 AND pane_id=$2 AND route NOT IN (
        SELECT route FROM app_studio_previews WHERE owner_user_id=$1 AND pane_id=$2 GROUP BY route ORDER BY max(captured_at) DESC LIMIT $3) RETURNING artifact_id`,
      [owner, paneId, keepRoutes])).rows.map((row) => row.artifact_id);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
