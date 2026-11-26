// 12/11 03:48 UTC on public-host: UPDATEs waiting on WalSync held every connection of the API's shared pool, so getPane and Nous's
// read_pane timed out behind them. A plain read must answer while the write path is saturated.
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpacePgPool, isPlainReadSql, queryLabel, takeQueryRowCounts } from "../src/space-store.js";

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

  // 14/11 on stable: 73 reads (getPane, listRooms, ...) gave up after 5 s in the queue for the 4 read connections while the write
  // pool sat idle; the pane board alone asks 11 reads at once.
  it("lets reads past their four connections borrow free write connections, never the write pool's last four", async () => {
    const inUse = new Map<object, number>();
    const used: object[] = [];
    vi.spyOn(pg.Pool.prototype, "totalCount", "get").mockImplementation(function (this: pg.Pool) { return inUse.get(this) ?? 0; });
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation(function (this: pg.Pool) {
      used.push(this);
      inUse.set(this, (inUse.get(this) ?? 0) + 1);
      return never;
    } as never);
    const pool = createSpacePgPool(url, { ...options, max: 20 });
    try {
      for (let i = 0; i < 30; i += 1) void pool.query("SELECT * FROM panes WHERE id = $1", [`pane-${i}`]);
      const readPool = used[0]!;
      // 4 on the read connections, 16 borrowed, the other 10 wait for a read connection: 4 write connections stay free for writes.
      expect(used.map((at) => (at === readPool ? "r" : "w")).join("")).toBe(`rrrr${"w".repeat(16)}${"r".repeat(10)}`);
      void pool.query("UPDATE panes SET title = $1 WHERE id = $2", ["t", "pane-1"]);
      expect(used.at(-1)).not.toBe(readPool);
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

  // public-host lag 14/11: pg row parsing held the API's loop 3-10 s per 5 min; event_loop.load names the statements that returned the rows.
  it("counts the rows each statement returned, named by verb and first table, never data", async () => {
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation(((sql: unknown) => /fail/.test(String(sql)) ? Promise.reject(new Error("x"))
      : Promise.resolve({ rows: [{}, {}, {}], rowCount: 3 })) as never);
    const pool = createSpacePgPool(url, options);
    try {
      takeQueryRowCounts();
      await pool.query("SELECT * FROM panes WHERE id = $1", ["secret-pane-id"]);
      await pool.query({ text: "select extract(epoch from now()) as t, p.* from \"pane_cli_sessions\" p" } as never);
      await pool.query("UPDATE panes SET title = $1 RETURNING id", ["t"]);
      await expect(pool.query("SELECT fail FROM panes")).rejects.toThrow("x");
      expect(takeQueryRowCounts()).toEqual({ "select panes": 3, "select pane_cli_sessions": 3, "update panes": 3 });
      expect(takeQueryRowCounts()).toEqual({});
      expect(queryLabel("INSERT INTO turn_facts (a) VALUES ($1) ON CONFLICT DO UPDATE SET a = 1")).toBe("insert turn_facts");
      expect(queryLabel("WITH x AS (SELECT 1 FROM rooms) SELECT * FROM x")).toBe("with rooms");
      expect(queryLabel(null)).toBe("?");
    } finally {
      await pool.end();
    }
  });
});
