import { afterEach, describe, expect, it, vi } from "vitest";
import { eventSchema } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { InMemorySpaceStore, SpaceEventBus, makeSpaceId } from "@space/runtime";
import { browserHandoffNotificationKey, browserHandoffTitle, settleBrowserHandoffNotifications, startBrowserHandoffNotifications } from "../src/notifications/browser-handoff.js";
import { createNotificationService } from "../src/notifications/service.js";

const owner = "user:operator";
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const store = new InMemorySpaceStore();
  const repository = new InMemorySpaceNotificationsRepository();
  const notifications = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
    recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
  const room = store.createRoom({ name: "Handoffs", initialPaneCount: 0 });
  /** A browser pane whose agent asked for a handoff, and the notification the producer raised for it. */
  async function handoffPane(title: string, ttlSeconds = 1800) {
    const pane = store.createPane({ roomId: room.id, title, mode: "BROWSER" });
    const sessionId = `browser_session:${pane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    store.createPaneBrowserSession({ sessionId, paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: `profile:${pane.id}`,
      profilePath: `/tmp/${pane.id}`, viewport: "desktop", targetUrl: "https://example.test/", currentUrl: "https://example.test/", title, status: "READY", isActive: true });
    const handoff = store.createBrowserHandoffRequest({ sessionId, paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById: "cli:cli_session:test",
      reason: "CAPTCHA: solve it", ttlSeconds });
    const { notification } = await repository.raise({ ownerUserId: owner, roomId: room.id, paneId: pane.id, source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED",
      severity: "ATTENTION", title: "The browser needs you", body: "", link: { roomId: room.id, paneId: pane.id }, dedupeKey: browserHandoffNotificationKey(pane.id), payload: {}, telegram: null });
    return { pane, handoff, notification };
  }
  const statusOf = async (id: string) => (await repository.get(owner, id))?.status;
  store.upsertUser({ id: owner, email: "operator@example.test", role: "ADMIN" });
  /** The operator takes control and gives it back: the handoff is COMPLETED. */
  function complete({ pane, handoff }: { pane: { id: string }; handoff: { handoffRequestId: string; sessionId: string } }) {
    const lease = store.createBrowserControlLease({ leaseId: `browser_lease:${handoff.handoffRequestId.slice(-8)}`, sessionId: handoff.sessionId, paneId: pane.id, roomId: room.id,
      holderType: "OPERATOR", holderId: owner, reason: "Direct browser interaction", ttlSeconds: 60 });
    store.updateBrowserHandoffRequest(handoff.handoffRequestId, { status: "ACCEPTED", operatorUserId: owner, operatorEmail: "operator@example.test", operatorRole: "ADMIN", controlLeaseId: lease.leaseId });
    store.updateBrowserHandoffRequest(handoff.handoffRequestId, { status: "COMPLETED" });
  }
  return { store, repository, notifications, room, handoffPane, statusOf, complete };
}

describe("browser handoff notifications", () => {
  it("resolve when the handoff is completed, cancelled, timed out or its pane closed or deleted, and stay while it is active", async () => {
    const start = Date.parse("2026-10-17T06:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const { store, repository, notifications, handoffPane, statusOf, complete } = setup();
    const active = await handoffPane("Active");
    const completed = await handoffPane("Completed");
    const cancelled = await handoffPane("Cancelled");
    const timedOut = await handoffPane("Timed out", 60);
    const closed = await handoffPane("Closed");
    const read = await handoffPane("Read");
    complete(completed);
    store.updateBrowserHandoffRequest(cancelled.handoff.handoffRequestId, { status: "CANCELLED" });
    // A deleted pane leaves pane_id null; the dedupe key still names it.
    const { notification: deleted } = await repository.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED",
      severity: "ATTENTION", title: "The browser needs you", body: "", link: {}, dedupeKey: browserHandoffNotificationKey("pane:deleted01"), payload: {}, telegram: null });
    store.updatePane(closed.pane.id, { isClosed: true, status: "CLOSED" });
    complete(read);
    await repository.setStatus(owner, read.notification.id, "READ");
    vi.setSystemTime(start + 61_000);

    // One pane at a time (a closed pane's event) leaves the others for the sweep.
    expect(await settleBrowserHandoffNotifications({ store, notifications }, closed.pane.id)).toBe(1);
    expect(await statusOf(completed.notification.id)).toBe("OPEN");
    expect(await settleBrowserHandoffNotifications({ store, notifications })).toBe(5);
    for (const ended of [completed, cancelled, timedOut, closed, read, { notification: deleted }]) expect(await statusOf(ended.notification.id)).toBe("RESOLVED");
    expect(store.getBrowserHandoffRequest(timedOut.handoff.handoffRequestId)?.status).toBe("EXPIRED");
    expect(await statusOf(active.notification.id)).toBe("OPEN");
    // Resolved, never deleted: the Notification Center keeps them.
    expect((await repository.list(owner, { status: "ALL", limit: 50 })).length).toBe(7);
    expect(await settleBrowserHandoffNotifications({ store, notifications })).toBe(0);
  });

  it("titles the notification with the agent's reason (site and what to click) and keeps room and pane", async () => {
    expect(browserHandoffTitle("CAPTCHA: Upwork: Cloudflare check, tick the box\nmore")).toBe("Upwork: Cloudflare check, tick the box");
    expect(browserHandoffTitle(null)).toBe("The browser needs you");
    expect(browserHandoffTitle("LOGIN: ")).toBe("The browser needs you");
    const { store, repository, notifications, room } = setup();
    const eventBus = new SpaceEventBus();
    const stop = startBrowserHandoffNotifications({ store, notifications, eventBus, roomOwner: async () => owner, log: { warn: () => {} } });
    const pane = store.createPane({ roomId: room.id, title: "Freelance", mode: "BROWSER" });
    store.createPaneBrowserSession({ sessionId: "browser_session:fl", paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: "profile:fl",
      profilePath: "/tmp/fl", viewport: "desktop", targetUrl: "https://www.upwork.com/", currentUrl: "https://www.upwork.com/", title: "Upwork", status: "READY", isActive: true });
    const handoff = store.createBrowserHandoffRequest({ sessionId: "browser_session:fl", paneId: pane.id, roomId: room.id, requestedByType: "AGENT",
      requestedById: "cli:cli_session:test", reason: "CAPTCHA: Upwork: Cloudflare check, tick the box", ttlSeconds: 1800 });
    eventBus.publish(store.listEvents(room.id).find((event) => event.traceId === handoff.handoffRequestId)!);
    await vi.waitFor(async () => expect((await repository.list(owner, { status: "ALL", limit: 5 }))[0]).toMatchObject({
      title: "Upwork: Cloudflare check, tick the box", body: "CAPTCHA: Upwork: Cloudflare check, tick the box", roomId: room.id, paneId: pane.id,
      link: { roomId: room.id, paneId: pane.id } }));
    stop();
  });
});
