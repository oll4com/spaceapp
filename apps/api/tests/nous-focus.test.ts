import { describe, expect, it } from "vitest";
import { eventSchema, type Pane, type Room } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { SpaceEventBus, makeSpaceId } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { createNousPaneNotices, focusPaneSchema } from "../src/nous/pane-notices.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

// Needs you (operator request 2026-10-24): the card is the focus. space_focus_pane is space_notify_operator for one pane with one item.
const owner = "user:operator";
const room = { id: "room:focus000001", name: "Main", ownerUserId: owner } as Room;
const pane = { id: "pane:focus000001", roomId: room.id, title: "Freelance", paneName: "Emma", isClosed: false } as Pane;

describe("space_focus_pane", () => {
  it("raises the pane's card (NOUS NEEDS_HANDS, one open per pane) with the reason as its item; the same reason again changes nothing", async () => {
    const repository = new InMemorySpaceNotificationsRepository();
    const notifications = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    const tools = createNousTools({ paneNotices: createNousPaneNotices({ notifications }), rooms: async () => [room], listPanes: async () => [pane] } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "nous_turn:f1", callId: "toolu_f", traceId: "trace:f" };
    const first = await tools.execute("space_focus_pane", { room: "Main", pane: "Emma", reason: "CAPTCHA on Upwork" }, ctx);
    expect(first.ok).toBe(true);
    const open = () => repository.list(owner, { status: "OPEN", limit: 10 });
    expect(await open()).toHaveLength(1);
    expect((await open())[0]).toMatchObject({ source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", title: "Emma needs you", body: "• CAPTCHA on Upwork",
      paneId: pane.id, roomId: room.id, dedupeKey: `nous:pane:${pane.id}`, link: { roomId: room.id, paneId: pane.id } });
    const again = await tools.execute("space_focus_pane", { room: "Main", pane: "Emma", reason: "CAPTCHA on Upwork" }, ctx);
    expect(again.result).toContain("Unchanged");
    expect(await open()).toHaveLength(1);
    const changed = await tools.execute("space_focus_pane", { room: "Main", pane: "Emma", reason: "Sign in to Upwork" }, ctx);
    expect(changed.display).toContain("Updated");
    expect(await open()).toHaveLength(1);
    expect((await open())[0]).toMatchObject({ body: "• Sign in to Upwork" });
    expect(await tools.execute("space_focus_pane", { room: "Main", pane: "Zed", reason: "x" }, ctx)).toMatchObject({ ok: false });
  });

  it("needs a reason that fits the card's item", () => {
    expect(focusPaneSchema.safeParse({ room: "Main", pane: "Emma" }).success).toBe(false);
    expect(focusPaneSchema.safeParse({ room: "Main", pane: "Emma", reason: "Sign in to Upwork" }).success).toBe(true);
    expect(focusPaneSchema.safeParse({ room: "Main", pane: "Emma", reason: "x".repeat(201) }).success).toBe(false);
  });
});
