import type { AppDeviceSession, AppSignInId } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

export type MobileDeviceScope = "read" | "act" | "decide";

/** A paired device's own fields (migration 0274, ADR-013 §8); null on a Google sign-in row. */
export interface PairedDeviceFields {
  noisePublic: string | null;
  decidePublicSpki: string | null;
  decideSecurityLevel: "TRUSTED_ENVIRONMENT" | "STRONGBOX" | null;
  /** The decide key's attestation chain serials, re-checked against Google's status list (migration 0281, C6); null before it or without decide. */
  decideSerials: string[] | null;
  scopes: MobileDeviceScope[] | null;
  /** What the device asked for; it holds read only until the owner allows it in the web (security review P1-5). */
  requestedScopes: MobileDeviceScope[] | null;
  confirmedAt: string | null;
  lastSeenAt: string | null;
  /** Paired through the SpaceApp relay: the offer's 256-bit rendezvous id the relay client listens on (migration 0282); null: direct only. */
  rendezvousId: string | null;
  /** A Pro phone's opaque push handle, from ctl push-handle (migration 0282, design §8.1); null: no wake. */
  pushHandle: string | null;
}

/** A device session row (migration 0245): the app's sign-in as Settings > Account > Devices lists it. Never the token. */
export interface AppDeviceSessionRecord extends AppDeviceSession, PairedDeviceFields {
  ownerUserId: string;
  sidSha256: string;
}

type NewSignIn = { id: string; ownerUserId: string; app: AppDeviceSession["app"]; deviceName: string; sidSha256: string; expiresAt: string };
type NewPaired = NewSignIn & { noisePublic: string; decidePublicSpki: string | null; decideSecurityLevel: PairedDeviceFields["decideSecurityLevel"];
  decideSerials?: string[] | null; requestedScopes: MobileDeviceScope[]; rendezvousId?: string | null };
const UNPAIRED: PairedDeviceFields = { noisePublic: null, decidePublicSpki: null, decideSecurityLevel: null, decideSerials: null, scopes: null, requestedScopes: null, confirmedAt: null, lastSeenAt: null,
  rendezvousId: null, pushHandle: null };

