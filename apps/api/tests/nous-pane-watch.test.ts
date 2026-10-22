import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { InMemoryNousPaneChecksRepository } from "@space/db";
import { createNousPaneWatch, paneCheckedText, paneRoundLine, paneWatchEntries, paneWatchOverview, renderPanesNotChecked } from "../src/nous/pane-watch.js";
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
    expect(paneWatchOverview(entries)[3]).toMatchObject({ pane: "Dana", room: "Bruno", verdict: "WAITING_DATE", note: "Visa on 20 Oct", overdue: false });
    const world = renderNousWorld({ rooms: [{ room: bruno, sample: sample([andy], {}) }], notifications: [], plans: [], tasks: [], trains: "", decisions: [], notes: [],
      now: new Date(now).toISOString(), paneChecked: () => "checked 15:15 (ok working)", panesNotChecked: "## Panes not checked\n- Bruno/Andy · never checked" });
    expect(world).toContain("- Andy · CLI · checked 15:15 (ok working)");
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
    // A later read keeps the verdict and moves only the time.
    await watch.read(owner, bruno.id, andy.id);
    expect((await repository.list(owner)).find((check) => check.paneId === andy.id)).toMatchObject({ verdict: "OPERATOR_TEST" });
    expect((await tools.execute("space_pane_checked", { room: "Bruno", pane: "Andy", verdict: "OK_WORKING" }, { ...ctx, owner: "user:other" })).ok).toBe(false);
    expect((await tools.execute("space_pane_checked", { room: "Bruno", pane: "Andy", verdict: "FINE" }, ctx)).ok).toBe(false);
  });
});
