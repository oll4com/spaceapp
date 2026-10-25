import { rollbackKeepingError } from "./rollback.js";
import { randomUUID } from "node:crypto";
import { SpaceConflictError, SpaceNotFoundError, type GoogleAccount, type VerifiedGoogleIdentity } from "@space/runtime";
import type { AuthUser } from "@space/contracts";
import type { PgClientLike, PgPoolLike } from "./space-store.js";

type Row = Omit<GoogleAccount, "createdAt" | "updatedAt"> & { createdAt: Date | string; updatedAt: Date | string };
const columns = `id, owner_user_id AS "ownerUserId", google_sub AS "googleSub", email,
  display_name AS "displayName", avatar_url AS "avatarUrl", is_primary AS "isPrimary",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const map = (row: Row): GoogleAccount => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() });

export class PostgresGoogleAccountsRepository {
  constructor(private readonly pool: PgPoolLike) {}

  async list(userId: string): Promise<GoogleAccount[]> {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM google_accounts WHERE owner_user_id=$1 ORDER BY is_primary DESC, created_at, id`, [userId]);
    return result.rows.map(map);
  }

  // A user-row lock serializes all account mutations, including final-login checks.
  private async mutate<T>(userId: string, operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let rollbackFailed = false;
    try {
      await client.query("BEGIN");
      const owner = await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
      if (!owner.rows.length) throw new SpaceNotFoundError("User not found.");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      rollbackFailed = await rollbackKeepingError(client);
      throw error;
    } finally { client.release?.(rollbackFailed || undefined); }
  }

  async link(userId: string, identity: VerifiedGoogleIdentity): Promise<GoogleAccount> {
    return this.mutate(userId, async client => {
      const result = await client.query<Row>(`
        INSERT INTO google_accounts(id,owner_user_id,google_sub,email,display_name,avatar_url,is_primary)
        VALUES ($1,$2,$3,$4,$5,$6,NOT EXISTS(SELECT 1 FROM google_accounts WHERE owner_user_id=$2))
        ON CONFLICT(google_sub) DO UPDATE SET email=EXCLUDED.email,
          display_name=COALESCE(EXCLUDED.display_name,google_accounts.display_name),
          avatar_url=COALESCE(EXCLUDED.avatar_url,google_accounts.avatar_url), updated_at=now()
        WHERE google_accounts.owner_user_id=EXCLUDED.owner_user_id
        RETURNING ${columns}`, [`google_account:${randomUUID()}`, userId, identity.sub, identity.email, identity.name ?? null, identity.picture ?? null]);
      const account = result.rows[0];
      if (!account) throw new SpaceConflictError("This Google account is already linked to another Space user.");
      if (account.isPrimary) await client.query("UPDATE users SET google_id=$2, avatar_url=COALESCE($3,avatar_url), updated_at=now() WHERE id=$1", [userId, identity.sub, identity.picture ?? null]);
      return map(account);
    });
  }

  private async primary(client: PgClientLike, userId: string, accountId: string): Promise<GoogleAccount> {
    const selected = await client.query<Row>(`SELECT ${columns} FROM google_accounts WHERE owner_user_id=$1 AND id=$2`, [userId, accountId]);
    const account = selected.rows[0];
    if (!account) throw new SpaceNotFoundError("Google account not found.");
    await client.query("UPDATE google_accounts SET is_primary=false WHERE owner_user_id=$1 AND is_primary", [userId]);
    const updated = await client.query<Row>(`UPDATE google_accounts SET is_primary=true, updated_at=now() WHERE id=$1 RETURNING ${columns}`, [accountId]);
    await client.query("UPDATE users SET google_id=$2,avatar_url=$3,updated_at=now() WHERE id=$1", [userId, account.googleSub, account.avatarUrl]);
    return map(updated.rows[0]!);
  }

  async setPrimary(userId: string, accountId: string): Promise<GoogleAccount> {
    return this.mutate(userId, client => this.primary(client, userId, accountId));
  }

  async remove(userId: string, accountId: string, hasAlternativeLogin: boolean): Promise<void> {
    await this.mutate(userId, async client => {
      const result = await client.query<Row>(`SELECT ${columns} FROM google_accounts WHERE owner_user_id=$1 ORDER BY created_at,id`, [userId]);
      const account = result.rows.find(row => row.id === accountId);
      if (!account) throw new SpaceNotFoundError("Google account not found.");
      const remaining = result.rows.filter(row => row.id !== accountId);
      if (!remaining.length && !hasAlternativeLogin) throw new SpaceConflictError("Cannot remove the last usable login method. Set up another login first.");
      await client.query("DELETE FROM google_accounts WHERE owner_user_id=$1 AND id=$2", [userId, accountId]);
      if (account.isPrimary) {
        if (remaining[0]) await this.primary(client, userId, remaining[0].id);
        else await client.query("UPDATE users SET google_id=NULL,updated_at=now() WHERE id=$1", [userId]);
      }
    });
  }

  async findUser(googleSub: string): Promise<AuthUser | null> {
    const result = await this.pool.query<AuthUser>(`SELECT u.id,u.email,u.role,u.google_id AS "googleId",u.avatar_url AS "avatarUrl"
      FROM users u JOIN google_accounts a ON a.owner_user_id=u.id WHERE a.google_sub=$1`, [googleSub]);
    return result.rows[0] ?? null;
  }
}
