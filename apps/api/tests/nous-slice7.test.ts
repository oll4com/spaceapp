// Daily Nous errors 13/11 (slice 7): space_pane_checked picks among several rooms as space_read_pane does; a copilot with nothing open names the brief.
import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

const owner = "user:operator";
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
const room = (id: string, name: string, kind = "WORKSPACE") => ({ id, name, kind, ownerUserId: owner }) as Room;
const pane = (id: string, roomId: string, mode: string) => ({ id, roomId, title: "Bob", paneName: "Bob", mode, isClosed: false }) as unknown as Pane;
const tools = (extra: Partial<NousToolDeps>) => createNousTools(extra as unknown as NousToolDeps);

describe("space_pane_checked with a name open in several other rooms", () => {
  const alpha = room("room:alpha", "Alpha"), bruno = room("room:bruno", "Bruno"), cleo = room("room:cleo", "Cleo"), proof = room("room:proof", "Agent Proof", "AGENT_PROOF");
  const setup = (panes: Record<string, Pane[]>) => {
    const checked = vi.fn(async (_owner: string, _room: Room, target: Pane) => ({ ok: true, display: "Checked", result: `checked ${target.id}` }));
    return { checked, nous: tools({ rooms: async () => [alpha, bruno, cleo, proof], listPanes: async (id: string) => panes[id] ?? [], paneWatch: { checked } as never }) };
  };

  it("checks the only CLI pane of that name outside test rooms, in its own room", async () => {
    const { checked, nous } = setup({ "room:bruno": [pane("pane:bruno-bob", "room:bruno", "TERMINAL")], "room:cleo": [pane("pane:cleo-bob", "room:cleo", "BROWSER")],
      "room:proof": [pane("pane:proof-bob", "room:proof", "TERMINAL")] });
    const answer = await nous.execute("space_pane_checked", { room: "Alpha", pane: "Bob", verdict: "NEEDS_ACTION" }, ctx);
    expect(answer.ok).toBe(true);
    expect(checked).toHaveBeenCalledWith(owner, bruno, expect.objectContaining({ id: "pane:bruno-bob" }), expect.anything());
    expect(answer.result).toContain("the only CLI pane of that name");
  });

  it("keeps the error listing every room and pane when nothing decides", async () => {
    const { checked, nous } = setup({ "room:bruno": [pane("pane:bruno-bob", "room:bruno", "TERMINAL")], "room:cleo": [pane("pane:cleo-bob", "room:cleo", "TERMINAL")] });
    const answer = await nous.execute("space_pane_checked", { room: "Alpha", pane: "Bob", verdict: "NEEDS_ACTION" }, ctx);
    expect(answer.ok).toBe(false);
    expect(answer.result).toContain("pane:bruno-bob");
    expect(answer.result).toContain("pane:cleo-bob");
    expect(checked).not.toHaveBeenCalled();
  });
});

describe("space_copilot_answer when the copilot asks nothing", () => {
  it("answers nothing open, already handled, naming space_copilot_brief (Daily Nous errors 14/11)", async () => {
    const answerQuestion = vi.fn(async () => { throw new Error("The question was not found."); });
    const nous = tools({ copilots: { items: async () => [], answerQuestion } as never, notifications: { closedQuestions: async () => [] } as never });
    const answer = await nous.execute("space_copilot_answer", { copilot: "FREELANCE", question: "Fares for the trip", answer: "Book the cheaper one" }, ctx);
    expect(answer).toMatchObject({ ok: true, display: "Nothing open, already handled" });
    expect(answer.result).toContain("space_copilot_brief");
  });
});

describe("space_memory_recall on an entry from an earlier day", () => {
  const entry = (createdAt: string) => ({ id: "space_memory:a1", createdAt, title: "UpCloud credit", body: "UpCloud credit is EUR 1,000." });
  const recall = async (createdAt: string) => (await tools({ memory: { recall: async () => [entry(createdAt)] } as never })
    .execute("space_memory_recall", { query: "UpCloud credit" }, ctx)).result;

  it("asks to re-check it on its real surface or give its date before stating it as current", async () => {
    expect(await recall("2026-11-12T04:52:00.000Z")).toContain("check it on its real surface now, or give its date");
    expect(await recall(new Date().toISOString())).not.toContain("check it on its real surface");
  });
});

// Slice 8 (13/11): errors that said nothing about the next step now name it.
describe("unknown ids name the call that lists the real ones", () => {
  it("space_request_done with an unknown plan records the Done without it and names space_plans (14/11 ×3 \"No such plan\")", async () => {
    const run = vi.fn(async () => ({ ok: true, display: "Done", result: "recorded" }));
    const nous = tools({ requestDone: { run } as never, plans: { get: async () => null, list: async () => [] } as never });
    const answer = await nous.execute("space_request_done", { request: "Fix it", summary: "Fixed", where: "no code", plan: "clipboard:nothere123" }, ctx);
    expect(answer).toMatchObject({ ok: true, result: "recorded (clipboard:nothere123 is no plan of yours, so this Done carries no plan: name a plan by its clipboard id, space_plans lists them.)" });
    expect(run).toHaveBeenCalledWith(owner, expect.objectContaining({ plan: undefined }), expect.anything());
  });

  it("a plan id a character or two off is the one open plan it fits (13/11 11:47 clipboard:mmeF0-e3x4G for clipboard:mmmeF0-e3x4G)", async () => {
    const run = vi.fn(async () => ({ ok: true, display: "Done", result: "recorded" }));
    const open = [{ id: "clipboard:mmmeF0-e3x4G", source: "PLAN" }, { id: "clipboard:9Gn3d7MS-Ir5", source: "PLAN" }];
    const nous = tools({ requestDone: { run } as never, plans: { get: async (_owner: string, id: string) => open.find((plan) => plan.id === id) ?? null, list: async () => open } as never });
    const done = (plan: string) => nous.execute("space_request_done", { request: "Fix it", summary: "Fixed", where: "no code", plan }, ctx);
    expect((await done("clipboard:mmeF0-e3x4G")).ok).toBe(true);
    expect(run).toHaveBeenLastCalledWith(owner, expect.objectContaining({ plan: "clipboard:mmmeF0-e3x4G" }), expect.anything());
    expect(await done("clipboard:zzzzzz-zzzzz")).toMatchObject({ ok: true, result: expect.stringContaining("is no plan of yours") });
    expect(run).toHaveBeenLastCalledWith(owner, expect.objectContaining({ plan: undefined }), expect.anything());
  });

  it("space_resolve_notification with an unknown id names space_notifications", async () => {
    const nous = tools({ notifications: { resolve: async () => false, list: async () => [] } as never });
    const answer = await nous.execute("space_resolve_notification", { notification: "notification:9ba1c247c64a4f7a8e1d3f05" }, ctx);
    expect(answer).toMatchObject({ ok: false, display: "No such notification" });
    expect(answer.result).toContain("space_notifications lists the open ones");
  });
});
