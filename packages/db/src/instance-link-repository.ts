import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/**
 * Space Link (migration 0325, ADR-014): a SpaceApp this one's Nous manages, paired as a spaceapp-link device of it. The other side's keys
 * as its pairing code gave them (rotated when it says so), the device id it answered, and this side's Noise private key sealed with the
 * connector key. Class A: a row goes only when its person removes the link.
 */
export interface InstanceLinkRecord {
  id: string;
  ownerUserId: string;
  label: string;
  origins: string[];
  noisePublic: string;
  identityPublic: string;
  deviceId: string;
  sealedDevicePrivate: string;
  /** What the other side last said this link may do: read only until its person allows the link. */
  scopes: string[];
  /** Cloudflare Access service token in front of its channel (migration 0327): Vault key ids, never values; null when none. */
  accessKeys: InstanceLinkAccessKeys | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface InstanceLinkAccessKeys { clientId: string; clientSecret: string }

type NewLink = Omit<InstanceLinkRecord, "createdAt" | "lastSeenAt">;
/** A connect's news: the time, the scopes it answered and, after its routine key rotation, its new keys. */
type Seen = { atIso: string; scopes: string[]; noisePublic?: string; identityPublic?: string };

export interface InstanceLinkRepository {
  create(input: NewLink): Promise<InstanceLinkRecord>;
  /** The owner's links, oldest first. */
  list(ownerUserId: string): Promise<InstanceLinkRecord[]>;
  get(ownerUserId: string, id: string): Promise<InstanceLinkRecord | null>;
  seen(id: string, seen: Seen): Promise<void>;
  /** The person removed the link: its row and sealed key go. False when it is not the owner's. */
  remove(ownerUserId: string, id: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export class InMemoryInstanceLinkRepository implements InstanceLinkRepository {
  private readonly rows = new Map<string, InstanceLinkRecord>();
  async create(input: NewLink) {
    const row = { ...input, createdAt: new Date().toISOString(), lastSeenAt: null };
    this.rows.set(row.id, row);
    return { ...row };
  }
  async list(ownerUserId: string) {
    return [...this.rows.values()].filter((row) => row.ownerUserId === ownerUserId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((row) => ({ ...row }));
  }
  async get(ownerUserId: string, id: string) {
    const row = this.rows.get(id);
    return row?.ownerUserId === ownerUserId ? { ...row } : null;
  }
  async seen(id: string, seen: Seen) {
    const row = this.rows.get(id);
    if (row) Object.assign(row, { lastSeenAt: seen.atIso, scopes: seen.scopes }, seen.noisePublic ? { noisePublic: seen.noisePublic, identityPublic: seen.identityPublic } : {});
  }
  async remove(ownerUserId: string, id: string) {
    return this.rows.get(id)?.ownerUserId === ownerUserId && this.rows.delete(id);
  }
  async dispose() {}
}

interface Row extends Omit<InstanceLinkRecord, "createdAt" | "lastSeenAt"> { createdAt: Date; lastSeenAt: Date | null }
const columns = `id, owner_user_id AS "ownerUserId", label, origins, noise_public AS "noisePublic", identity_public AS "identityPublic",
  device_id AS "deviceId", sealed_device_private AS "sealedDevicePrivate", scopes, access_keys AS "accessKeys", created_at AS "createdAt", last_seen_at AS "lastSeenAt"`;
const toRecord = (row: Row): InstanceLinkRecord => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), lastSeenAt: row.lastSeenAt && new Date(row.lastSeenAt).toISOString() });

export class PostgresInstanceLinkRepository implements InstanceLinkRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) {
    return new PostgresInstanceLinkRepository(createSpacePgPool(url, { max: 2 }));
  }
  async create(input: NewLink) {
    const result = await this.pool.query<Row>(`INSERT INTO instance_links (id, owner_user_id, label, origins, noise_public, identity_public, device_id, sealed_device_private, scopes, access_keys)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10::jsonb) RETURNING ${columns}`, [input.id, input.ownerUserId, input.label, JSON.stringify(input.origins),
      input.noisePublic, input.identityPublic, input.deviceId, input.sealedDevicePrivate, JSON.stringify(input.scopes), input.accessKeys ? JSON.stringify(input.accessKeys) : null]);
    return toRecord(result.rows[0]!);
  }
  async list(ownerUserId: string) {
    return (await this.pool.query<Row>(`SELECT ${columns} FROM instance_links WHERE owner_user_id = $1 ORDER BY created_at`, [ownerUserId])).rows.map(toRecord);
  }
  async get(ownerUserId: string, id: string) {
    const row = (await this.pool.query<Row>(`SELECT ${columns} FROM instance_links WHERE owner_user_id = $1 AND id = $2`, [ownerUserId, id])).rows[0];
    return row ? toRecord(row) : null;
  }
  async seen(id: string, seen: Seen) {
    await this.pool.query(`UPDATE instance_links SET last_seen_at = $2, scopes = $3::jsonb, noise_public = COALESCE($4, noise_public),
      identity_public = COALESCE($5, identity_public) WHERE id = $1`, [id, seen.atIso, JSON.stringify(seen.scopes), seen.noisePublic ?? null, seen.identityPublic ?? null]);
  }
  async remove(ownerUserId: string, id: string) {
    return ((await this.pool.query(`DELETE FROM instance_links WHERE owner_user_id = $1 AND id = $2`, [ownerUserId, id])).rowCount ?? 0) > 0;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
