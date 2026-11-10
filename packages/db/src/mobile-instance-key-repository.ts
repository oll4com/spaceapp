import { rollbackKeepingError } from "./rollback.js";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/**
 * The installation's mobile channel keys (migration 0274, ADR-013 §2): a Noise static (X25519) and an identity key (Ed25519), whose private
 * halves are one blob sealed with the connector key. Class A: rows change only by a rotation and are never deleted automatically.
 */
export interface MobileInstanceKeyRecord {
  id: string;
  status: "ACTIVE" | "RETIRING" | "RETIRED";
  noisePublic: string;
  identityPublic: string;
  sealedPrivate: string;
  /** The routine rotation's statement signed by the previous identity key; null for the first keys and after a compromise. */
  rotationStatement: string | null;
  createdAt: string;
  retiringUntil: string | null;
  retiredAt: string | null;
}

type NewKeys = { id: string; noisePublic: string; identityPublic: string; sealedPrivate: string };

export interface MobileInstanceKeyRepository {
  /** The first keys; refused while an ACTIVE pair exists. */
  create(input: NewKeys): Promise<MobileInstanceKeyRecord>;
  active(): Promise<MobileInstanceKeyRecord | null>;
  /** The pairs that still answer IK: the ACTIVE one first, then those RETIRING until a later time, newest first. */
  answering(nowIso: string): Promise<MobileInstanceKeyRecord[]>;
  /**
   * One transaction: the ACTIVE pair turns RETIRING for 30 days (routine), or every pair still answering turns RETIRED at once
   * (compromised: devices pair again, security review P2-4); then the new pair is ACTIVE.
   */
  rotate(input: NewKeys & { rotationStatement: string | null; compromised: boolean; nowIso: string }): Promise<MobileInstanceKeyRecord>;
  dispose(): Promise<void>;
}

export const MOBILE_KEY_RETIRING_MS = 30 * 24 * 60 * 60 * 1000;
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const noActive = () => new Error("The mobile channel has no active keys to rotate.");

export class InMemoryMobileInstanceKeyRepository implements MobileInstanceKeyRepository {
  private readonly rows: MobileInstanceKeyRecord[] = [];
  private insert(input: NewKeys, rotationStatement: string | null, createdAt: string) {
    if (this.rows.some((row) => row.status === "ACTIVE")) throw new Error("The mobile channel already has active keys.");
    const row: MobileInstanceKeyRecord = { ...input, status: "ACTIVE", rotationStatement, createdAt, retiringUntil: null, retiredAt: null };
    this.rows.push(row);
    return { ...row };
  }
  async create(input: NewKeys) { return this.insert(input, null, new Date().toISOString()); }
  async active() { const row = this.rows.find((entry) => entry.status === "ACTIVE"); return row ? { ...row } : null; }
  async answering(nowIso: string) {
    return this.rows.filter((row) => row.status === "ACTIVE" || (row.status === "RETIRING" && row.retiringUntil! > nowIso))
      .sort((a, b) => Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE") || b.createdAt.localeCompare(a.createdAt)).map((row) => ({ ...row }));
  }
  async rotate(input: Parameters<MobileInstanceKeyRepository["rotate"]>[0]) {
    const { rotationStatement, compromised, nowIso, ...keys } = input;
    const current = this.rows.find((row) => row.status === "ACTIVE");
    if (!current) throw noActive();
    for (const row of this.rows) {
      if (compromised && row.status !== "RETIRED") Object.assign(row, { status: "RETIRED", retiringUntil: null, retiredAt: nowIso });
      else if (row === current) Object.assign(row, { status: "RETIRING", retiringUntil: new Date(Date.parse(nowIso) + MOBILE_KEY_RETIRING_MS).toISOString() });
    }
    return this.insert(keys, compromised ? null : rotationStatement, nowIso);
  }
  async dispose() {}
}

interface Row { id: string; status: MobileInstanceKeyRecord["status"]; noisePublic: string; identityPublic: string; sealedPrivate: string; rotationStatement: string | null;
  createdAt: Date; retiringUntil: Date | null; retiredAt: Date | null }
const columns = `id, status, noise_public AS "noisePublic", identity_public AS "identityPublic", sealed_private AS "sealedPrivate",
  rotation_statement AS "rotationStatement", created_at AS "createdAt", retiring_until AS "retiringUntil", retired_at AS "retiredAt"`;
const toRecord = (row: Row): MobileInstanceKeyRecord => ({ ...row, createdAt: iso(row.createdAt)!, retiringUntil: iso(row.retiringUntil), retiredAt: iso(row.retiredAt) });
const insertSql = `INSERT INTO mobile_instance_keys (id, status, noise_public, identity_public, sealed_private, rotation_statement, created_at)
  VALUES ($1, 'ACTIVE', $2, $3, $4, $5, $6) RETURNING ${columns}`;

export class PostgresMobileInstanceKeyRepository implements MobileInstanceKeyRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) {
    return new PostgresMobileInstanceKeyRepository(createSpacePgPool(url, { max: 2 }));
  }
  async create(input: NewKeys) {
    const result = await this.pool.query<Row>(insertSql, [input.id, input.noisePublic, input.identityPublic, input.sealedPrivate, null, new Date().toISOString()]);
    return toRecord(result.rows[0]!);
  }
  async active() {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM mobile_instance_keys WHERE status = 'ACTIVE'`);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }
  async answering(nowIso: string) {
    return (await this.pool.query<Row>(`SELECT ${columns} FROM mobile_instance_keys WHERE status = 'ACTIVE' OR (status = 'RETIRING' AND retiring_until > $1)
      ORDER BY status = 'ACTIVE' DESC, created_at DESC`, [nowIso])).rows.map(toRecord);
  }
  async rotate(input: Parameters<MobileInstanceKeyRepository["rotate"]>[0]) {
    const client = await this.pool.connect();
    let rollbackFailed = false;
    try {
      await client.query("BEGIN");
      const current = await client.query<{ id: string }>(`SELECT id FROM mobile_instance_keys WHERE status = 'ACTIVE' FOR UPDATE`);
      if (!current.rows[0]) throw noActive();
      if (input.compromised) {
        await client.query(`UPDATE mobile_instance_keys SET status = 'RETIRED', retiring_until = NULL, retired_at = $1 WHERE status <> 'RETIRED'`, [input.nowIso]);
      } else {
        await client.query(`UPDATE mobile_instance_keys SET status = 'RETIRING', retiring_until = $2 WHERE id = $1`,
          [current.rows[0].id, new Date(Date.parse(input.nowIso) + MOBILE_KEY_RETIRING_MS).toISOString()]);
      }
      const inserted = await client.query<Row>(insertSql, [input.id, input.noisePublic, input.identityPublic, input.sealedPrivate,
        input.compromised ? null : input.rotationStatement, input.nowIso]);
      await client.query("COMMIT");
      return toRecord(inserted.rows[0]!);
    } catch (error) {
      const rollback = await rollbackKeepingError(client, error);
      rollbackFailed = rollback.failed;
      throw rollback.error;
    } finally { client.release?.(rollbackFailed || undefined); }
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
