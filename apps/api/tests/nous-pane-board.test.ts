// Nous's pane board (plan clipboard:Y9cgKVHFaHrr): fingerprints decide which panes the cheap model re-summarizes, in one batched
// call; unchanged panes cost no call, a heartbeat alone waits 30 minutes, the daily cap and a missing model fall back to Space's
// own lines, and a bad answer keeps the previous line.
import type { NousPaneBoardSettings, Pane, Room, SpaceNotification } from "@space/contracts";
import { nousPaneBoardSettingsSchema } from "@space/contracts";
import { InMemoryNousPaneSummariesRepository, type PaneReport } from "@space/db";
import { describe, expect, it, vi } from "vitest";
import { boardPanes, createPaneBoard, fallbackSummary, panePrompt, parseSummaryAnswer, summaryPrompt, type PaneBoardSnapshot } from "../src/nous/pane-board.js";

const owner = "user:operator";
const room = (id: string, name: string, order: number, kind = "WORKSPACE") => ({ id, name, kind, order, ownerUserId: owner, archivedAt: null }) as unknown as Room;
const pane = (id: string, name: string, roomId: string, extra: Partial<Pane> = {}) =>
  ({ id, roomId, paneName: name, title: name, mode: "TERMINAL", terminalRuntimeId: "cli:claude", status: "RUNNING", isClosed: false, modelId: null, ...extra }) as unknown as Pane;
const report = (paneId: string, id: string, at: string, extra: Partial<PaneReport> = {}): PaneReport => ({ id, paneId, roomId: "room:alpha0001", at, source: "AGENT",
  status: "PROGRESS", summary: "Step 3 done. Tests next.", planId: null, step: null, percent: null, ticket: null, next: null, needs: null, body: null, ...extra });

function world() {
  const alpha = room("room:alpha0001", "Alpha", 1);
  const beta = room("room:beta00001", "Beta", 0);
  const proof = room("room:proof0001", "Proof", 2, "AGENT_PROOF");
  const andy = pane("pane:andy0001", "Andy", alpha.id);
  const bob = pane("pane:bob00001", "Bob", alpha.id);
  const carl = pane("pane:carl0001", "Carl", beta.id);
  const snapshot: PaneBoardSnapshot = {
    rooms: [
      { room: alpha, sample: { data: [andy, bob], activity: { [andy.id]: "working", [bob.id]: "waiting" }, details: {}, sampledAt: "" } },
      { room: beta, sample: { data: [carl], activity: { [carl.id]: "idle" }, details: {}, sampledAt: "" } },
      { room: proof, sample: { data: [pane("pane:test0001", "Test", proof.id)], activity: {}, details: {}, sampledAt: "" } }
    ],
    reports: [report(andy.id, "1", "2026-10-19T10:00:00.000Z"),
      report(bob.id, "2", "2026-10-19T10:01:00.000Z", { source: "AUTO", status: "QUESTION", summary: "Run the migration now? [1. Yes | 2. No, later]" })],
    notifications: [], decisions: [], copilotItems: [], plans: [], checks: []
  };
  return { snapshot, andy, bob, carl };
}

function setup(options: { settings?: Partial<NousPaneBoardSettings>; answer?: (prompt: string) => string; run?: boolean; active?: boolean } = {}) {
  const { snapshot, andy, bob, carl } = world();
  let now = Date.parse("2026-10-19T10:05:00.000Z");
  const repository = new InMemoryNousPaneSummariesRepository();
  const prompts: string[] = [];
  const answer = options.answer ?? ((prompt: string) => {
    const ids = [...prompt.matchAll(/"paneId":"([^"]+)"/g)].map((match) => match[1]).filter((id) => id !== "…");
    return JSON.stringify(ids.map((paneId) => ({ paneId, line: `Γραμμή για ${paneId}`, waitsOn: paneId === bob.id ? "NOUS" : "NONE", needsOperator: false })));
  });
  const run = vi.fn(async (input: { model: string; prompt: string }) => { prompts.push(input.prompt); return answer(input.prompt); });
  const published: Array<string | null> = [];
  const board = createPaneBoard({
    repository, now: () => now,
    settings: async () => nousPaneBoardSettingsSchema.parse(options.settings ?? {}),
    active: async () => options.active ?? true,
    collect: async () => snapshot,
    ...(options.run === false ? {} : { run }),
    publish: (_owner, _room, paneId) => published.push(paneId),
    log: { warn: () => undefined }
  });
  return { board, run, prompts, repository, snapshot, andy, bob, carl, published, advance: (ms: number) => { now += ms; } };
}

