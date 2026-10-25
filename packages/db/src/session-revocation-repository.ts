import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

export interface PersistedSessionRevocations {
  /** [signature SHA-256 hex, expiry epoch ms] */
  signatures: Array<[string, number]>;
  /** [user id, revoked-before epoch ms] */
  userEpochs: Array<[string, number]>;
}

/** SEC-011: durable session revocations. Stores signature hashes only, never tokens. */
export interface SessionRevocationRepository {
  load(nowMs: number): Promise<PersistedSessionRevocations>;
  revokeSignature(signatureSha256: string, expiresAtMs: number): Promise<void>;
  revokeUser(userId: string, revokedBeforeMs: number): Promise<void>;
  pruneExpired(nowMs: number): Promise<number>;
  dispose(): Promise<void>;
}

const signatureHashPattern = /^[0-9a-f]{64}$/;

export class PostgresSessionRevocationRepository implements SessionRevocationRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) {
    return new PostgresSessionRevocationRepository(createSpacePgPool(url, { max: 1 }));
  }
  async load(nowMs: number): Promise<PersistedSessionRevocations> {
    const now = new Date(nowMs).toISOString();
    const signatures = (await this.pool.query<{ hash: string; expiresAt: Date }>(
      `SELECT signature_sha256 AS hash, expires_at AS "expiresAt" FROM session_revocations WHERE expires_at > $1`, [now])).rows;
    const epochs = (await this.pool.query<{ userId: string; revokedBefore: Date }>(
      `SELECT user_id AS "userId", revoked_before AS "revokedBefore" FROM user_session_epochs`)).rows;
    return {
      signatures: signatures.map((row) => [row.hash, new Date(row.expiresAt).getTime()]),
      userEpochs: epochs.map((row) => [row.userId, new Date(row.revokedBefore).getTime()])
    };
  }
  async revokeSignature(signatureSha256: string, expiresAtMs: number) {
    if (!signatureHashPattern.test(signatureSha256)) throw new Error("Invalid session signature hash.");
    await this.pool.query(
      `INSERT INTO session_revocations (signature_sha256, expires_at) VALUES ($1, $2)
       ON CONFLICT (signature_sha256) DO UPDATE SET expires_at = GREATEST(session_revocations.expires_at, EXCLUDED.expires_at)`,
      [signatureSha256, new Date(expiresAtMs).toISOString()]);
  }
  async revokeUser(userId: string, revokedBeforeMs: number) {
    await this.pool.query(
      `INSERT INTO user_session_epochs (user_id, revoked_before) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET revoked_before = GREATEST(user_session_epochs.revoked_before, EXCLUDED.revoked_before), updated_at = now()`,
      [userId, new Date(revokedBeforeMs).toISOString()]);
  }
  async pruneExpired(nowMs: number) {
    const result = await this.pool.query(`DELETE FROM session_revocations WHERE expires_at <= $1`, [new Date(nowMs).toISOString()]);
    return result.rowCount ?? 0;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
