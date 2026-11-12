import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { InMemoryNousPaneChecksRepository } from "@space/db";
import { createNousPaneWatch, paneCheckedText, waitsOnOperatorClaim, paneRoundLine, paneWatchEntries, paneWatchOverview, renderPanesNotChecked } from "../src/nous/pane-watch.js";
import { renderNousWorld } from "../src/nous/digest.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

// Nous's pane watch (plan clipboard:MAongwnxq9Ro).
const owner = "user:operator";
const now = Date.parse("2026-10-17T16:00:00.000Z");
const room = (id: string, name: string, kind = "WORKSPACE") => ({ id, name, kind, ownerUserId: owner, archivedAt: null }) as unknown as Room;
const pane = (id: string, name: string, extra: Partial<Pane> = {}) => ({ id, roomId: "room:bruno0001", paneName: name, title: name, mode: "TERMINAL", isClosed: false, ...extra }) as unknown as Pane;
const bruno = room("room:bruno0001", "Bruno");
const proof = room("room:proof0001", "Agent Proof", "AGENT_PROOF");
const andy = pane("pane:andy0001", "Andy");
const bob = pane("pane:bob00001", "Bob");
const cody = pane("pane:cody0001", "Cody");
const dana = pane("pane:dana0001", "Dana");
const sample = (panes: Pane[], activity: Record<string, string>) => ({ data: panes, activity, details: {}, sampledAt: new Date(now).toISOString() }) as never;
const clock = (iso: string) => iso.slice(11, 16);
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("Nous's pane watch", () => {
  it("is due when never checked, after 30 minutes (60 while working) or at its next check; proof rooms and closed panes are left out", () => {
    const entries = paneWatchEntries([
      { room: bruno, sample: sample([andy, bob, cody, dana, pane("pane:gone0001", "Gone", { isClosed: true })], { "pane:bob00001": "working", "pane:cody0001": "idle", "pane:dana0001": "waiting" }) },
      { room: proof, sample: sample([pane("pane:test0001", "Test")], {}) },
      { room: room("room:dark0001", "Dark"), sample: null }
    ], [
      { paneId: bob.id, roomId: bruno.id, checkedAt: minutesAgo(45), verdict: "OK_WORKING", note: null, nextCheckAt: null },
      { paneId: cody.id, roomId: bruno.id, checkedAt: minutesAgo(45), verdict: null, note: null, nextCheckAt: null },
      { paneId: dana.id, roomId: bruno.id, checkedAt: minutesAgo(45), verdict: "WAITING_DATE", note: "Visa on 20 Oct", nextCheckAt: minutesAgo(-120) }
    ], now);
    expect(entries.map((entry) => [entry.pane.paneName, entry.overdue])).toEqual([["Andy", true], ["Bob", false], ["Cody", true], ["Dana", false]]);
    expect(paneCheckedText(entries[1], clock)).toBe("checked 15:15 (ok working)");
    expect(paneCheckedText(entries[0], clock)).toBe("never checked");
    expect(renderPanesNotChecked(entries, clock).split("\n")).toEqual([
      "## Panes not checked (never checked or due: read each, then record it with space_pane_checked)",
      "- Bruno/Andy · never checked",
      "- Bruno/Cody · idle · checked 15:15, due 15:45"
    ]);
    expect(paneRoundLine(entries)).toBe("Pane round due: 2 panes overdue (Bruno/Andy, Bruno/Cody).");
    expect(paneRoundLine(entries.filter((entry) => !entry.overdue))).toBeNull();
    // Every overdue pane is named (until 31/10 the first 10 and "…").
    const many = Array.from({ length: 12 }, () => entries[0]!);
    expect(paneRoundLine(many)).toBe(`Pane round due: 12 panes overdue (${Array(12).fill("Bruno/Andy").join(", ")}).`);
    expect(paneWatchOverview(entries)[3]).toMatchObject({ pane: "Dana", room: "Bruno", verdict: "WAITING_DATE", note: "Visa on 20 Oct", overdue: false });
    const world = renderNousWorld({ rooms: [{ room: bruno, sample: sample([andy], {}) }], notifications: [], plans: [], tasks: [], trains: "", decisions: [], notes: [],
      now: new Date(now).toISOString(), paneChecked: () => "checked 15:15 (ok working)", panesNotChecked: "## Panes not checked\n- Bruno/Andy · never checked" });
    expect(world).toContain("- Andy · shell (no AI CLI: read it, never send to it) · checked 15:15 (ok working)");
    expect(world).toContain("## Panes not checked\n- Bruno/Andy · never checked");
  });

  it("records every read and the verdicts Nous gives, only on the owner's panes", async () => {
    const repository = new InMemoryNousPaneChecksRepository();
    const watch = createNousPaneWatch({ repository, now: () => now });
    const roomTool = vi.fn(async () => ({ ok: true, display: "Read Andy's screen", result: "screen" }));
    const tools = createNousTools({ paneWatch: watch, roomTool, rooms: async (who: string) => who === owner ? [bruno] : [], listPanes: async () => [andy, bob] } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "nous_turn:w1", callId: "toolu_w", traceId: "trace:w" };

    await tools.execute("space_read_pane", { room: "Bruno", pane: "Andy" }, ctx);
    await tools.execute("space_inspect", { room: "Bruno", arguments: { section: "CONTENT", paneId: bob.id } }, ctx);
    await tools.execute("space_inspect", { room: "Bruno", arguments: { section: "CONTENT", paneId: "pane:other001" } }, ctx);
    expect((await repository.list(owner)).map((check) => [check.paneId, check.checkedAt, check.verdict]).sort())
      .toEqual([[andy.id, new Date(now).toISOString(), null], [bob.id, new Date(now).toISOString(), null]]);

    expect(await tools.execute("space_pane_checked", { room: "Bruno", pane: "Andy", verdict: "OPERATOR_TEST", note: "The operator's login test" }, ctx))
      .toMatchObject({ ok: true, display: "Checked Andy in Bruno: operator test" });
    expect((await tools.execute("space_pane_checked", { room: "Bruno", pane: "Bob", verdict: "WAITING_DATE" }, ctx)).result).toContain("needs nextCheckInMinutes");
    await tools.execute("space_pane_checked", { room: "Bruno", pane: "Bob", verdict: "WAITING_DATE", nextCheckInMinutes: 90 }, ctx);
    const checks = new Map((await repository.list(owner)).map((check) => [check.paneId, check]));
    expect(checks.get(andy.id)).toMatchObject({ verdict: "OPERATOR_TEST", note: "The operator's login test", nextCheckAt: null });
    expect(checks.get(bob.id)).toMatchObject({ verdict: "WAITING_DATE", nextCheckAt: new Date(now + 90 * 60_000).toISOString() });
    // KEEP_OPEN (standing orders 2026-10-21): a finished pane Nous keeps open says why; with no next check it looks again in 30 minutes
    // (2026-11-06 REVIEW: 10 of 18 failed checks were KEEP_OPEN without nextCheckInMinutes).
    expect(await tools.execute("space_pane_checked", { room: "Bruno", pane: "Bob", verdict: "KEEP_OPEN", note: "Waits for the promote" }, ctx))
      .toMatchObject({ ok: true, result: `Recorded; next check ${new Date(now + 30 * 60_000).toISOString()}.` });
    expect(await tools.execute("space_pane_checked", { room: "Bruno", pane: "Bob", verdict: "KEEP_OPEN", note: "Waits for the promote", nextCheckInMinutes: 120 }, ctx))
      .toMatchObject({ ok: true, display: "Checked Bob in Bruno: keep open" });
    const kept = (await repository.list(owner)).find((check) => check.paneId === bob.id);
    expect(kept).toMatchObject({ verdict: "KEEP_OPEN", note: "Waits for the promote", nextCheckAt: new Date(now + 120 * 60_000).toISOString() });
    expect(paneCheckedText({ room: bruno, pane: bob, state: "done", check: kept!, dueAt: kept!.nextCheckAt!, overdue: false }, clock)).toBe("checked 16:00 (keep open), keep open");
    // A later read keeps the verdict and moves only the time.
    await watch.read(owner, bruno.id, andy.id);
    expect((await repository.list(owner)).find((check) => check.paneId === andy.id)).toMatchObject({ verdict: "OPERATOR_TEST" });
    // The operator's own pane is closed only while "Close your own panes too" is on (2026-10-24, on by default).
    let mayClose = false;
    const closer = createNousTools({ paneWatch: watch, roomTool, rooms: async () => [bruno], listPanes: async () => [andy, bob], closeOperatorPanes: async () => mayClose } as unknown as NousToolDeps);
    expect(await closer.execute("space_close_pane", { room: "Bruno", panes: ["Andy"] }, ctx)).toMatchObject({ ok: false, display: "The operator's own pane stays open" });
    expect(roomTool).not.toHaveBeenCalledWith("close_pane", expect.anything(), expect.anything());
    mayClose = true;
    expect((await closer.execute("space_close_pane", { room: "Bruno", panes: ["Andy"] }, ctx)).ok).toBe(true);
    expect(roomTool).toHaveBeenCalledWith("close_pane", { panes: [andy.id] }, expect.anything());
    expect((await tools.execute("space_pane_checked", { room: "Bruno", pane: "Andy", verdict: "OK_WORKING" }, { ...ctx, owner: "user:other" })).ok).toBe(false);
    expect((await tools.execute("space_pane_checked", { room: "Bruno", pane: "Andy", verdict: "FINE" }, ctx)).ok).toBe(false);
  });

  it("checks a pane named in a room that holds it closed twice where exactly one other room has it open; several open keep the error (13/11 review)", async () => {
    const repository = new InMemoryNousPaneChecksRepository();
    const cleo = room("room:cleo00001", "Cleo");
    const dino = room("room:dino00001", "Dino");
    const max = pane("pane:max00001", "Max", { roomId: cleo.id });
    const closedTwice = ["pane:max00002", "pane:max00003", "pane:eve00003", "pane:eve00004"].map((id) => pane(id, id.includes("max") ? "Max" : "Eve", { isClosed: true }));
    const panes: Record<string, Pane[]> = { [bruno.id]: [andy, ...closedTwice], [cleo.id]: [max, pane("pane:eve00001", "Eve", { roomId: cleo.id })], [dino.id]: [pane("pane:eve00002", "Eve", { roomId: dino.id })] };
    const tools = createNousTools({ paneWatch: createNousPaneWatch({ repository, now: () => now }), inspectPane: async () => null, rooms: async () => [bruno, cleo, dino],
      listPanes: async (roomId: string) => panes[roomId] ?? [] } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "nous_turn:w2", callId: "toolu_w2", traceId: "trace:w2" };
    expect(await tools.execute("space_pane_checked", { room: "Bruno", pane: "Max", verdict: "OPERATOR_TEST", note: "Login test" }, ctx))
      .toMatchObject({ ok: true, result: expect.stringContaining('(No open pane "Max" in Bruno: checked Max in Cleo; name that room next time.)') });
    expect(await repository.list(owner)).toMatchObject([{ paneId: max.id, roomId: cleo.id, verdict: "OPERATOR_TEST" }]);
    expect(await tools.execute("space_pane_checked", { room: "Bruno", pane: "Eve", verdict: "OPERATOR_TEST", note: "Login test" }, ctx))
      .toMatchObject({ ok: false, result: expect.stringContaining('"Eve" is open in Cleo (pane:eve00001), Dino (pane:eve00002)') });
  });

  it("operator 8/11 20:04 BKK: KEEP_OPEN because the pane waits for the operator needs their Needs you card or an open decision on it", async () => {
    expect(waitsOnOperatorClaim("Cloud Identity: waits on the operator's SMS code")).not.toBeNull();
    expect(waitsOnOperatorClaim("Waits for the promote")).toBeNull();
    const repository = new InMemoryNousPaneChecksRepository();
    let cards: unknown[] = [];
    let decisions: unknown[] = [];
    const tools = createNousTools({ paneWatch: createNousPaneWatch({ repository, now: () => now }), rooms: async () => [bruno], listPanes: async () => [andy, bob],
      paneNeeds: async () => cards, decisions: async (_who: string, _limit?: number, statuses?: string[]) => statuses?.includes("OPEN") ? decisions : [] } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "nous_turn:w2", callId: "toolu_k", traceId: "trace:k" };
    const keep = (note: string) => tools.execute("space_pane_checked", { room: "Bruno", pane: "Andy", verdict: "KEEP_OPEN", note }, ctx);
    expect(await keep("Iris: το πλάνο Cloud Identity περιμένει δικές σου ενέργειες")).toMatchObject({ ok: false, refused: true,
      result: expect.stringContaining("Raise the card first (space_notify_operator) or give another reason.") });
    expect(await repository.list(owner)).toEqual([]);
    // Another pane's card or decision does not count; this pane's does; another reason needs none.
    cards = [{ id: "notif:1", paneId: bob.id }];
    decisions = [{ id: "nous_decision:1", status: "OPEN", refs: { paneId: bob.id } }];
    expect((await keep("Waits for the operator's SMS code")).ok).toBe(false);
    expect((await keep("Waits for the promote")).ok).toBe(true);
    decisions = [{ id: "nous_decision:2", status: "OPEN", refs: { paneId: andy.id } }];
    expect((await keep("Waits for the operator's SMS code")).ok).toBe(true);
    decisions = [];
    cards = [{ id: "notif:2", paneId: andy.id }];
    expect(await keep("Η Iris σε περιμένει για τον κωδικό SMS")).toMatchObject({ ok: true, display: "Checked Andy in Bruno: keep open" });
  });
});
