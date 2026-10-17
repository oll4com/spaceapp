import { describe, expect, it } from "vitest";
import { PostgresSpaceStore, type PgClientLike, type PgPoolLike } from "../src/index.js";

// Multi-user accounts (plan clipboard:VrMJ14wJPmVs step 2): an invite is accepted once, inside one transaction.
class InvitePool implements PgPoolLike, PgClientLike {
  readonly sql: string[] = [];
  constructor(private readonly invite: { id: string; email: string; role: string; expiresAt: string } | null, private readonly emailTaken = false) {}
  async connect(): Promise<PgClientLike> { return this; }
  release(): void {}
  async query<T = unknown>(text: string) {
    this.sql.push(text.replace(/\s+/g, " ").trim());
    if (text.includes("FROM user_invites") && text.includes("FOR UPDATE")) return { rows: (this.invite ? [this.invite] : []) as T[], rowCount: this.invite ? 1 : 0 };
    if (text.includes("SELECT 1 FROM users")) return { rows: (this.emailTaken ? [{}] : []) as T[], rowCount: this.emailTaken ? 1 : 0 };
    return { rows: [] as T[], rowCount: 1 };
  }
}

const open = { id: "user_invite:abc", email: "dev@example.com", role: "USER", expiresAt: "2026-10-23T00:00:00.000Z" };
const accept = (pool: InvitePool, now = "2026-10-16T12:00:00.000Z") =>
  new PostgresSpaceStore(pool).acceptUserInvite({ tokenSha256: "a".repeat(64), passwordHash: "scrypt$hash", now });

describe("Postgres user invites", () => {
  it("creates the user and marks the invite accepted in one transaction", async () => {
    const pool = new InvitePool(open);
    const user = await accept(pool);
    expect(user).toMatchObject({ email: "dev@example.com", role: "USER" });
    expect(user?.id).toMatch(/^user:/);
    expect(pool.sql[0]).toBe("BEGIN");
    expect(pool.sql.some((sql) => sql.startsWith("INSERT INTO users"))).toBe(true);
    expect(pool.sql.some((sql) => sql.startsWith("UPDATE user_invites SET accepted_at"))).toBe(true);
    expect(pool.sql.at(-1)).toBe("COMMIT");
  });

  it("rolls back an unknown, expired or already registered invite without creating a user", async () => {
    for (const pool of [new InvitePool(null), new InvitePool({ ...open, expiresAt: "2026-10-01T00:00:00.000Z" }), new InvitePool(open, true)]) {
      expect(await accept(pool)).toBeNull();
      expect(pool.sql.at(-1)).toBe("ROLLBACK");
      expect(pool.sql.some((sql) => sql.startsWith("INSERT INTO users"))).toBe(false);
    }
  });
});
