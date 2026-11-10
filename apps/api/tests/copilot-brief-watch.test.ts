import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createCopilotBriefWatch, lateBriefs, type WaitingBrief } from "../src/copilot-brief-watch.js";
import { withCopilotWork, type BoardPaneInput } from "../src/nous/pane-board.js";
import { renderNousWorld } from "../src/nous/digest.js";
import type { RoomPaneObservation } from "../src/room-pane-control.js";

const owner = "user:operator";
const room = { id: "room:cGqsEVIjBbo2", name: "Alex", ownerUserId: owner } as Room;
const emma = { id: "pane:GH_PpffV6-MD", roomId: room.id, mode: "APP_STUDIO", title: "App Studio 20", paneName: "Emma", isClosed: false } as Pane;
// Alex/Emma on 30/10: icon v2 TAKEN at 17:38, the Quotas brief at 17:50, the server-parts brief at 18:04, Nous 0.2.4 shipped at 18:18.
const briefs: WaitingBrief[] = [
  { id: "asevt:iconv2", status: "TAKEN", createdAt: "2026-10-30T17:30:00.000Z", updatedAt: "2026-10-30T17:38:00.000Z" },
  { id: "asevt:quotas", status: "PENDING", createdAt: "2026-10-30T17:50:00.000Z" },
  { id: "asevt:server", status: "PENDING", createdAt: "2026-10-30T18:04:00.000Z" }
];
const screen = (state: string, text: string, extra: Partial<RoomPaneObservation> = {}) =>
  ({ sessionId: "cli_session:Nn5V2ty5q-CH", promptFingerprint: "fp", state, text, usageLimited: false, ...extra }) as unknown as RoomPaneObservation;
const idleWithRow = screen("IDLE", "⏺ Shipped Nous 0.2.4.\n────\n❯ Pondered for 41m 12s and then some\n────\n  ⏵⏵ bypass permissions on");

