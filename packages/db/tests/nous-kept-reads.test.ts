// The conversation page, the decisions and the turn facts are read from Postgres once and kept (speed slices 15-16, 14/11); a lone
// message write puts its row on the kept pages (slice 19).
import { describe, expect, it } from "vitest";
import { PostgresNousRepository } from "../src/nous-repository.js";
import type { PgPoolLike } from "../src/space-store.js";

const at = "2026-11-14T00:00:00.000Z";

function fakePool() {
  const messages: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  /** The rows each turn facts read got from the table. */
  const factReads: number[] = [];
  const reads = { messages: 0, decisions: 0 };
  let failNext = false;
  // Each insert is `step` ms after the one before.
  let clock = Date.parse(at);
  let step = 1_000;
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      if (failNext) { failNext = false; throw new Error("connection lost"); }
      if (sql.startsWith("WITH dialogue")) {
        // readMessages' window: the newest dialogue rows, the newest tool rows from the oldest of them on, before the cursor row.
        reads.messages += 1;
        const [owner, limit, tools, before] = values as [string, number, number, string | null];
        const all = messages.filter((row) => row.ownerUserId === owner);
        const mine = before ? all.slice(0, Math.max(all.findIndex((row) => row.id === before), 0)) : all;
        const newest = (rows: typeof mine, most: number) => rows.slice(Math.max(rows.length - most, 0));
        const dialogue = newest(mine.filter((row) => row.kind !== "TOOL"), limit);
        const shown = new Set([...dialogue, ...newest(mine.filter((row) => row.kind === "TOOL" && String(row.createdAt) >= String(dialogue[0]?.createdAt ?? "")), tools)]);
        return { rows: mine.filter((row) => shown.has(row)) };
      }
      if (sql.startsWith("SELECT") && sql.includes("FROM nous_decisions")) { reads.decisions += 1; return { rows: decisions.filter((row) => row.ownerUserId === values[0]) }; }
      if (sql.startsWith("INSERT INTO nous_messages")) {
        const now = new Date(clock += step).toISOString();
        messages.push({ id: values[0], ownerUserId: values[1], turnId: values[2], kind: values[3], status: values[4], content: values[5], meta: JSON.parse(String(values[6])), createdAt: now, updatedAt: now });
        return { rows: [messages.at(-1)] };
      }
      if (sql.startsWith("UPDATE nous_messages SET status = COALESCE")) {
        const row = messages.find((entry) => entry.ownerUserId === values[0] && entry.id === values[1]);
        if (row) Object.assign(row, { status: values[2] ?? row.status, content: values[3] ?? row.content, meta: values[4] ? JSON.parse(String(values[4])) : row.meta });
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith("INSERT INTO nous_decisions")) {
        decisions.push({ id: values[0], ownerUserId: values[1], category: values[2], title: values[3], body: values[4], options: [], recommendation: null, refs: {}, action: null,
          status: "OPEN", answer: null, outcome: null, createdAt: at, answeredAt: null, couldHaveDecided: false });
        return { rows: [decisions.at(-1)] };
      }
      if (sql.startsWith("UPDATE nous_decisions SET status")) {
        const row = decisions.find((entry) => entry.id === values[1])!;
        Object.assign(row, { status: values[2], answer: values[3], answeredAt: at });
        return { rows: [row] };
      }
      if (sql.startsWith("INSERT INTO nous_turn_facts")) {
        turns.push({ turnId: values[0], ownerUserId: values[1], reason: values[2], status: values[3], tools: {}, planPoints: 0, outcomes: [], startedAt: values[7], endedAt: values[8] });
        return { rows: [] };
      }
      if (sql.includes("FROM nous_turn_facts WHERE owner_user_id = $1 AND started_at >= $2")) {
        const rows = turns.filter((row) => row.ownerUserId === values[0] && String(row.startedAt) >= String(values[1])).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
        factReads.push(rows.length);
        return { rows };
      }
      return { rows: [], rowCount: 0 };
    }
  } as unknown as PgPoolLike;
  // The next statement answers only when the test lets it.
  let held: Promise<void> | null = null;
  const holding = { query: (sql: string, values: unknown[]) => { const wait = held; held = null; const result = pool.query(sql, values); return wait ? wait.then(() => result) : result; } } as unknown as PgPoolLike;
  return { pool: holding, reads, factReads, failNext: () => { failNext = true; }, step: (ms: number) => { step = ms; },
    hold: () => { let release = () => {}; held = new Promise<void>((resolve) => { release = resolve; }); return release; } };
}

const message = (ownerUserId: string, content: string) => ({ ownerUserId, turnId: null, kind: "OPERATOR" as const, status: "DONE" as const, content });
const decision = (ownerUserId: string) => ({ ownerUserId, category: "DIRECTION" as const, title: "Ship it?", body: "", options: [], recommendation: null, refs: {}, action: null });