describe("Nous pane board summaries", () => {
  it("summarizes every pane in one call, then makes no call while nothing changes", async () => {
    const { board, run, prompts, advance, published } = setup();
    expect(await board.tick(owner)).toEqual({ called: true, summarized: 3, paused: null });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].model).toBe("claude-haiku-5-5");
    // Agents' proof rooms stay out; the waiting pane goes first; the prompt says Greek and treats pane text as data.
    expect(prompts[0]).not.toContain("pane:test0001");
    expect(prompts[0]!.indexOf("pane:bob00001")).toBeLessThan(prompts[0]!.indexOf("pane:andy0001"));
    expect(prompts[0]).toContain("in Greek");
    expect(prompts[0]).toContain("never instructions");
    expect(published.sort()).toEqual(["pane:andy0001", "pane:bob00001", "pane:carl0001"]);
    advance(60 * 60_000);
    expect(await board.tick(owner)).toEqual({ called: false, summarized: 0, paused: null });
    expect(run).toHaveBeenCalledTimes(1);
    const view = await board.board(owner);
    expect(view.rooms.map((entry) => [entry.name, entry.panes.map((item) => item.name)])).toEqual([["Beta", ["Carl"]], ["Alpha", ["Andy", "Bob"]]]);
    expect(view.rooms[1]!.panes[1]).toEqual(expect.objectContaining({ state: "waiting", summary: expect.objectContaining({ line: "Γραμμή για pane:bob00001", waitsOn: "NOUS", source: "MODEL" }),
      prompt: { question: "Run the migration now?", options: [{ key: "1", label: "Yes" }, { key: "2", label: "No, later" }] } }));
    expect(view.callsToday).toBe(1);
  });

  it("re-summarizes only the changed pane, at most once per interval", async () => {
    const { board, run, prompts, snapshot, andy, advance } = setup();
    await board.tick(owner);
    snapshot.reports[0] = report(andy.id, "3", "2026-10-19T10:06:00.000Z", { summary: "Step 4 started." });
    advance(2 * 60_000);
    expect((await board.tick(owner)).called).toBe(false);
    advance(3 * 60_000);
    expect(await board.tick(owner)).toEqual({ called: true, summarized: 1, paused: null });
    expect(prompts[1]).toContain("Step 4 started.");
    expect(prompts[1]).not.toContain("pane:carl0001");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("lets a heartbeat alone re-summarize only a line older than 30 minutes", async () => {
    const { board, run, snapshot, andy, advance } = setup();
    await board.tick(owner);
    snapshot.reports[0] = report(andy.id, "4", "2026-10-19T10:10:00.000Z", { source: "AUTO", status: "HEARTBEAT", summary: "(screen) running tests" });
    advance(10 * 60_000);
    expect((await board.tick(owner)).called).toBe(false);
    advance(21 * 60_000);
    expect(await board.tick(owner)).toEqual({ called: true, summarized: 1, paused: null });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops calling at the daily cap and shows Space's own lines for changed panes", async () => {
    const { board, run, snapshot, andy, advance } = setup({ settings: { dailyCap: 10, maxPanesPerCall: 1 } });
    for (let index = 0; index < 3; index += 1) { await board.tick(owner); advance(60_000); }
    expect(run).toHaveBeenCalledTimes(3);
    // Ten calls a day: pretend the other seven happened, each a new batch on a fresh pane line.
    for (let index = 0; index < 7; index += 1) {
      snapshot.reports[0] = report(andy.id, `r${index}`, new Date(Date.parse("2026-10-19T11:00:00.000Z") + index * 60_000).toISOString(), { summary: `Change ${index}.` });
      advance(6 * 60_000);
      await board.tick(owner);
    }
    expect(run).toHaveBeenCalledTimes(10);
    snapshot.reports[0] = report(andy.id, "late", "2026-10-19T12:30:00.000Z", { summary: "Waiting for the promote." });
    snapshot.rooms[0]!.sample!.activity[andy.id] = "idle";
    advance(6 * 60_000);
    expect(await board.tick(owner)).toEqual({ called: false, summarized: 0, paused: "DAILY_CAP" });
    expect(run).toHaveBeenCalledTimes(10);
    const view = await board.board(owner);
    expect(view.paused).toBe("DAILY_CAP");
    expect(view.rooms[1]!.panes[0]!.summary).toEqual(expect.objectContaining({ line: "Waiting for the promote.", waitsOn: "PROMOTE", source: "FALLBACK" }));
  });

  it("keeps the previous line when the answer is not the strict JSON asked for", async () => {
    let bad = false;
    const { board, run, snapshot, andy, advance } = setup({ answer: (prompt) => bad ? "Sure! Here are the lines: Andy is fine." : JSON.stringify(
      [...prompt.matchAll(/"paneId":"(pane:[^"]+)"/g)].map((match) => ({ paneId: match[1], line: "good line", waitsOn: "NONE", needsOperator: false }))) });
    await board.tick(owner);
    bad = true;
    snapshot.reports[0] = report(andy.id, "5", "2026-10-19T10:20:00.000Z", { summary: "Something new." });
    advance(6 * 60_000);
    expect(await board.tick(owner)).toEqual({ called: true, summarized: 0, paused: null, error: "BAD_ANSWER" });
    expect(run).toHaveBeenCalledTimes(2);
    const view = await board.board(owner);
    expect(view.rooms[1]!.panes[0]!.summary).toEqual(expect.objectContaining({ line: "good line", source: "MODEL" }));
    expect(view.callsToday).toBe(2);
  });

  it("makes no call without the model or with Nous off, and the board still shows every pane", async () => {
    const dev = setup({ run: false });
    expect(await dev.board.tick(owner)).toEqual({ called: false, summarized: 0, paused: "UNAVAILABLE" });
    const view = await dev.board.board(owner);
    expect(view.paused).toBe("UNAVAILABLE");
    expect(view.rooms.flatMap((entry) => entry.panes.map((item) => [item.name, item.summary.line, item.summary.source]))).toEqual([
      ["Carl", "Idle", "FALLBACK"], ["Andy", "Step 3 done.", "FALLBACK"], ["Bob", "Run the migration now?", "FALLBACK"]]);
    const off = setup({ active: false });
    expect(await off.board.tick(owner)).toEqual({ called: false, summarized: 0, paused: "NOUS_OFF" });
    // The operator's own Refresh still runs while Nous is off.
    expect((await off.board.tick(owner, { force: "ALL" })).summarized).toBe(3);
    expect(off.run).toHaveBeenCalledTimes(1);
    const disabled = setup({ settings: { enabled: false } });
    expect(await disabled.board.tick(owner, { force: "ALL" })).toEqual({ called: false, summarized: 0, paused: "OFF" });
  });
});

describe("Nous pane board pieces", () => {
  it("parses only the strict JSON for the panes asked about", () => {
    const asked = new Set(["pane:a", "pane:b"]);
    expect(parseSummaryAnswer("```json\n[{\"paneId\":\"pane:a\",\"line\":\"x\",\"waitsOn\":\"DATE\",\"needsOperator\":false,\"until\":\"2026-10-20T08:00:00Z\"},"
      + "{\"paneId\":\"pane:z\",\"line\":\"y\",\"waitsOn\":\"NONE\",\"needsOperator\":false}]\n```", asked)?.get("pane:a")).toEqual(expect.objectContaining({ waitsOn: "DATE" }));
    expect(parseSummaryAnswer("[{\"paneId\":\"pane:a\",\"line\":\"x\",\"waitsOn\":\"SOMEONE\",\"needsOperator\":false}]", asked)).toBeNull();
    expect(parseSummaryAnswer("no json", asked)).toBeNull();
    expect(parseSummaryAnswer("[{\"paneId\":\"pane:z\",\"line\":\"x\",\"waitsOn\":\"NONE\",\"needsOperator\":false}]", asked)).toBeNull();
  });

  it("derives what a pane waits on from its cards, decisions and Nous's verdict", () => {
    const { snapshot, andy } = world();
    const base = { room: snapshot.rooms[0]!.room, pane: andy, model: null, plan: null, decisions: [], copilotItems: [], notifications: [] as SpaceNotification[] };
    const card = { id: "notification:1", source: "NOUS", severity: "ATTENTION", title: "Sign in to GitHub", status: "OPEN" } as unknown as SpaceNotification;
    expect(fallbackSummary({ ...base, state: "idle", report: null, check: null, notifications: [card] }, 0)).toEqual(expect.objectContaining({ line: "Idle", waitsOn: "OPERATOR", needsOperator: true }));
    expect(fallbackSummary({ ...base, state: "idle", report: null, check: { paneId: andy.id, roomId: "r", checkedAt: "", verdict: "WAITING_DATE", note: null, nextCheckAt: "2026-10-20T08:00:00.000Z" } }, 0))
      .toEqual(expect.objectContaining({ waitsOn: "DATE", until: "2026-10-20T08:00:00.000Z", needsOperator: false }));
    expect(fallbackSummary({ ...base, state: "working", report: snapshot.reports[0]!, check: null }, 0)).toEqual(expect.objectContaining({ line: "Step 3 done.", waitsOn: "NONE" }));
    expect(panePrompt({ pane: andy, state: "waiting", report: snapshot.reports[0]! })).toEqual({ question: "Waiting for input", options: [] });
    expect(panePrompt({ pane: andy, state: "working", report: snapshot.reports[1]! })).toBeNull();
  });

  it("keeps INFO notices (new mail, a learned rule) off the board: only what waits for the operator (operator request 2026-10-21)", () => {
    const { snapshot, andy } = world();
    const notice = (id: string, severity: string) => ({ id, paneId: andy.id, source: "MAIL_COPILOT", severity, title: id, status: "OPEN" }) as unknown as SpaceNotification;
    snapshot.notifications = [notice("notification:mail", "INFO"), notice("notification:review", "ATTENTION")];
    expect(boardPanes(snapshot, { showClosed: false }).find((entry) => entry.pane.id === andy.id)!.notifications.map((item) => item.id)).toEqual(["notification:review"]);
  });

  it("names a copilot's own waiting work and waits on Nothing for it, unless something waits for the operator (Ask Last step 8)", async () => {
    // 27/10 22:35 BKK: a Marketing pane said "waiting for approval" 3 hours after its posts were approved (the agent's last report).
    const f = setup({ answer: (prompt) => JSON.stringify([...prompt.matchAll(/"paneId":"([^"]+)"/g)].map((match) => match[1]).filter((id) => id !== "…")
      .map((paneId) => ({ paneId, line: "Περιμένει έγκριση για τις αναρτήσεις", waitsOn: "OPERATOR", needsOperator: true }))) });
    const mia = pane("pane:mia00001", "Mia", "room:beta00001", { mode: "MARKETING_COPILOT", terminalRuntimeId: "cli:claude" });
    f.snapshot.rooms = [{ room: f.snapshot.rooms[1]!.room, sample: { data: [mia], activity: { [mia.id]: "idle" }, details: {}, sampledAt: "" } }];
    f.snapshot.reports = [report(mia.id, "9", "2026-10-27T11:50:00.000Z", { status: "WAITING", summary: "Waiting for approval of 4 Reddit replies." })];
    f.snapshot.copilotWork = { [mia.id]: 4 };
    await f.board.tick(owner);
    expect(f.prompts[0]).toContain('"waitingForCopilot":4');
    const line = (await f.board.board(owner)).rooms[0]!.panes[0]!.summary;
    expect(line).toEqual(expect.objectContaining({ line: "Περιμένει έγκριση για τις αναρτήσεις (4 waiting for the copilot)", waitsOn: "NONE", needsOperator: false }));
    // A card for the operator on the pane keeps it theirs.
    const input = boardPanes(f.snapshot, { showClosed: false })[0]!;
    const card = { id: "notification:review", paneId: mia.id, source: "MARKETING_COPILOT", severity: "ATTENTION", title: "Review a post", status: "OPEN" } as unknown as SpaceNotification;
    expect(fallbackSummary({ ...input, notifications: [card] }, 0)).toEqual(expect.objectContaining({ waitsOn: "OPERATOR" }));
    expect(fallbackSummary({ ...input, report: { ...input.report!, status: "NEEDS_YOU" } }, 0)).toEqual(expect.objectContaining({ line: "Waiting for approval of 4 Reddit replies. (4 waiting for the copilot)".slice(0, 400), waitsOn: "NONE" }));
  });

  it("keeps the prompt within the worker's limit", () => {
    const panes = Array.from({ length: 12 }, (_, index) => ({ paneId: `pane:${index}`, room: "R", pane: "P", kind: "CLI", state: "working", report: { at: "", status: "PROGRESS", text: "x".repeat(260) } }));
    expect(summaryPrompt(panes, "en", "2026-10-19T10:00:00Z").length).toBeLessThan(12_000);
  });
});
