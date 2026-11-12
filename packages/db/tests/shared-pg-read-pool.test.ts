// 12/11 03:48 UTC on public-host: UPDATEs waiting on WalSync held every connection of the API's shared pool, so getPane and Nous's
// read_pane timed out behind them. A plain read must answer while the write path is saturated.
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpacePgPool, isPlainReadSql } from "../src/space-store.js";

const url = "postgres://space@127.0.0.1:1/shared_read_pool_test";
const options = { socketPath: "/nonexistent/socket" };
const never = new Promise<never>(() => undefined);

/** pg-pool's cap, modelled: a pool whose `max` connections are held by hung writes queues every further query. */
function slowWrites() {
  const held = new Map<object, number>();
  const used: Array<{ pool: object; sql: string }> = [];
  vi.spyOn(pg.Pool.prototype, "query").mockImplementation(function (this: pg.Pool, sql: unknown) {
    const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
    used.push({ pool: this, sql: text });
    const busy = held.get(this) ?? 0;
    if (busy >= (this.options.max ?? 10)) return never;
    if (/^\s*(update|insert|delete)\b|\bupdate\b/i.test(text)) { held.set(this, busy + 1); return never; }
    return Promise.resolve({ rows: [{ id: "pane-1" }], rowCount: 1 });
  } as never);
  return used;
}

const within = <T>(work: Promise<T>, ms = 200) => Promise.race([work, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

describe("shared Space pg pool under slow writes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers a pane read while every write connection waits on a slow disk", async () => {
    const used = slowWrites();
    const pool = createSpacePgPool(url, { ...options, max: 20 });
    try {
      for (let i = 0; i < 25; i += 1) void pool.query("UPDATE space_control_records SET value = $1 WHERE record_key = $2", [{}, `k${i}`]);
      const read = await within(pool.query("SELECT * FROM panes WHERE id = $1", ["pane-1"]));
      expect(read).not.toBe("timeout");
      // Writes, data-modifying CTEs and statements that name a write stay on the write pool.
      void pool.query("WITH u AS (UPDATE users SET role = $1 RETURNING id) SELECT id FROM u", ["ADMIN"]);
      void pool.query({ text: "SELECT updated_at FROM rooms WHERE id = $1", values: ["r"] } as never);
      const writePool = used[0]!.pool;
      expect(used.filter((call) => /^(UPDATE|WITH)/.test(call.sql)).every((call) => call.pool === writePool)).toBe(true);
      expect(used.filter((call) => /^SELECT/.test(call.sql)).every((call) => call.pool !== writePool)).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("sends only plain reads to the read connections", () => {
    expect(isPlainReadSql("  select 1")).toBe(true);
    expect(isPlainReadSql({ text: "WITH x AS (SELECT 1) SELECT * FROM x" })).toBe(true);
    for (const sql of ["SELECT id FROM panes WHERE id = $1 FOR UPDATE", "SELECT nextval('s')", "SELECT pg_advisory_lock(1)",
      "INSERT INTO t VALUES (1)", "WITH d AS (DELETE FROM t RETURNING 1) SELECT 1", null]) expect(isPlainReadSql(sql)).toBe(false);
  });
});