describe("the copilot brief watch (operator 31/10 08:31 BKK: Alex/Emma idle 7 h while briefs waited)", () => {
  it("counts PENDING briefs after 15 minutes and TAKEN ones with no update for 30 minutes", () => {
    const at = (time: string) => Date.parse(`2026-10-30T${time}:00.000Z`);
    expect(lateBriefs(briefs, at("18:05")).map((brief) => brief.id)).toEqual(["asevt:quotas"]);
    expect(lateBriefs(briefs, at("18:30")).map((brief) => brief.id)).toEqual(["asevt:iconv2", "asevt:quotas", "asevt:server"]);
    // A Design or Video request QUEUED is late after 5 minutes (31/10 Cleo/Cody).
    expect(lateBriefs([{ id: "dreq:1", status: "QUEUED", createdAt: "2026-10-30T18:00:00.000Z" }], at("18:04"))).toEqual([]);
    expect(lateBriefs([{ id: "dreq:1", status: "QUEUED", createdAt: "2026-10-30T18:00:00.000Z" }], at("18:05"))).toHaveLength(1);
    expect(lateBriefs([{ id: "asevt:done", status: "DONE", createdAt: "2026-10-30T10:00:00.000Z" }], at("18:20"))).toEqual([]);
  });

  it("tells Nous once an hour about an idle pane with late briefs, says why, names a hold, and clears when the pane works", async () => {
    let now = Date.parse("2026-10-30T18:30:00.000Z");
    let observed = idleWithRow;
    let held: string | null = null;
    const notice = vi.fn();
    const watch = createCopilotBriefWatch({ store: { listRooms: () => [room], listPanes: () => [emma] }, now: () => now, notice, label: (pane) => pane.paneName ?? pane.title,
      inspect: async () => observed, log: { warn: vi.fn() }, sources: { APP_STUDIO: { briefs: async () => briefs, held: async () => held } } });
    expect(await watch.tick()).toBe(1);
    expect(watch.waiting(emma.id)).toMatchObject({ count: 3, since: "2026-10-30T17:38:00.000Z", ids: ["asevt:iconv2", "asevt:quotas", "asevt:server"], held: null });
    expect(notice).toHaveBeenCalledWith(owner, `briefs-waiting:${emma.id}`, expect.stringContaining("Emma (pane:GH_PpffV6-MD) in Alex sits idle at its prompt with 3 briefs waiting since 17:38 UTC"));
    expect(notice.mock.calls[0]![2]).toContain("its prompt holds text Space reads as a draft");
    now += 30 * 60_000;
    expect(await watch.tick()).toBe(0);
    now += 31 * 60_000;
    observed = screen("IDLE", "❯ ", { usageLimited: true });
    held = "its run is stopped";
    expect(await watch.tick()).toBe(1);
    expect(notice.mock.calls[1]![2]).toMatch(/\(its run is stopped\).*its CLI is at a usage limit.*stays held/);
    observed = screen("WORKING", "✻ Building…");
    await watch.tick();
    expect(watch.waiting(emma.id)).toBeNull();
  });

  it("R22-1 (1/11, Bruno/Iris: 3 lines 21:39-23:00 UTC while recorded WAITING_DATE until 09:00 BKK): holds the line until the verdict's next check, then names it", async () => {
    let now = Date.parse("2026-10-31T21:39:00.000Z");
    let check: { verdict: string | null; nextCheckAt: string | null; note: string | null } | null = { verdict: "WAITING_DATE", nextCheckAt: "2026-11-01T02:00:00.000Z", note: "S6 push proof held by quiet hours" };
    const notice = vi.fn();
    const watch = createCopilotBriefWatch({ store: { listRooms: () => [room], listPanes: () => [emma] }, now: () => now, notice, label: (pane) => pane.paneName ?? pane.title,
      inspect: async () => idleWithRow, check: async () => check, log: { warn: vi.fn() },
      sources: { APP_STUDIO: { briefs: async () => [{ id: "asevt:s6", status: "PENDING", createdAt: "2026-10-31T21:00:00.000Z" }], held: async () => null } } });
    for (const at of ["21:39", "22:40", "23:00"]) {
      now = Date.parse(`2026-10-31T${at}:00.000Z`);
      expect(await watch.tick()).toBe(0);
    }
    expect(notice).not.toHaveBeenCalled();
    expect(watch.waiting(emma.id)).toBeNull();
    // OK_WORKING holds nothing.
    check = { verdict: "OK_WORKING", nextCheckAt: "2026-11-01T02:00:00.000Z", note: null };
    expect(await watch.tick()).toBe(1);
    check = { verdict: "WAITING_DATE", nextCheckAt: "2026-11-01T02:00:00.000Z", note: "S6 push proof held by quiet hours" };
    now = Date.parse("2026-11-01T02:01:00.000Z");
    expect(await watch.tick()).toBe(1);
    expect(notice.mock.calls[1]![2]).toContain("You recorded it WAITING_DATE until 02:00 UTC (\"S6 push proof held by quiet hours\"); that check has passed.");
  });

  it("shows the waiting briefs on the pane board and the world's pane line instead of a state", () => {
    const input = { pane: emma, state: "working", notifications: [], decisions: [], copilotItems: [], check: null, waitingWork: 0,
      briefsWaiting: "3 briefs waiting since 17:38 UTC" } as unknown as BoardPaneInput;
    expect(withCopilotWork(input, { line: "Working on icon v2", waitsOn: "NONE", needsOperator: false, until: null }))
      .toEqual({ line: "3 briefs waiting since 17:38 UTC, idle at its prompt", waitsOn: "NOUS", needsOperator: false, until: null });
    const world = renderNousWorld({ rooms: [{ room, sample: { data: [emma], activity: { [emma.id]: "idle" }, details: {}, sampledAt: "" } }] as never,
      notifications: [], plans: [], tasks: [], trains: "", decisions: [], notes: [], now: "2026-10-30T18:30:00.000Z",
      paneBriefs: (paneId) => paneId === emma.id ? "3 briefs waiting since 17:38 UTC, idle at its prompt" : null });
    expect(world).toContain("- Emma · app studio · 3 briefs waiting since 17:38 UTC, idle at its prompt");
  });
});
