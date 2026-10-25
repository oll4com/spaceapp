import { describe, expect, it } from "vitest";
import { loadMigrations, PostgresSpaceStore, type PgClientLike, type PgPoolLike } from "../src/index.js";

const linkRow = {
  id: "link:postgres", title: "Status", description: "Service status", url: "https://status.example.com/",
  openMode: "NEW_TAB" as const, category: "GENERAL" as const, isQuick: true, sortOrder: 4,
  createdAt: "2026-07-16T08:00:00.000Z", updatedAt: "2026-07-16T08:00:00.000Z"
};

class LinkPool implements PgPoolLike, PgClientLike {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  async connect() { return this; }
  release() {}
  async query<T = unknown>(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes("INSERT INTO user_link_libraries")) return { rows: [{ owner_user_id: values[0] } as T], rowCount: 1 };
    if (sql.includes("SELECT count(*)") && sql.includes("user_links")) return { rows: [{ count: 1 } as T], rowCount: 1 };
    if (sql.includes("SELECT COALESCE(max(sort_order)")) return { rows: [{ nextOrder: 4 } as T], rowCount: 1 };
    if ((sql.includes("INSERT INTO user_links") || sql.includes("UPDATE user_links") || sql.includes("DELETE FROM user_links")) && sql.includes("RETURNING")) return { rows: [linkRow as T], rowCount: 1 };
    if (sql.includes("FROM user_links") && sql.includes("SELECT") && !sql.includes("SELECT id")) return { rows: [linkRow as T], rowCount: 1 };
    return { rows: [], rowCount: sql.includes("INSERT INTO user_links") ? 1 : null };
  }
}

describe("Postgres user links", () => {
  it("defines owner-isolated library and canonical URL constraints in migration 0044", async () => {
    const migration = (await loadMigrations()).find((item) => item.id === "0044_user_links");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS user_link_libraries");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS user_links");
    expect(migration?.sql).toContain("UNIQUE (owner_user_id, url)");
    expect(migration?.sql).toContain("REFERENCES users(id) ON DELETE CASCADE");
  });

  it("initializes once under an owner lock and scopes list filters to the owner", async () => {
    const pool = new LinkPool();
    const result = await new PostgresSpaceStore(pool).listUserLinks("user:one", { q: "status", isQuick: true, page: 1, pageSize: 10 });
    expect(result).toEqual({ items: [linkRow], total: 1 });
    expect(pool.calls.filter((call) => call.sql.includes("INSERT INTO user_links") && !call.sql.includes("RETURNING"))).toHaveLength(0);
    const listCalls = pool.calls.filter((call) => call.sql.includes("FROM user_links"));
    expect(listCalls.every((call) => call.sql.includes("owner_user_id"))).toBe(true);
    expect(listCalls.flatMap((call) => call.values)).toContain("user:one");
  });

  it("keeps update and delete owner scoped", async () => {
    const pool = new LinkPool();
    const store = new PostgresSpaceStore(pool);
    expect(await store.updateUserLink("user:one", linkRow.id, { isQuick: false })).toEqual(linkRow);
    expect(await store.deleteUserLink("user:one", linkRow.id)).toEqual(linkRow);
    const mutations = pool.calls.filter((call) => /UPDATE user_links|DELETE FROM user_links/.test(call.sql));
    expect(mutations.every((call) => call.sql.includes("owner_user_id = $1"))).toBe(true);
  });
});
