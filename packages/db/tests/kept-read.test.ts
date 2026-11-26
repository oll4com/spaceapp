// The newest pane report and pane summary per pane are read once and kept; this instance's writes go into the kept answer (speed audit 14/11, slice 25).
import { describe, expect, it } from "vitest";
import { keptRead, withNewest } from "../src/kept-read.js";
import { PostgresNousPaneChecksRepository } from "../src/nous-pane-checks-repository.js";
import { PostgresNousPaneSummariesRepository } from "../src/nous-pane-summaries-repository.js";
import { PostgresPaneReportsRepository } from "../src/pane-reports-repository.js";
import type { PgPoolLike } from "../src/space-store.js";

// A table of one row per write; a read answers the owner's rows (the real statement's DISTINCT ON is the Postgres tests' subject).
function fakePool(row: (owner: string, sequence: number, values: unknown[]) => Record<string, unknown>) {
  const rows: Array<Record<string, unknown> & { owner: string }> = [];
  let reads = 0;
  let failNext = false;
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      const owner = values[0] as string;
      if (failNext) { failNext = false; throw new Error("connection lost"); }
      if (sql.startsWith("SELECT")) {
        reads += 1;
        return { rows: rows.filter((entry) => entry.owner === owner).map((entry) => ({ ...entry })), rowCount: 0 };
      }
      if (sql.startsWith("DELETE")) return { rows: [], rowCount: rows.splice(0).length };
      rows.push({ ...row(owner, rows.length + 1, values), owner });
      return { rows: [{ ...rows.at(-1)! }], rowCount: 1 };
    }
  } as unknown as PgPoolLike;
  return { pool, reads: () => reads, failNext: () => { failNext = true; } };
}
const report = { roomId: "room:r", paneId: "pane:p", at: "2026-11-14T08:00:00.000Z", source: "AUTO" as const, status: "TURN_END" as const, summary: "done" };

describe("keptRead", () => {
  it("shares one read per owner until it is dropped, forgets a failed read and reads again after its age", async () => {
    let reads = 0;
    let fail = false;
    const read = async (owner: string) => { reads += 1; if (fail) { fail = false; throw new Error("lost"); } return `${owner}#${reads}`; };
    const kept = keptRead(read);
    expect(await Promise.all([kept.get("a"), kept.get("a"), kept.get("b")])).toEqual(["a#1", "a#1", "b#2"]);
    kept.drop("a");
    expect(await Promise.all([kept.get("a"), kept.get("b")])).toEqual(["a#3", "b#2"]);
    kept.drop();
    fail = true;
    await expect(kept.get("b")).rejects.toThrow("lost");
    expect(await kept.get("b")).toBe("b#5");
    expect(await kept.get("a")).toBe("a#6");

    const aged = keptRead(read, 0);
    expect([await aged.get("a"), await aged.get("a")]).toEqual(["a#7", "a#8"]);
  });

  it("puts a write in the kept answer, also in a read still under way, and reads again when the change fails", async () => {
    let reads = 0;
    let release = (): void => undefined;
    const kept = keptRead(async () => { reads += 1; await new Promise<void>((resolve) => { release = resolve; }); return [reads]; });
    kept.patch("a", (list) => [...list, 9]);
    const first = kept.get("a");
    kept.patch("a", (list) => [...list, 2]);
    release();
    expect(await first).toEqual([1]);
    expect(await kept.get("a")).toEqual([1, 2]);
    kept.patch("a", () => { throw new Error("bad change"); });
    await expect(kept.get("a")).rejects.toThrow("bad change");
    const again = kept.get("a");
    release();
    expect(await again).toEqual([2]);
  });

  it("keeps the newest row of each key: a new key joins, an older row leaves the kept one, a later id wins a tie", () => {
    const row = (id: string, paneId: string, at: string) => ({ id, paneId, at });
    const rows = [row("5", "pane:a", "2026-11-14T08:00:00.000Z")];
    const newest = (added: ReturnType<typeof row>) => withNewest(rows, added, (entry) => entry.paneId, (entry) => entry.at).map((entry) => entry.id);
    expect(newest(row("6", "pane:b", "2026-11-14T07:00:00.000Z"))).toEqual(["5", "6"]);
    expect(newest(row("6", "pane:a", "2026-11-14T07:00:00.000Z"))).toEqual(["5"]);
    expect(newest(row("6", "pane:a", "2026-11-14T08:00:00.000Z"))).toEqual(["6"]);
    expect(newest(row("10", "pane:a", "2026-11-14T08:00:00.000Z"))).toEqual(["10"]);
  });
});

describe("PostgresPaneReportsRepository.latest", () => {
  it("reads once: an added report goes into the kept answer, a failed write and a prune read again; hands out copies", async () => {
    const fake = fakePool((_owner, sequence, values) => ({ ...report, id: sequence, summary: `report ${sequence}`, planId: values[7] ?? null }));
    const store = new PostgresPaneReportsRepository(fake.pool);
    await store.add("user:a", report);
    const [first, second] = await Promise.all([store.latest("user:a"), store.latest("user:a")]);
    first[0]!.summary = "edited by the caller";
    expect(second.map((entry) => entry.summary)).toEqual(["report 1"]);
    expect((await store.latest("user:a")).map((entry) => entry.summary)).toEqual(["report 1"]);
    expect(fake.reads()).toBe(1);

    await store.add("user:b", report);
    await store.latest("user:a");
    expect(fake.reads()).toBe(1);
    const added = await store.add("user:a", report);
    added.summary = "edited by the caller";
    expect((await store.latest("user:a")).map((entry) => entry.summary)).toEqual(["report 3"]);
    expect(fake.reads()).toBe(1);

    // The newest per plan is kept the same way (the fake answers every row of the owner).
    expect((await store.latestPlans("user:a")).map((entry) => entry.summary)).toEqual(["report 1", "report 3"]);
    await store.add("user:a", { ...report, planId: "clipboard:plan" });
    await store.add("user:a", { ...report, planId: "clipboard:plan" });
    expect((await store.latestPlans("user:a")).map((entry) => entry.summary)).toEqual(["report 1", "report 3", "report 5"]);
    expect((await store.latest("user:a")).map((entry) => entry.summary)).toEqual(["report 5"]);
    expect(fake.reads()).toBe(2);

    fake.failNext();
    await expect(store.add("user:a", report)).rejects.toThrow("connection lost");
    await Promise.all([store.latest("user:a"), store.latestPlans("user:a")]);
    expect(fake.reads()).toBe(4);
    await store.prune("2026-11-15T00:00:00.000Z");
    expect([await store.latest("user:a"), await store.latestPlans("user:a")]).toEqual([[], []]);
    expect(fake.reads()).toBe(6);
  });
});