describe("PostgresNousRepository kept reads", () => {
  it("reads a conversation page once per call shape until that owner's messages are written, and hands out copies", async () => {
    const fake = fakePool();
    const store = new PostgresNousRepository(fake.pool);
    await store.addMessage(message("user:a", "one"));
    const [first, second] = await Promise.all([store.listMessages("user:a", 200), store.listMessages("user:a", 200)]);
    expect(fake.reads.messages).toBe(1);
    first[0]!.content = "edited by the caller";
    expect(second.map((row) => row.content)).toEqual(["one"]);
    // Another page of the same owner and another owner are their own reads.
    await store.listMessages("user:a", 1, 0);
    await store.listMessages("user:b", 200);
    expect(fake.reads.messages).toBe(3);

    // A lone write puts its row on the kept page.
    await store.addMessage(message("user:a", "two"));
    expect((await store.listMessages("user:a", 200)).map((row) => row.content)).toEqual(["one", "two"]);
    await store.listMessages("user:b", 200);
    expect(fake.reads.messages).toBe(3);
    // A start's failRunning touches every owner's rows; a failed write may have reached the table.
    await store.failRunning("restarted");
    await store.listMessages("user:b", 200);
    fake.failNext();
    await expect(store.updateMessage("user:b", "nous_msg:missing", { status: "FAILED" })).rejects.toThrow("connection lost");
    await store.listMessages("user:b", 200);
    expect(fake.reads.messages).toBe(5);
  });

  it("holds at most keptRowsMax rows across its kept reads and lets the one read longest ago go first (stable out of memory 15/11)", async () => {
    const fake = fakePool();
    const store = new PostgresNousRepository(fake.pool, 60_000, 4);
    for (const content of ["one", "two", "three"]) await store.addMessage(message("user:a", content));
    await store.listMessages("user:a", 2);
    await store.listMessages("user:a", 1);
    await store.listMessages("user:a", 3);
    // The 2-row read was the oldest of 6 rows held: it left; the others are still kept (and become the newest again).
    expect(fake.reads.messages).toBe(3);
    await store.listMessages("user:a", 3);
    await store.listMessages("user:a", 1);
    expect(fake.reads.messages).toBe(3);
    await store.listMessages("user:a", 2);
    expect(fake.reads.messages).toBe(4);
    // Reading the 2-row page again let the 3-row one (read longest ago) go; the 1-row one stays.
    await store.listMessages("user:a", 1);
    expect(fake.reads.messages).toBe(4);
    await store.listMessages("user:a", 3);
    expect(fake.reads.messages).toBe(5);
  });

  it("puts a lone message write on the kept pages and reads again what the kept rows cannot place", async () => {
    const fake = fakePool();
    const store = new PostgresNousRepository(fake.pool);
    const fresh = new PostgresNousRepository(fake.pool, 0);
    const add = (kind: "OPERATOR" | "ANSWER" | "TOOL", content: string, turnId: string | null = null) => store.addMessage({ ownerUserId: "user:a", turnId, kind, status: "DONE", content });
    /** The table reads the kept pages took; each page (and the dock's look for older rows) is what a new read of the table answers. */
    const reads = async () => {
      const before = fake.reads.messages;
      const pages = [await store.listMessages("user:a", 2, 2), await store.listMessages("user:a", 3, 0), await store.listMessages("user:a", 200)];
      const oldest = pages[0]!.find((row) => row.kind !== "TOOL")?.id ?? "nous_msg:none";
      pages.push(await store.listMessages("user:a", 1, 0, { before: oldest }));
      const took = fake.reads.messages - before;
      expect(pages).toEqual([await fresh.listMessages("user:a", 2, 2), await fresh.listMessages("user:a", 3, 0), await fresh.listMessages("user:a", 200),
        await fresh.listMessages("user:a", 1, 0, { before: oldest })]);
      return took;
    };
    expect(await reads()).toBe(4);
    // Dialogue past the limit, tool rows past theirs and tool rows before the oldest dialogue row leave; only a new cursor is a new read.
    const took: number[] = [];
    await add("TOOL", "before the dialogue");
    took.push(await reads());
    await add("OPERATOR", "q1");
    took.push(await reads());
    for (const step of ["s1", "s2"]) await add("TOOL", step);
    const running = await store.addMessage({ ownerUserId: "user:a", turnId: null, kind: "TOOL", status: "RUNNING", content: "s3" });
    took.push(await reads());
    await store.updateMessage("user:a", running.id, { status: "DONE", content: "s3 done", meta: { result: "ok" } });
    await store.updateMessage("user:a", "nous_msg:missing", { status: "FAILED" });
    took.push(await reads());
    await add("ANSWER", "a1");
    await add("OPERATOR", "q2");
    took.push(await reads());
    expect(took).toEqual([0, 1, 0, 0, 1]);
    expect((await store.listMessages("user:a", 2, 2)).map((row) => row.content)).toEqual(["a1", "q2"]);
    expect((await store.listMessages("user:a", 200)).map((row) => row.content)).toEqual(["q1", "s1", "s2", "s3 done", "a1", "q2"]);

    // Two writes at once, a row of the last one's millisecond (the page without tool rows ends before it) and a failed write: the table knows.
    await Promise.all([add("OPERATOR", "q3"), add("TOOL", "s4")]);
    expect(await reads()).toBe(4);
    // A write that began while another was on its way is not known to be the table's last word either.
    const release = fake.hold();
    const first = store.updateMessage("user:a", running.id, { content: "s3 held" });
    await store.updateMessage("user:a", running.id, { content: "s3 again" });
    expect(await reads()).toBe(4);
    release();
    await first;
    expect(await reads()).toBe(4);
    fake.step(0);
    await add("TOOL", "s5");
    expect(await reads()).toBe(2);
    fake.step(1_000);
    fake.failNext();
    await expect(add("TOOL", "lost")).rejects.toThrow("connection lost");
    expect(await reads()).toBe(4);
    // A read still on its way when the write ends is read again.
    const before = fake.reads.messages;
    await Promise.all([add("OPERATOR", "q4"), store.listMessages("user:a", 7)]);
    await store.listMessages("user:a", 7);
    expect(fake.reads.messages - before).toBe(2);
    // A final answer saved without its model waits for its turn's facts: its pages are read again after every write, as before.
    await reads();
    await add("ANSWER", "no model yet", "nous_turn:t1");
    expect(await reads()).toBe(4);
    await add("TOOL", "s6");
    expect(await reads()).toBe(3);
  });

  it("reads the decisions once per filter until one is created or answered, and forgets a failed read", async () => {
    const fake = fakePool();
    const store = new PostgresNousRepository(fake.pool);
    const asked = await store.createDecision(decision("user:a"));
    await store.listDecisions("user:a", { statuses: ["OPEN"] });
    expect((await store.listDecisions("user:a", { statuses: ["OPEN"] })).map((row) => row.status)).toEqual(["OPEN"]);
    await store.listDecisions("user:a", {});
    expect(fake.reads.decisions).toBe(2);

    await store.answerDecision("user:a", asked.id, { status: "APPROVED", answer: "yes" });
    expect((await store.listDecisions("user:a", {})).map((row) => row.status)).toEqual(["APPROVED"]);
    expect(fake.reads.decisions).toBe(3);

    fake.failNext();
    await expect(store.listDecisions("user:b", {})).rejects.toThrow("connection lost");
    expect(await store.listDecisions("user:b", {})).toEqual([]);
    // Age 0: a row written by another process shows on the next read.
    const fresh = new PostgresNousRepository(fake.pool, 0);
    await fresh.listDecisions("user:a", {});
    await fresh.listDecisions("user:a", {});
    expect(fake.reads.decisions).toBe(6);
  });

  it("keeps an owner's turn facts and reads only the turns started in the last two hours again", async () => {
    const fake = fakePool();
    const store = new PostgresNousRepository(fake.pool);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const turn = (turnId: string, startedAt: string, ownerUserId = "user:a") => ({ turnId, ownerUserId, reason: "OPERATOR" as const, status: "DONE" as const, tools: {}, planPoints: 0,
      outcomes: [], startedAt, endedAt: ago(0), model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null });
    await store.addTurnFacts(turn("turn:month", ago(29 * 1440)));
    await store.addTurnFacts(turn("turn:morning", ago(300)));
    await store.addTurnFacts(turn("turn:other", ago(5), "user:b"));
    const ids = async (since: string, owner = "user:a") => (await store.listTurnFacts(owner, since)).map((row) => row.turnId);

    const whole = await store.listTurnFacts("user:a", ago(30 * 1440));
    expect(whole.map((row) => row.turnId)).toEqual(["turn:month", "turn:morning"]);
    whole[0]!.status = "FAILED";
    // A 20-minute turn that started before the last read is written after it; a narrower window is answered from the kept rows.
    await store.addTurnFacts(turn("turn:long", ago(20)));
    await store.addTurnFacts(turn("turn:new", ago(1)));
    expect((await store.listTurnFacts("user:a", ago(30 * 1440))).map((row) => `${row.turnId} ${row.status}`))
      .toEqual(["turn:month DONE", "turn:morning DONE", "turn:long DONE", "turn:new DONE"]);
    expect(await ids(ago(60))).toEqual(["turn:long", "turn:new"]);
    expect(await ids(ago(60), "user:b")).toEqual(["turn:other"]);
    expect(fake.factReads).toEqual([2, 2, 2, 1]);
    // A wider window and a backfilled old turn are read whole.
    expect(await ids(ago(40 * 1440))).toEqual(["turn:month", "turn:morning", "turn:long", "turn:new"]);
    await store.addTurnFacts(turn("turn:backfill", ago(600)));
    expect(await ids(ago(30 * 1440))).toEqual(["turn:month", "turn:backfill", "turn:morning", "turn:long", "turn:new"]);
    expect(fake.factReads.slice(4)).toEqual([4, 5]);
  });
});
