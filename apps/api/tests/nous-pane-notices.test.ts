import { describe, expect, it } from "vitest";
import { eventSchema, type Pane, type Room } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, SpaceEventBus } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { createNousPaneNotices } from "../src/nous/pane-notices.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

// One card per pane for what only the operator's hands can do (plan clipboard:8FfXWclYUfOH).
const owner = "user:operator";
const room = { id: "room:freelance01", name: "Freelance", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const pane = (id: string, paneName: string) => ({ id, roomId: room.id, paneName, title: paneName, mode: "TERMINAL", isClosed: false }) as unknown as Pane;
const andy = pane("pane:andy0001", "Andy");
const bob = pane("pane:bob00001", "Bob");

function fixture(held = false) {
  const repository = new InMemorySpaceNotificationsRepository(undefined, true);
  const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
    recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
    nous: { held: async () => held, raised: () => {} } });
  return { repository, service, notices: createNousPaneNotices({ notifications: service }) };
}

describe("Nous's cards to the operator", () => {
  it("keeps one card per pane: a new list replaces the items, unread again and alerted once; the same list changes nothing", async () => {
    const f = fixture();
    const first = await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the Cloudflare check" }] });
    expect(first).toMatchObject({ ok: true, display: "Sent the operator's card for Andy in Freelance (1 item)" });
    const [card] = await f.service.list(owner, { status: "ALL", limit: 50 });
    expect(card).toMatchObject({ source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", paneId: andy.id, roomId: room.id, dedupeKey: "nous:pane:pane:andy0001",
      link: { roomId: room.id, paneId: andy.id }, body: "• Pass the Cloudflare check", status: "OPEN" });
    await f.service.setStatus(owner, card!.id, "READ");

    const same = await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the Cloudflare check" }] });
    expect(same.display).toBe("The card for Andy in Freelance already lists this");
    expect(f.repository.telegram).toHaveLength(1);

    await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you",
      items: [{ text: "Pass the Cloudflare check" }, { text: "Enter the 2FA code", ref: "notification:abc123" }] });
    const cards = await f.service.list(owner, { status: "ALL", limit: 50 });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: card!.id, status: "OPEN", body: "• Pass the Cloudflare check\n• Enter the 2FA code" });
    expect(f.repository.telegram).toHaveLength(2);

    await f.notices.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Sign in to LinkedIn", items: [{ text: "Sign in" }] });
    await f.notices.notify(owner, room, null, { room: "Freelance", title: "Send the invoice PDF", items: [{ text: "Download it from the bank" }] });
    expect((await f.service.list(owner, { status: "OPEN", limit: 50 })).map((item) => item.dedupeKey).sort())
      .toEqual(["nous:general", "nous:pane:pane:andy0001", "nous:pane:pane:bob00001"]);
    expect(await f.notices.summary(owner, { room: () => "Freelance", pane: (id) => id === andy.id ? "Andy" : id === bob.id ? "Bob" : null }))
      .toContain(`- [${card!.id}] Upwork needs you · Andy in Freelance · 2 items`);
  });

  it("reaches the operator at once even while Nous holds other notifications, and resolves the cards of closed panes", async () => {
    const f = fixture(true);
    await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the check" }] });
    await f.notices.notify(owner, room, null, { room: "Freelance", title: "A document", items: [{ text: "Get it" }] });
    expect(f.repository.telegram).toHaveLength(2);
    expect(await f.notices.reconcile(owner, new Set([bob.id]))).toBe(1);
    expect((await f.service.list(owner, { status: "OPEN", limit: 50 })).map((item) => item.dedupeKey)).toEqual(["nous:general"]);
  });

  it("is a Nous tool that reaches only the owner's rooms and panes", async () => {
    const f = fixture();
    const tools = createNousTools({ paneNotices: f.notices, rooms: async (who: string) => who === owner ? [room] : [], listPanes: async () => [andy, bob] } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "nous_turn:n1", callId: "toolu_n", traceId: "trace:n" };
    expect(await tools.execute("space_notify_operator", { room: "freelance", pane: "andy", title: "Upwork needs you", items: [{ text: "Pass the check" }] }, ctx))
      .toMatchObject({ ok: true, result: expect.stringMatching(/^Notification notification:/) });
    expect((await tools.execute("space_notify_operator", { room: "Freelance", pane: "Zed", title: "x", items: [{ text: "y" }] }, ctx)).ok).toBe(false);
    expect((await tools.execute("space_notify_operator", { room: "Freelance", title: "x".repeat(81), items: [{ text: "y" }] }, ctx)).ok).toBe(false);
    expect((await tools.execute("space_notify_operator", { room: "Freelance", title: "x", items: [] }, ctx)).ok).toBe(false);
    expect((await tools.execute("space_notify_operator", { room: "Freelance", pane: "Andy", title: "x", items: [{ text: "y" }] }, { ...ctx, owner: "user:other" })).ok).toBe(false);
  });
});