describe("PostgresNousPaneSummariesRepository.latest", () => {
  it("reads both lists once: added summaries go into the kept lists (the model list only a MODEL line), a prune reads again", async () => {
    const summary = { paneId: "pane:p", roomId: "room:r", fingerprint: "f", line: "line", waitsOn: "NONE" as const, needsOperator: false, until: null, detail: null,
      model: null, source: "FALLBACK" as const, batchId: null, generatedAt: "2026-11-14T08:00:00.000Z", inputReportId: null };
    const fake = fakePool((_owner, sequence, values) => ({ ...summary, id: sequence, line: `line ${sequence}`, source: values[10], tokensIn: null, tokensOut: null }));
    const store = new PostgresNousPaneSummariesRepository(fake.pool);
    await store.add("user:a", [summary]);
    const first = await store.latest("user:a");
    first.any[0]!.line = "edited by the caller";
    expect((await store.latest("user:a")).any.map((entry) => entry.line)).toEqual(["line 1"]);
    expect(fake.reads()).toBe(2);

    await store.add("user:a", [summary, summary]);
    expect(await store.latest("user:a")).toMatchObject({ any: [{ line: "line 3" }], model: [{ line: "line 1" }] });
    await store.add("user:a", [{ ...summary, source: "MODEL" }, { ...summary, paneId: "pane:q" }]);
    expect(await store.latest("user:a")).toMatchObject({ any: [{ line: "line 5" }], model: [{ line: "line 4" }] });
    expect(fake.reads()).toBe(2);
    fake.failNext();
    await expect(store.add("user:a", [summary])).rejects.toThrow("connection lost");
    await store.latest("user:a");
    expect(fake.reads()).toBe(4);
    await store.prune("2026-11-15T00:00:00.000Z");
    expect((await store.latest("user:a")).any).toEqual([]);
    expect(fake.reads()).toBe(6);
  });
});

describe("PostgresNousPaneChecksRepository.list", () => {
  it("reads once per owner, patches recorded checks in place, hands out copies and re-reads after a failed write", async () => {
    const fake = fakePool((_owner, _seq, values) => ({
      paneId: values[1], roomId: values[2], checkedAt: values[3],
      verdict: values[4] ?? null, note: values[5] ?? null, nextCheckAt: values[6] ?? null
    }));
    const store = new PostgresNousPaneChecksRepository(fake.pool);
    await store.record("user:a", { paneId: "pane:1", roomId: "room:r", at: "2026-11-21T10:00:00.000Z" });
    const [first, second] = await Promise.all([store.list("user:a"), store.list("user:a")]);
    first[0]!.note = "mutated by caller";
    expect(second[0]!.note).toBeNull();
    expect(fake.reads()).toBe(1);

    await store.record("user:a", { paneId: "pane:1", roomId: "room:r", at: "2026-11-21T10:05:00.000Z", verdict: { verdict: "OK_WORKING", note: "busy", nextCheckAt: null } });
    await store.record("user:a", { paneId: "pane:2", roomId: "room:r", at: "2026-11-21T10:06:00.000Z" });
    const listed = await store.list("user:a");
    expect(listed.map((entry) => [entry.paneId, entry.verdict])).toEqual([["pane:1", "OK_WORKING"], ["pane:2", null]]);
    expect(fake.reads()).toBe(1);

    fake.failNext();
    await expect(store.record("user:a", { paneId: "pane:1", roomId: "room:r", at: "2026-11-21T10:07:00.000Z" })).rejects.toThrow("connection lost");
    await store.list("user:a");
    expect(fake.reads()).toBe(2);
  });

  it("reads the table again when an overlapping write's patch arrives out of order (DEV3D-013)", async () => {
    const fake = fakePool((_owner, _seq, values) => ({
      paneId: values[1], roomId: values[2], checkedAt: values[3],
      verdict: values[4] ?? null, note: values[5] ?? null, nextCheckAt: values[6] ?? null
    }));
    const store = new PostgresNousPaneChecksRepository(fake.pool);
    await store.list("user:a");
    await store.record("user:a", { paneId: "pane:1", roomId: "room:r", at: "2026-11-21T10:05:00.000Z", verdict: { verdict: "OK_WORKING", note: "newer", nextCheckAt: null } });
    await store.list("user:a");
    expect(fake.reads()).toBe(1);
    await store.record("user:a", { paneId: "pane:1", roomId: "room:r", at: "2026-11-21T10:02:00.000Z", verdict: { verdict: "WAITING_OPERATOR", note: "older", nextCheckAt: null } });
    await store.list("user:a");
    expect(fake.reads()).toBe(2);
  });
});
