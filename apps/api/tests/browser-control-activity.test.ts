import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { countsAsOperatorInput, createBrowserControlActivity, settleEndedOperatorLease, sweepIdleOperatorLeases } from "../src/browser-control-activity.js";

describe("browser control activity", () => {
  it("measures idle time from the last input, the lease start or the API start, whichever is latest", () => {
    let now = Date.parse("2026-10-15T10:00:00.000Z");
    const activity = createBrowserControlActivity(() => now);
    // A lease older than the API process gets a fresh window after a restart.
    const old = { leaseId: "browser_lease:old", acquiredAt: "2026-10-15T08:29:00.000Z" };
    expect(activity.idleMs(old)).toBe(0);
    now += 60_000;
    const lease = { leaseId: "browser_lease:a", acquiredAt: new Date(now).toISOString() };
    now += 90_000;
    expect(activity.idleMs(lease)).toBe(90_000);
    activity.noteInput(lease.leaseId);
    now += 30_000;
    expect(activity.idleMs(lease)).toBe(30_000);
    expect(activity.idleMs(old)).toBe(180_000);
    activity.forget(lease.leaseId);
    expect(activity.idleMs(lease)).toBe(120_000);
  });
});

describe("browser control idle release (operator 2026-10-15: back to the agent within 2 minutes)", () => {
  async function setup() {
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:operator", email: "operator@example.test", role: "ADMIN" });
    const room = store.createRoom({ name: "Idle release", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Job Copilot", mode: "BROWSER" });
    const sessionId = `browser_session:${pane.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    store.createPaneBrowserSession({
      sessionId, paneId: pane.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: `profile:${pane.id}`,
      profilePath: `/tmp/${pane.id}`, viewport: "desktop", targetUrl: "https://example.test/", currentUrl: "https://example.test/",
      title: "Example", status: "READY", isActive: true
    });
    const handoff = store.createBrowserHandoffRequest({
      sessionId, paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById: "cli:cli_session:test",
      reason: "CAPTCHA: solve it", ttlSeconds: 1800
    });
    const lease = store.createBrowserControlLease({
      leaseId: "browser_lease:handoff", sessionId, paneId: pane.id, roomId: room.id, holderType: "OPERATOR",
      holderId: "user:operator", reason: "Direct browser interaction", ttlSeconds: 60
    });
    store.updateBrowserHandoffRequest(handoff.handoffRequestId, { status: "ACCEPTED", operatorUserId: "user:operator", operatorEmail: "operator@example.test", operatorRole: "ADMIN", controlLeaseId: lease.leaseId });
    const browserSessionManager = {
      releaseControl: async (_pane: unknown, input: { leaseId: string }) => store.updateBrowserControlLease(input.leaseId, { status: "RELEASED" })
    };
    return { store, pane, sessionId, handoff, lease, browserSessionManager };
  }

  it("releases an accepted handoff's lease after 2 minutes without a press, completes the handoff and audits it", async () => {
    const start = Date.parse("2026-10-15T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      const { store, sessionId, handoff, lease, browserSessionManager } = await setup();
      const activity = createBrowserControlActivity();
      activity.watch(lease);
      const deps = { store, browserSessionManager, activity } as unknown as Parameters<typeof sweepIdleOperatorLeases>[0];
      // Keep the lease renewed like the open tab's heartbeat does; only presses count as use.
      const renew = () => store.updateBrowserControlLease(lease.leaseId, { ttlSeconds: 60 });
      vi.setSystemTime(start + 60_000);
      renew();
      activity.noteInput(lease.leaseId);
      vi.setSystemTime(start + 150_000);
      renew();
      expect(countsAsOperatorInput({ type: "POINTER", eventType: "mouseMoved", button: "none" })).toBe(false);
      expect(countsAsOperatorInput({ type: "POINTER", eventType: "mouseMoved", button: "left" })).toBe(true);
      expect(countsAsOperatorInput({ type: "KEY", eventType: "keyDown" })).toBe(true);
      // 90 s after his last press the operator keeps it.
      expect(await sweepIdleOperatorLeases(deps)).toBe(0);
      expect(store.getBrowserControlLease(lease.leaseId)?.status).toBe("ACTIVE");
      vi.setSystemTime(start + 181_000);
      renew();
      expect(await sweepIdleOperatorLeases(deps)).toBe(1);
      expect(store.getBrowserControlLease(lease.leaseId)?.status).toBe("RELEASED");
      expect(store.getBrowserHandoffRequest(handoff.handoffRequestId)?.status).toBe("COMPLETED");
      expect(store.getPaneBrowserSession(sessionId)?.controlState).toBe("UNCONTROLLED");
      expect(store.listAuditEvents().filter((event) => event.action === "pane.browser.control.idle_release")).toEqual([
        expect.objectContaining({ actorUserId: null, metadata: { sessionId, leaseId: lease.leaseId, idleSeconds: 121 } })
      ]);
      expect(activity.watched()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a lease whose tab stopped heartbeating, with its handoff, instead of leaving the handoff ACCEPTED", async () => {
    const start = Date.parse("2026-10-15T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      const first = await setup();
      const activity = createBrowserControlActivity();
      activity.watch(first.lease);
      vi.setSystemTime(start + 61_000);
      expect(await sweepIdleOperatorLeases({ store: first.store, browserSessionManager: first.browserSessionManager, activity } as never)).toBe(1);
      expect(first.store.getBrowserControlLease(first.lease.leaseId)?.status).toBe("EXPIRED");
      expect(first.store.getBrowserHandoffRequest(first.handoff.handoffRequestId)?.status).toBe("COMPLETED");
      expect(first.store.getPaneBrowserSession(first.sessionId)?.controlState).toBe("UNCONTROLLED");
      // Not watched (an API restart): the agent's status read settles it.
      vi.setSystemTime(start);
      const second = await setup();
      vi.setSystemTime(start + 61_000);
      await settleEndedOperatorLease(second.store, second.sessionId);
      expect(second.store.getBrowserHandoffRequest(second.handoff.handoffRequestId)?.status).toBe("COMPLETED");
      // A lease still in use is left alone.
      vi.setSystemTime(start);
      const third = await setup();
      await settleEndedOperatorLease(third.store, third.sessionId);
      expect(third.store.getBrowserHandoffRequest(third.handoff.handoffRequestId)?.status).toBe("ACCEPTED");
      expect(third.store.getBrowserControlLease(third.lease.leaseId)?.status).toBe("ACTIVE");
    } finally {
      vi.useRealTimers();
    }
  });
});
