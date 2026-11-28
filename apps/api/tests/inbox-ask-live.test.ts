// Plan clipboard:va__qa_eBMYr §3 (operator 27/11): an open hands card says what its place looks like now.
import { describe, expect, it } from "vitest";
import type { BrowserHandoffRequest, SpaceNotification } from "@space/contracts";
import type { PaneReport } from "@space/db";
import { askLive, createAskLive } from "../src/inbox/ask-live.js";

const now = Date.parse("2026-11-27T05:00:00.000Z");
const handoff = (status: string, expiresAt: string) => ({ status, expiresAt, expiredAt: null }) as never;

describe("a hands card's live state", () => {
  it("names the first thing that stops the operator, else READY", () => {
    const open = { paneOpen: true, pageOpen: true, handoff: null, report: null };
    expect(askLive(open, now)).toEqual({ state: "READY", line: "The page is open and waits for you." });
    expect(askLive({ ...open, pageOpen: null }, now).line).toBe("The pane is open and waits for you.");
    expect(askLive({ ...open, handoff: handoff("REQUESTED", "2026-11-27T05:30:00.000Z") }, now)).toMatchObject({ state: "READY", until: "2026-11-27T05:30:00.000Z" });
    // The sweep that marks a handoff EXPIRED runs after its time: a held one past it has run out already.
    expect(askLive({ ...open, handoff: handoff("REQUESTED", "2026-11-27T04:09:19.057Z") }, now)).toMatchObject({ state: "EXPIRED", at: "2026-11-27T04:09:19.057Z" });
    expect(askLive({ ...open, handoff: { status: "EXPIRED", expiresAt: "2026-11-27T04:09:19.057Z", expiredAt: "2026-11-27T04:09:26.711Z" } }, now)).toMatchObject({ state: "EXPIRED", at: "2026-11-27T04:09:26.711Z" });
    expect(askLive({ ...open, handoff: handoff("COMPLETED", "2026-11-27T04:09:19.057Z") }, now).state).toBe("READY");
    expect(askLive({ ...open, pageOpen: false, handoff: handoff("EXPIRED", "2026-11-27T04:09:19.057Z") }, now).state).toBe("PAGE_GONE");
    expect(askLive({ ...open, pageOpen: false, report: { at: "2026-11-27T04:30:00.000Z", summary: "Signed in with the saved login (nous_msg:abc12345)" } }, now))
      .toEqual({ state: "MOVED_ON", line: "Signed in with the saved login", at: "2026-11-27T04:30:00.000Z" });
    expect(askLive({ ...open, paneOpen: false, report: { at: "2026-11-27T04:30:00.000Z", summary: "x" } }, now).state).toBe("PANE_CLOSED");
  });

  // The card of 27/11: Jack (a CLI) asked at 03:39 for a sign-in in the room's browser pane, whose handoff ran out at 04:09.
  const card = { id: "notification:jack", ownerUserId: "user:operator", source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION", status: "OPEN", roomId: "room:df", paneId: "pane:jack",
    title: "Jack needs you", body: "", link: { roomId: "room:df", paneId: "pane:jack" }, dedupeKey: "agent:needs-you:pane:jack", createdAt: "2026-11-27T03:39:26.794Z",
    payload: { alertAt: "2026-11-27T03:39:20.000Z", planId: "clipboard:plan-a", browserPage: { roomId: "room:df", paneId: "pane:browser", target: "tab:T1" } } } as unknown as SpaceNotification;
  const expired = { paneId: "pane:browser", status: "EXPIRED", expiresAt: "2026-11-27T04:09:19.057Z", expiredAt: "2026-11-27T04:09:26.711Z" } as BrowserHandoffRequest;
  const report = (over: Partial<PaneReport>) => ({ paneId: "pane:jack", at: "2026-11-27T04:30:00.000Z", status: "PROGRESS", summary: "Went on with the export", planId: null, ...over }) as PaneReport;
  const live = async (over: { handoffs?: BrowserHandoffRequest[]; reports?: PaneReport[]; page?: boolean; get?: SpaceNotification | null } = {}) => {
    const rooms: string[] = [];
    const read = createAskLive({ notifications: { get: async () => over.get === undefined ? card : over.get }, paneOpen: async () => true, now: () => now,
      places: () => async () => ({ page: true, place: over.page === false ? null : { roomId: "room:df", paneId: "pane:browser", target: "tab:T1" }, url: null }),
      handoffs: async (roomId) => { rooms.push(roomId); return over.handoffs ?? [expired]; }, reports: async () => over.reports ?? [] });
    return { state: (await read("user:operator", [card.id])).get(card.id)?.state, rooms };
  };

  it("reads the handoff of the browser pane holding the card's page, and only one that was live when the card asked", async () => {
    expect(await live()).toEqual({ state: "EXPIRED", rooms: ["room:df"] });
    expect((await live({ handoffs: [{ ...expired, paneId: "pane:other" }] })).state).toBe("READY");
    expect((await live({ handoffs: [{ ...expired, expiresAt: "2026-11-26T04:09:19.057Z" }] })).state).toBe("READY");
    expect((await live({ page: false })).state).toBe("PAGE_GONE");
  });

  it("follows the agent's later work on the same plan, never a wait, an earlier report or another plan's", async () => {
    expect((await live({ reports: [report({})] })).state).toBe("MOVED_ON");
    expect((await live({ reports: [report({ planId: "clipboard:plan-a", status: "DONE" })] })).state).toBe("MOVED_ON");
    for (const other of [report({ status: "WAITING" }), report({ status: "HEARTBEAT" }), report({ at: "2026-11-27T03:39:20.000Z" }), report({ planId: "clipboard:plan-b" }), report({ paneId: "pane:max" })]) {
      expect((await live({ reports: [other] })).state).toBe("EXPIRED");
    }
  });

  it("gives no state to a card that is not an open hands card, and none when a fact cannot be read", async () => {
    expect((await live({ get: null })).state).toBeUndefined();
    expect((await live({ get: { ...card, kind: "MAIL_RECEIVED", source: "MAIL_COPILOT" } as SpaceNotification })).state).toBeUndefined();
    const read = createAskLive({ notifications: { get: async () => card }, paneOpen: async () => { throw new Error("database is away"); }, places: () => async () => ({ page: false, place: null, url: null }),
      handoffs: async () => [], reports: async () => [] });
    expect((await read("user:operator", [card.id])).size).toBe(0);
  });
});
