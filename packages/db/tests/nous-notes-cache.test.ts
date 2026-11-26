// The owner's notes are read from Postgres once and kept until this instance writes a note (speed audit 14/11).
import { describe, expect, it } from "vitest";
import { PostgresNousRepository } from "../src/nous-repository.js";
import type { PgPoolLike } from "../src/space-store.js";

function fakePool() {
  const notes = new Map<string, { text: string; updatedAt: string }>();
  let reads = 0;
  let failNext = false;
  let nextUpdatedAt: string | null = null;
  const pool = {
    query: async (sql: string, [owner, key, text]: string[]) => {
      if (failNext) { failNext = false; throw new Error("connection lost"); }
      const id = `${owner}\n${key}`;
      if (sql.startsWith("SELECT")) {
        reads += 1;
        if (sql.includes("AND key = $2")) {
          const value = notes.get(`${owner}\n${key}`);
          return { rows: value === undefined ? [] : [{ key, text: value.text, updatedAt: value.updatedAt, createdAt: null }], rowCount: value === undefined ? 0 : 1 };
        }
        const rows = [...notes].filter(([entry]) => entry.startsWith(`${owner}\n`))
          .map(([entry, value]) => ({ key: entry.split("\n")[1], text: value.text, updatedAt: value.updatedAt, createdAt: null }))
          .sort((a, b) => a.key!.localeCompare(b.key!));
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("DELETE")) { notes.delete(id); return { rows: [], rowCount: 1 }; }
      const updatedAt = nextUpdatedAt ?? "2026-11-14T00:00:01.000Z";
      nextUpdatedAt = null;
      // An older updated_at stands for a write that committed first, so the table keeps the newer text.
      const existing = notes.get(id);
      if (!existing || existing.updatedAt <= updatedAt) {
        notes.set(id, { text: text!, updatedAt });
      }
      return { rows: [{ key, text, updatedAt, createdAt: "2026-11-14T00:00:00.000Z" }], rowCount: 1 };
    }
  } as unknown as PgPoolLike;
  return { pool, reads: () => reads, failNext: () => { failNext = true; }, setNextUpdatedAt: (ts: string) => { nextUpdatedAt = ts; }, writeOutside: (owner: string, key: string, text: string) => notes.set(`${owner}\n${key}`, { text, updatedAt: "2026-11-14T00:00:00.000Z" }) };
}

describe("PostgresNousRepository notes cache", () => {
  it("reads an owner's notes once, patches writes in place per owner, serves getNote and hands out copies", async () => {
    const fake = fakePool();
    const store = new PostgresNousRepository(fake.pool);
    await store.setNote("user:a", "b", "two");
    await store.setNote("user:a", "a", "one");
    // Point lookup on a cold cache reads only that key (does not populate the full list).
    expect((await store.getNote("user:a", "b"))?.text).toBe("two");
    expect(fake.reads()).toBe(1);
    const [first, second] = await Promise.all([store.listNotes("user:a"), store.listNotes("user:a")]);
    expect(fake.reads()).toBe(2);
    first.sort((left, right) => left.key.localeCompare(right.key))[0]!.text = "edited by the caller";
    expect(second.map((note) => note.text)).toEqual(["one", "two"]);
    expect((await store.listNotes("user:a")).map((note) => note.text)).toEqual(["one", "two"]);
    // Point lookup on a warm cache needs no DB read.
    expect((await store.getNote("user:a", "a"))?.text).toBe("one");
    expect(fake.reads()).toBe(2);
    expect(await store.listNotes("user:b")).toEqual([]);
    expect(fake.reads()).toBe(3);

    // Speed audit 21/11: setNote patches the cached list in place instead of forcing a full table re-read.
    await store.setNote("user:a", "c", "three");
    expect((await store.listNotes("user:a")).map((note) => note.key)).toEqual(["a", "b", "c"]);
    await store.setNote("user:a", "b", null);
    expect((await store.listNotes("user:a")).map((note) => note.key)).toEqual(["a", "c"]);
    await store.listNotes("user:b");
    expect(fake.reads()).toBe(3);
  });

  it("forgets a failed read, re-reads after a failed write and after the cache's age", async () => {
    const fake = fakePool();
    const store = new PostgresNousRepository(fake.pool, 0);
    fake.failNext();
    await expect(store.listNotes("user:a")).rejects.toThrow("connection lost");
    expect(await store.listNotes("user:a")).toEqual([]);
    // Age 0: a note written by another process shows on the next read.
    fake.writeOutside("user:a", "k", "restored");
    expect((await store.listNotes("user:a")).map((note) => note.text)).toEqual(["restored"]);

    const kept = new PostgresNousRepository(fake.pool);
    await kept.listNotes("user:a");
    const before = fake.reads();
    fake.failNext();
    await expect(kept.setNote("user:a", "k", "new")).rejects.toThrow("connection lost");
    await kept.listNotes("user:a");
    expect(fake.reads()).toBe(before + 1);
  });

  it("reads the table again when an overlapping write's patch arrives out of order (DEV3D-013)", async () => {
    const fake = fakePool();
    const store = new PostgresNousRepository(fake.pool);
    await store.listNotes("user:a");
    fake.setNextUpdatedAt("2026-11-14T00:00:05.000Z");
    await store.setNote("user:a", "k", "B");
    const before = fake.reads();
    expect((await store.getNote("user:a", "k"))?.text).toBe("B");
    // A committed before B (the table keeps B) but its RETURNING resolves after B's.
    fake.setNextUpdatedAt("2026-11-14T00:00:02.000Z");
    await store.setNote("user:a", "k", "A");
    expect((await store.listNotes("user:a")).find((n) => n.key === "k")?.text).toBe("B");
    expect(fake.reads()).toBe(before + 1);
  });
});
