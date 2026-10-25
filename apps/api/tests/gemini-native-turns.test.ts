import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { geminiNativeTurnsFromRows, geminiTurnActivity, readGeminiNativeTurns, readGeminiTurnDatabase, validGeminiTurnReadIdentity } from "../src/gemini-native-turns.js";
import { findGeminiProcessTree, readPaneStateRecord } from "../src/gemini-session-verification.js";
vi.mock("../src/gemini-session-verification.js", () => ({ findGeminiProcessTree: vi.fn(), readPaneStateRecord: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const id1 = "4318915a-7659-40d8-b8e9-d4b589047068", id2 = "532a9394-bddd-4d9f-a524-d1b8aa722f12";
function integer(n: number): Buffer { const bytes: number[] = []; do { const next = n % 128; n = Math.floor(n / 128); bytes.push(next + (n ? 128 : 0)); } while (n); return Buffer.from(bytes); }
function proto(entries: Array<[number, number | string | Buffer]>): Buffer {
  return Buffer.concat(entries.map(([field, value]) => typeof value === "number"
    ? Buffer.concat([integer(field * 8), integer(value)])
    : Buffer.concat([integer(field * 8 + 2), integer(Buffer.byteLength(value)), Buffer.from(value)])));
}
const at = 1790478250;
function row(idx: number, type: number, id = id1, status = 3, stop = 2, tools = false) {
  const metadata = proto([[1, proto([[1, at + idx]])], [12, id], ...(type === 15 ? [[8, proto([[1, at + idx + 1]])] as [number, Buffer]] : [])]);
  const content = type === 14 ? proto([[2, `Synthetic marker-${id}`]]) : proto([[1, `answer-${id}`], [12, stop], ...(tools ? [[7, proto([[1, "tool"]])] as [number, Buffer]] : [])]);
  return { idx, step_type: type, status, step_format: 0, metadata, step_payload: proto([[1, type], [4, status], [5, metadata], [type === 14 ? 19 : type === 15 ? 20 : 24, content]]) };
}
const decode = (...rows: ReturnType<typeof row>[]) => geminiNativeTurnsFromRows(rows);
it("separates two native turns with exact final responses and native times", () => {
  const turns = decode(row(0, 14), row(1, 15), row(2, 14, id2), row(3, 15, id2));
  expect(turns.map(t => [t.taskId, t.status, t.finalResponse])).toEqual([[id1, "COMPLETED", `answer-${id1}`], [id2, "COMPLETED", `answer-${id2}`]]);
  expect(turns[0]!.timing).toMatchObject({ source: "NATIVE", durationMs: 2000 });
  expect(turns[0]!.modelsUsed).toEqual([]); // Never infer model from pane settings.
});
it("does not treat a DONE quota/retry error as task completion", () => {
  const rows = [row(0, 14), row(1, 17)];
  expect(decode(...rows)[0]).toMatchObject({ status: "UNKNOWN", finalResponse: null, aborted: false });
  expect(decode(...rows, row(2, 15))[0]).toMatchObject({ status: "COMPLETED" });
});
it.each([0, 1, 3, 10, 11, 13, 16])("does not complete on unverified stop reason %s", stop => {
  expect(decode(row(0, 14), row(1, 15, id1, 3, stop))[0]!.status).not.toBe("COMPLETED");
});
it("does not complete on pending tools, partial output or later activity", () => {
  for (const rows of [[row(0, 14), row(1, 15, id1, 3, 2, true)], [row(0, 14), row(1, 15, id1, 2)], [row(0, 14), row(1, 15), row(2, 21, id1, 2)]]) {
    expect(decode(...rows)[0]!.finalResponse).toBeNull();
  }
});
it.each([6, 7, 12])("never recovers a terminal aborted execution %s into success", status => {
  const turns = decode(row(0, 14), row(1, 15, id1, status), row(2, 15));
  expect(geminiTurnActivity(turns, `marker-${id1}`, { markerAtMs: at * 1000 })).toMatchObject({ status: "ABORTED", turnId: id1 });
});
it("binds activity to the exact prompt or saved turn, never the latest reply", () => {
  const turns = decode(row(0, 14), row(1, 15), row(2, 14, id2));
  expect(geminiTurnActivity(turns, `marker-${id1}`, { markerAtMs: at * 1000 })).toMatchObject({ status: "COMPLETED", turnId: id1 });
  expect(geminiTurnActivity(turns, `marker-${id2}`, { markerAtMs: (at + 2) * 1000 })).toMatchObject({ status: "RUNNING", turnId: id2 });
  expect(geminiTurnActivity(turns, "missing", { markerAtMs: at * 1000 })).toMatchObject({ status: "PENDING", turnId: null });
  expect(geminiTurnActivity(turns, `marker-${id1}`, { markerAtMs: at * 1000, turnId: "wrong" })).toMatchObject({ status: "UNAVAILABLE", turnId: null });
  expect(geminiTurnActivity(turns, `marker-${id1}`, { markerAtMs: (at + 60) * 1000 })).toMatchObject({ status: "PENDING" });
});
it("binds client UUID markers by turn timestamp when no explicit inputMarker is passed", () => {
  const turns = decode(row(0, 14), row(1, 15), row(2, 14, id2));
  const uuid1 = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const uuid2 = "b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e";
  expect(geminiTurnActivity(turns, uuid1, { markerAtMs: at * 1000 })).toMatchObject({ status: "COMPLETED", turnId: id1 });
  expect(geminiTurnActivity(turns, uuid2, { markerAtMs: (at + 2) * 1000 })).toMatchObject({ status: "RUNNING", turnId: id2 });
});
it("keeps recovery markers beyond the bounded display title", () => {
  const input = row(0, 14);
  input.step_payload = proto([[1, 14], [4, 3], [5, input.metadata], [19, proto([[2, "x".repeat(3000) + " marker-long"]])]]);
  const turns = decode(input, row(1, 15));
  expect(turns[0]!.title).not.toContain("marker-long");
  expect(geminiTurnActivity(turns, "marker-long", { markerAtMs: at * 1000 })).toMatchObject({ status: "COMPLETED", turnId: id1 });
});
it("requires both final text and a native completion timestamp", () => {
  const noTime = row(1, 15); noTime.metadata = proto([[1, proto([[1, at + 1]])], [12, id1]]);
  expect(decode(row(0, 14), noTime)[0]!.finalResponse).toBeNull();
  const noText = row(1, 15); noText.step_payload = proto([[1, 15], [4, 3], [20, proto([[12, 2]])]]);
  expect(decode(row(0, 14), noText)[0]!.finalResponse).toBeNull();
});
it("rejects unsupported formats, contradictory columns and malformed protobufs", () => {
  for (const bad of [{ ...row(0, 14), step_format: 1 }, { ...row(0, 14), status: 2 }, { ...row(0, 14), metadata: Buffer.from([10, 255, 255]) }]) {
    expect(() => decode(bad)).toThrow();
  }
  expect(decode(row(1, 15))).toEqual([]);
  expect(() => decode(row(0, 14), row(1, 14))).toThrow();
});
async function database() {
  const home = await mkdtemp(join(tmpdir(), "gemini-native-turns-")); roots.push(home);
  const directory = join(home, ".gemini", "antigravity-cli", "conversations"); await mkdir(directory, { recursive: true });
  const path = join(directory, `${id1}.db`), db = new DatabaseSync(path);
  db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, metadata BLOB, step_payload BLOB)");
  const insert = db.prepare("INSERT INTO steps VALUES (?,?,?,?,?,?)");
  for (const r of [row(0, 14), row(1, 15)]) insert.run(r.idx, r.step_type, r.status, r.step_format, r.metadata, r.step_payload);
  db.close(); return { home, path };
}
it("reads completed evidence again after reader reconstruction without writes", async () => {
  const { path } = await database();
  expect(readGeminiTurnDatabase(path)?.[0]).toMatchObject({ taskId: id1, status: "COMPLETED" });
  expect(readGeminiTurnDatabase(path)).toEqual(readGeminiTurnDatabase(path));
  expect(readGeminiTurnDatabase(path + ".missing")).toBeNull();
});
it("requires matching current process pane and session, not a stale pane map", async () => {
  const { home } = await database();
  const process = { pid: 123, home, paneId: "pane:owned", sessionId: "cli_session:owned", conversationId: id1, cmdline: ["agy"] };
  vi.mocked(findGeminiProcessTree).mockResolvedValue(process);
  const input = { rootPid: 123, paneId: "pane:owned", sessionId: "cli_session:owned" };
  expect((await readGeminiNativeTurns(input))?.turns[0]!.status).toBe("COMPLETED");
  expect(await readGeminiNativeTurns({ ...input, sessionId: "cli_session:other" })).toBeNull();
  expect(await readGeminiNativeTurns({ ...input, paneId: "pane:other" })).toBeNull();
  expect(await readGeminiNativeTurns({ ...input, rootPid: null })).toBeNull();
  vi.mocked(findGeminiProcessTree).mockResolvedValue({ ...process, conversationId: undefined });
  expect(await readGeminiNativeTurns(input)).toBeNull();
});
it("validates the fixed launcher identity without accepting paths or arbitrary arguments", () => {
  const input = { paneId: "pane:owned123", sessionId: "cli_session:owned123", rootPid: 123 };
  expect(validGeminiTurnReadIdentity(input)).toBe(true);
  for (const wrong of [{ paneId: "../../etc" }, { sessionId: "x;uname" }, { rootPid: null }, { rootPid: 0 }, { rootPid: 1.5 }]) {
    expect(validGeminiTurnReadIdentity({ ...input, ...wrong })).toBe(false);
  }
});

it("uses a launcher PID hint only after verifying host ancestry and native session identity", async () => {
  const { home } = await database();
  const proc = await mkdtemp(join(tmpdir(), "gemini-native-proc-")); roots.push(proc);
  await mkdir(join(proc, "456")); await writeFile(join(proc, "456", "stat"), "456 (agy) S 123 0 0");
  const record = { pid: 456, paneId: "pane:owned123", sessionId: "cli_session:owned123", conversationId: id2 };
  const native = { pid: 456, home, paneId: record.paneId, sessionId: record.sessionId, conversationId: id1, cmdline: ["agy"] };
  vi.mocked(readPaneStateRecord).mockResolvedValue(record);
  vi.mocked(findGeminiProcessTree).mockImplementation(async pid => pid === 456 ? native : null);
  const input = { rootPid: 123, paneId: record.paneId, sessionId: record.sessionId };
  expect((await readGeminiNativeTurns(input, proc))?.conversationId).toBe(id1);
  expect(await readGeminiNativeTurns({ ...input, rootPid: 789 }, proc)).toBeNull();
  vi.mocked(readPaneStateRecord).mockResolvedValue({ ...record, sessionId: "wrong" });
  expect(await readGeminiNativeTurns(input, proc)).toBeNull();
  vi.mocked(readPaneStateRecord).mockResolvedValue(record);
  vi.mocked(findGeminiProcessTree).mockImplementation(async pid => pid === 456 ? { ...native, sessionId: "wrong" } : null);
  expect(await readGeminiNativeTurns(input, proc)).toBeNull();
});

it("does not abort native turn when a tool execution fails or is cancelled", () => {
  const toolFail = row(1, 132, id1, 6);
  const finish = row(2, 15, id1, 3, 2);
  const turns = decode(row(0, 14), toolFail, finish);
  expect(turns[0]).toMatchObject({ taskId: id1, status: "COMPLETED", aborted: false });
});

it("tracks reactive wakeups (step_type 101) with distinct step UUIDs as continuing the active turn", () => {
  const intermediate = row(1, 15, id1, 3, 2);
  const wakeup = row(2, 101, id2);
  const finalReply = row(3, 15, id2, 3, 2);
  const turns = decode(row(0, 14), intermediate, wakeup, finalReply);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ taskId: id1, status: "COMPLETED", finalResponse: `answer-${id2}` });
});

