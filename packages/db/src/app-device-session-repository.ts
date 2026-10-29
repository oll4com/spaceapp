import type { AppDeviceSession, AppSignInId } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** A device session row (migration 0245): the app's sign-in as Settings > Account > Devices lists it. Never the token. */
export interface AppDeviceSessionRecord extends AppDeviceSession {
  ownerUserId: string;
  sidSha256: string;
}

export interface AppDeviceSessionRepository {
  create(input: { id: string; ownerUserId: string; app: AppSignInId; deviceName: string; sidSha256: string; expiresAt: string }): Promise<AppDeviceSessionRecord>;
  /** The owner's rows, newest first (live, expired and revoked ones until they are pruned). */
  list(ownerUserId: string): Promise<AppDeviceSessionRecord[]>;
  /** Live rows of one app, oldest first: not revoked, not expired. */
  live(ownerUserId: string, app: AppSignInId, nowIso: string): Promise<AppDeviceSessionRecord[]>;
  /** Marks a live row revoked; null when it is not the owner's or already revoked. */
  revoke(ownerUserId: string, id: string, atIso: string): Promise<AppDeviceSessionRecord | null>;
  revokeBySid(sidSha256: string, atIso: string): Promise<AppDeviceSessionRecord | null>;
  /** Class B: rows that ended (expired or revoked) more than 30 days before nowIso. */
  pruneEnded(nowIso: string): Promise<number>;
  dispose(): Promise<void>;
}

const ENDED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();

export class InMemoryAppDeviceSessionRepository implements AppDeviceSessionRepository {
  private readonly rows = new Map<string, AppDeviceSessionRecord>();
  async create(input: Parameters<AppDeviceSessionRepository["create"]>[0]) {
    if ([...this.rows.values()].some((row) => row.sidSha256 === input.sidSha256)) throw new Error("A device session with this session id exists.");
    const row: AppDeviceSessionRecord = { ...input, createdAt: new Date().toISOString(), revokedAt: null };
    this.rows.set(row.id, row);
    return { ...row };
  }
  async list(ownerUserId: string) {
    return [...this.rows.values()].filter((row) => row.ownerUserId === ownerUserId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((row) => ({ ...row }));
  }
  async live(ownerUserId: string, app: AppSignInId, nowIso: string) {
    return [...this.rows.values()].filter((row) => row.ownerUserId === ownerUserId && row.app === app && !row.revokedAt && row.expiresAt > nowIso)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((row) => ({ ...row }));
  }
  async revoke(ownerUserId: string, id: string, atIso: string) {
    const row = this.rows.get(id);
    if (!row || row.ownerUserId !== ownerUserId || row.revokedAt) return null;
    row.revokedAt = atIso;
    return { ...row };
  }
  async revokeBySid(sidSha256: string, atIso: string) {
    const row = [...this.rows.values()].find((entry) => entry.sidSha256 === sidSha256 && !entry.revokedAt);
    if (!row) return null;
    row.revokedAt = atIso;
    return { ...row };
  }
  async pruneEnded(nowIso: string) {
    const cutoff = new Date(Date.parse(nowIso) - ENDED_KEEP_MS).toISOString();
    let removed = 0;
    for (const [id, row] of this.rows) if ((row.revokedAt ?? row.expiresAt) < cutoff) { this.rows.delete(id); removed += 1; }
    return removed;
  }
  async dispose() {}
}

interface Row { id: string; ownerUserId: string; app: AppSignInId; deviceName: string; sidSha256: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null }
const columns = `id, owner_user_id AS "ownerUserId", app, device_name AS "deviceName", sid_sha256 AS "sidSha256",
  created_at AS "createdAt", expires_at AS "expiresAt", revoked_at AS "revokedAt"`;
const toRecord = (row: Row): AppDeviceSessionRecord => ({ id: row.id, ownerUserId: row.ownerUserId, app: row.app, deviceName: row.deviceName, sidSha256: row.sidSha256,
  createdAt: iso(row.createdAt)!, expiresAt: iso(row.expiresAt)!, revokedAt: iso(row.revokedAt) });

export class PostgresAppDeviceSessionRepository implements AppDeviceSessionRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) {
    return new PostgresAppDeviceSessionRepository(createSpacePgPool(url, { max: 2 }));
  }
  async create(input: Parameters<AppDeviceSessionRepository["create"]>[0]) {
    const result = await this.pool.query<Row>(`INSERT INTO app_device_sessions (id, owner_user_id, app, device_name, sid_sha256, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${columns}`, [input.id, input.ownerUserId, input.app, input.deviceName, input.sidSha256, input.expiresAt]);
    return toRecord(result.rows[0]!);
  }
  async list(ownerUserId: string) {
    return (await this.pool.query<Row>(`SELECT ${columns} FROM app_device_sessions WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 100`, [ownerUserId])).rows.map(toRecord);
  }
  async live(ownerUserId: string, app: AppSignInId, nowIso: string) {
    return (await this.pool.query<Row>(`SELECT ${columns} FROM app_device_sessions WHERE owner_user_id = $1 AND app = $2 AND revoked_at IS NULL AND expires_at > $3
      ORDER BY created_at ASC`, [ownerUserId, app, nowIso])).rows.map(toRecord);
  }
  async revoke(ownerUserId: string, id: string, atIso: string) {
    const result = await this.pool.query<Row>(`UPDATE app_device_sessions SET revoked_at = $3 WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL
      RETURNING ${columns}`, [id, ownerUserId, atIso]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }
  async revokeBySid(sidSha256: string, atIso: string) {
    const result = await this.pool.query<Row>(`UPDATE app_device_sessions SET revoked_at = $2 WHERE sid_sha256 = $1 AND revoked_at IS NULL RETURNING ${columns}`, [sidSha256, atIso]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }
  async pruneEnded(nowIso: string) {
    const cutoff = new Date(Date.parse(nowIso) - ENDED_KEEP_MS).toISOString();
    const result = await this.pool.query(`DELETE FROM app_device_sessions WHERE COALESCE(revoked_at, expires_at) < $1`, [cutoff]);
    return result.rowCount ?? 0;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