export interface AppDeviceSessionRepository {
  create(input: NewSignIn): Promise<AppDeviceSessionRecord>;
  /** A device paired over the mobile channel: held with read only, unconfirmed. */
  createPaired(input: NewPaired): Promise<AppDeviceSessionRecord>;
  /** The owner allowed a held device: its requested scopes apply. Null unless it is the owner's, paired, live and not yet confirmed. */
  confirm(ownerUserId: string, id: string, atIso: string): Promise<AppDeviceSessionRecord | null>;
  /** The device behind an IK handshake's static key, whatever its state (the caller checks revoked and expired). */
  byNoisePublic(noisePublic: string): Promise<AppDeviceSessionRecord | null>;
  /** A live paired device connected: last seen now, and it expires 90 days after that. */
  touch(id: string, atIso: string, expiresAtIso: string): Promise<AppDeviceSessionRecord | null>;
  /** The owner's live paired devices, oldest first (their own cap, apart from sign-ins); null: every owner's (the installation's keys, C3). */
  livePaired(ownerUserId: string | null, nowIso: string): Promise<AppDeviceSessionRecord[]>;
  /** Every owner's paired devices that ended (revoked or expired) and are still stored: their rendezvous ids, most recently ended first. */
  endedRendezvousIds(nowIso: string): Promise<string[]>;
  /** Google revoked the decide key's attestation (C6): decide leaves its scopes and the key goes; null when it had no decide key. */
  dropDecide(id: string): Promise<AppDeviceSessionRecord | null>;
  /** The phone's push handle, or null to forget it (the push service answered that it is gone). */
  setPushHandle(id: string, handle: string | null): Promise<void>;
  /** The owner's rows, newest first (live, expired and revoked ones until they are pruned). */
  list(ownerUserId: string): Promise<AppDeviceSessionRecord[]>;
  /** Live sign-in rows of one app, oldest first: not revoked, not expired. Paired devices never count (the sign-in cap revokes from this list). */
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
  async create(input: NewSignIn) { return this.insert({ ...input, ...UNPAIRED }); }
  async createPaired(input: NewPaired) {
    if ([...this.rows.values()].some((row) => row.noisePublic === input.noisePublic)) throw new Error("A device with this key exists.");
    if (input.rendezvousId && [...this.rows.values()].some((row) => row.rendezvousId === input.rendezvousId)) throw new Error("A device with this rendezvous id exists.");
    return this.insert({ ...UNPAIRED, ...input, decideSerials: input.decideSerials ?? null, rendezvousId: input.rendezvousId ?? null, scopes: ["read"] });
  }
  private insert(input: Omit<AppDeviceSessionRecord, "createdAt" | "revokedAt">) {
    if ([...this.rows.values()].some((row) => row.sidSha256 === input.sidSha256)) throw new Error("A device session with this session id exists.");
    const row: AppDeviceSessionRecord = { ...input, createdAt: new Date().toISOString(), revokedAt: null };
    this.rows.set(row.id, row);
    return { ...row };
  }
  async confirm(ownerUserId: string, id: string, atIso: string) {
    const row = this.rows.get(id);
    if (!row || row.ownerUserId !== ownerUserId || !row.noisePublic || row.revokedAt || row.confirmedAt || row.expiresAt <= atIso) return null;
    Object.assign(row, { confirmedAt: atIso, scopes: [...row.requestedScopes!] });
    return { ...row };
  }
  async byNoisePublic(noisePublic: string) {
    const row = [...this.rows.values()].find((entry) => entry.noisePublic === noisePublic);
    return row ? { ...row } : null;
  }
  async touch(id: string, atIso: string, expiresAtIso: string) {
    const row = this.rows.get(id);
    if (!row || !row.noisePublic || row.revokedAt) return null;
    Object.assign(row, { lastSeenAt: atIso, expiresAt: expiresAtIso });
    return { ...row };
  }
  async livePaired(ownerUserId: string | null, nowIso: string) {
    return [...this.rows.values()].filter((row) => (ownerUserId === null || row.ownerUserId === ownerUserId) && row.noisePublic && !row.revokedAt && row.expiresAt > nowIso)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((row) => ({ ...row }));
  }
  async endedRendezvousIds(nowIso: string) {
    const ended = (row: AppDeviceSessionRecord) => row.revokedAt ?? row.expiresAt;
    return [...this.rows.values()].filter((row) => row.noisePublic && row.rendezvousId && (row.revokedAt || row.expiresAt <= nowIso))
      .sort((a, b) => ended(b).localeCompare(ended(a))).map((row) => row.rendezvousId!);
  }
  async dropDecide(id: string) {
    const row = this.rows.get(id);
    if (!row?.decidePublicSpki) return null;
    const without = (scopes: MobileDeviceScope[] | null) => scopes && scopes.filter((scope) => scope !== "decide");
    Object.assign(row, { scopes: without(row.scopes), requestedScopes: without(row.requestedScopes), decidePublicSpki: null, decideSecurityLevel: null, decideSerials: null });
    return { ...row };
  }
  async setPushHandle(id: string, handle: string | null) {
    const row = this.rows.get(id);
    if (row?.noisePublic) row.pushHandle = handle;
  }
  async list(ownerUserId: string) {
    return [...this.rows.values()].filter((row) => row.ownerUserId === ownerUserId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((row) => ({ ...row }));
  }
  async live(ownerUserId: string, app: AppSignInId, nowIso: string) {
    return [...this.rows.values()].filter((row) => row.ownerUserId === ownerUserId && row.app === app && !row.noisePublic && !row.revokedAt && row.expiresAt > nowIso)
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

interface Row extends Omit<PairedDeviceFields, "confirmedAt" | "lastSeenAt"> { id: string; ownerUserId: string; app: AppDeviceSession["app"]; deviceName: string; sidSha256: string;
  createdAt: Date; expiresAt: Date; revokedAt: Date | null; confirmedAt: Date | null; lastSeenAt: Date | null }
const columns = `id, owner_user_id AS "ownerUserId", app, device_name AS "deviceName", sid_sha256 AS "sidSha256",
  created_at AS "createdAt", expires_at AS "expiresAt", revoked_at AS "revokedAt", noise_public AS "noisePublic", decide_public_spki AS "decidePublicSpki",
  decide_security_level AS "decideSecurityLevel", decide_serials AS "decideSerials", scopes, requested_scopes AS "requestedScopes", confirmed_at AS "confirmedAt", last_seen_at AS "lastSeenAt",
  rendezvous_id AS "rendezvousId", push_handle AS "pushHandle"`;
const toRecord = (row: Row): AppDeviceSessionRecord => ({ id: row.id, ownerUserId: row.ownerUserId, app: row.app, deviceName: row.deviceName, sidSha256: row.sidSha256,
  createdAt: iso(row.createdAt)!, expiresAt: iso(row.expiresAt)!, revokedAt: iso(row.revokedAt), noisePublic: row.noisePublic, decidePublicSpki: row.decidePublicSpki,
  decideSecurityLevel: row.decideSecurityLevel, decideSerials: row.decideSerials, scopes: row.scopes, requestedScopes: row.requestedScopes, confirmedAt: iso(row.confirmedAt), lastSeenAt: iso(row.lastSeenAt),
  rendezvousId: row.rendezvousId, pushHandle: row.pushHandle });

export class PostgresAppDeviceSessionRepository implements AppDeviceSessionRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) {
    return new PostgresAppDeviceSessionRepository(createSpacePgPool(url, { max: 2 }));
  }
  async create(input: NewSignIn) {
    const result = await this.pool.query<Row>(`INSERT INTO app_device_sessions (id, owner_user_id, app, device_name, sid_sha256, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${columns}`, [input.id, input.ownerUserId, input.app, input.deviceName, input.sidSha256, input.expiresAt]);
    return toRecord(result.rows[0]!);
  }
  async createPaired(input: NewPaired) {
    const result = await this.pool.query<Row>(`INSERT INTO app_device_sessions (id, owner_user_id, app, device_name, sid_sha256, expires_at, noise_public,
      decide_public_spki, decide_security_level, scopes, requested_scopes, decide_serials, rendezvous_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY['read'], $10, $11, $12)
      RETURNING ${columns}`, [input.id, input.ownerUserId, input.app, input.deviceName, input.sidSha256, input.expiresAt, input.noisePublic, input.decidePublicSpki,
        input.decideSecurityLevel, input.requestedScopes, input.decideSerials ?? null, input.rendezvousId ?? null]);
    return toRecord(result.rows[0]!);
  }
  async confirm(ownerUserId: string, id: string, atIso: string) {
    const result = await this.pool.query<Row>(`UPDATE app_device_sessions SET confirmed_at = $3, scopes = requested_scopes WHERE id = $1 AND owner_user_id = $2
      AND noise_public IS NOT NULL AND revoked_at IS NULL AND confirmed_at IS NULL AND expires_at > $3 RETURNING ${columns}`, [id, ownerUserId, atIso]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }
  async byNoisePublic(noisePublic: string) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM app_device_sessions WHERE noise_public = $1`, [noisePublic]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }
  async touch(id: string, atIso: string, expiresAtIso: string) {
    const result = await this.pool.query<Row>(`UPDATE app_device_sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1 AND noise_public IS NOT NULL
      AND revoked_at IS NULL RETURNING ${columns}`, [id, atIso, expiresAtIso]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }
  async livePaired(ownerUserId: string | null, nowIso: string) {
    return (await this.pool.query<Row>(`SELECT ${columns} FROM app_device_sessions WHERE ($1::text IS NULL OR owner_user_id = $1) AND noise_public IS NOT NULL
      AND revoked_at IS NULL AND expires_at > $2 ORDER BY created_at ASC`, [ownerUserId, nowIso])).rows.map(toRecord);
  }
  async endedRendezvousIds(nowIso: string) {
    return (await this.pool.query<{ rendezvous_id: string }>(`SELECT rendezvous_id FROM app_device_sessions WHERE noise_public IS NOT NULL AND rendezvous_id IS NOT NULL
      AND (revoked_at IS NOT NULL OR expires_at <= $1) ORDER BY COALESCE(revoked_at, expires_at) DESC`, [nowIso])).rows.map((row) => row.rendezvous_id);
  }
  async dropDecide(id: string) {
    const result = await this.pool.query<Row>(`UPDATE app_device_sessions SET scopes = array_remove(scopes, 'decide'), requested_scopes = array_remove(requested_scopes, 'decide'),
      decide_public_spki = NULL, decide_security_level = NULL, decide_serials = NULL WHERE id = $1 AND decide_public_spki IS NOT NULL RETURNING ${columns}`, [id]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }
  async setPushHandle(id: string, handle: string | null) {
    await this.pool.query(`UPDATE app_device_sessions SET push_handle = $2 WHERE id = $1 AND noise_public IS NOT NULL`, [id, handle]);
  }
  async list(ownerUserId: string) {
    return (await this.pool.query<Row>(`SELECT ${columns} FROM app_device_sessions WHERE owner_user_id = $1 ORDER BY created_at DESC`, [ownerUserId])).rows.map(toRecord);
  }
  async live(ownerUserId: string, app: AppSignInId, nowIso: string) {
    return (await this.pool.query<Row>(`SELECT ${columns} FROM app_device_sessions WHERE owner_user_id = $1 AND app = $2 AND noise_public IS NULL AND revoked_at IS NULL AND expires_at > $3
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
