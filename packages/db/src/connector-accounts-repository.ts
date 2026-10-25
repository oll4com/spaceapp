import { randomUUID } from "node:crypto";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** Accounts a user connected for email and calendar (Space Dots Stage 5). Tokens arrive encrypted. */
export interface ConnectorAccountRecord {
  accountId: string;
  ownerUserId: string;
  provider: "GOOGLE" | "MICROSOFT";
  email: string;
  scopes: string[];
  refreshTokenEncrypted: string;
  accessTokenEncrypted: string | null;
  accessExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ConnectorAccountsRepository {
  /** Adds the account or, when it is connected again, replaces its tokens and scopes. */
  upsert(input: { ownerUserId: string; provider: ConnectorAccountRecord["provider"]; email: string; scopes: string[];
    refreshTokenEncrypted: string; accessTokenEncrypted: string | null; accessExpiresAt: string | null }): Promise<ConnectorAccountRecord>;
  list(owner: string): Promise<ConnectorAccountRecord[]>;
  get(owner: string, accountId: string): Promise<ConnectorAccountRecord | null>;
  saveAccessToken(accountId: string, accessTokenEncrypted: string, accessExpiresAt: string): Promise<void>;
  delete(owner: string, accountId: string): Promise<boolean>;
  dispose(): Promise<void>;
}
const columns = `account_id AS "accountId", owner_user_id AS "ownerUserId", provider, email, scopes, refresh_token_encrypted AS "refreshTokenEncrypted",
  access_token_encrypted AS "accessTokenEncrypted", access_expires_at AS "accessExpiresAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
function record(row: Record<string, unknown>): ConnectorAccountRecord {
  const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();
  return { ...(row as unknown as ConnectorAccountRecord), scopes: Array.isArray(row.scopes) ? row.scopes as string[] : [],
    accessExpiresAt: iso(row.accessExpiresAt), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! };
}
export class PostgresConnectorAccountsRepository implements ConnectorAccountsRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresConnectorAccountsRepository(createSpacePgPool(url, { max: 2 })); }
  async upsert(input: Parameters<ConnectorAccountsRepository["upsert"]>[0]) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO connector_accounts(account_id,owner_user_id,provider,email,scopes,
      refresh_token_encrypted,access_token_encrypted,access_expires_at) VALUES ($1,$2,$3,lower($4),$5,$6,$7,$8)
      ON CONFLICT (owner_user_id,provider,email) DO UPDATE SET scopes=EXCLUDED.scopes, refresh_token_encrypted=EXCLUDED.refresh_token_encrypted,
        access_token_encrypted=EXCLUDED.access_token_encrypted, access_expires_at=EXCLUDED.access_expires_at, updated_at=now()
      RETURNING ${columns}`, [`connector:${randomUUID().replace(/-/g, "")}`, input.ownerUserId, input.provider, input.email, input.scopes,
      input.refreshTokenEncrypted, input.accessTokenEncrypted, input.accessExpiresAt])).rows[0]!;
    return record(row);
  }
  async list(owner: string) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${columns} FROM connector_accounts WHERE owner_user_id=$1 ORDER BY provider, email`, [owner])).rows.map(record);
  }
  async get(owner: string, accountId: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${columns} FROM connector_accounts WHERE owner_user_id=$1 AND account_id=$2`, [owner, accountId])).rows[0];
    return row ? record(row) : null;
  }
  async saveAccessToken(accountId: string, accessTokenEncrypted: string, accessExpiresAt: string) {
    await this.pool.query(`UPDATE connector_accounts SET access_token_encrypted=$2, access_expires_at=$3, updated_at=now() WHERE account_id=$1`,
      [accountId, accessTokenEncrypted, accessExpiresAt]);
  }
  async delete(owner: string, accountId: string) {
    return (await this.pool.query(`DELETE FROM connector_accounts WHERE owner_user_id=$1 AND account_id=$2 RETURNING account_id`, [owner, accountId])).rows.length === 1;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
