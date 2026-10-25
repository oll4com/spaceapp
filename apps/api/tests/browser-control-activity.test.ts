import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { countsAsOperatorInput, createBrowserControlActivity, releaseBrowserControlLease, settleEndedOperatorLease, sweepIdleOperatorLeases } from "../src/browser-control-activity.js";
import { registerVaultFenceHooks } from "../src/vault/fence-hooks.js";

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

  it("names the last agent pane that drove a browser for 10 minutes, or as long as it stays attached", () => {
    let now = Date.parse("2026-10-20T10:00:00.000Z");
    const activity = createBrowserControlActivity(() => now);
    expect(activity.agentFor("pane:browser")).toBeNull();
    activity.noteAgent("pane:browser", "pane:codex");
    activity.noteAgent("pane:browser", "pane:claude");
    now += 10 * 60_000;
    expect(activity.agentFor("pane:browser")).toBe("pane:claude");
    now += 1;
    expect(activity.agentFor("pane:browser")).toBeNull();
    expect(activity.agentFor("pane:browser", true)).toBe("pane:claude");
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

  it("fences the pane's page when a handoff completes, before the agent gets the browser back (2026-10-19)", async () => {
    const start = Date.parse("2026-10-15T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      const steps: string[] = [];
      // Released by the operator (or the idle sweep): the fence goes up before the host hands control back.
      const first = await setup();
      registerVaultFenceHooks(first.store, { fenceHandoff: async (paneId) => { steps.push(`fence ${paneId}`); }, fencedTargets: async () => [] });
      const releaseControl = first.browserSessionManager.releaseControl;
      first.browserSessionManager.releaseControl = async (pane, input) => { steps.push("release"); return releaseControl(pane, input); };
      await releaseBrowserControlLease({ store: first.store, browserSessionManager: first.browserSessionManager, activity: createBrowserControlActivity() } as never,
        { pane: first.pane, lease: first.lease, traceId: "trace:handoff", auditAction: "pane.browser.control.release" });
      expect(steps).toEqual([`fence ${first.pane.id}`, "release"]);
      expect(first.store.getBrowserHandoffRequest(first.handoff.handoffRequestId)?.status).toBe("COMPLETED");
      // A lease that ran out (the tab stopped heartbeating) fences the same way.
      steps.length = 0;
      const second = await setup();
      registerVaultFenceHooks(second.store, { fenceHandoff: async (paneId) => { steps.push(`fence ${paneId}`); }, fencedTargets: async () => [] });
      vi.setSystemTime(start + 61_000);
      await settleEndedOperatorLease(second.store, second.sessionId);
      expect(steps).toEqual([`fence ${second.pane.id}`]);
      // No fence without a handoff (the operator took control himself), and a fence that fails never blocks the handoff.
      steps.length = 0;
      vi.setSystemTime(start);
      const third = await setup();
      registerVaultFenceHooks(third.store, { fenceHandoff: async () => { throw new Error("Browser Host unavailable"); }, fencedTargets: async () => [] });
      const own = third.store.createBrowserControlLease({ leaseId: "browser_lease:own", sessionId: third.sessionId, paneId: third.pane.id, roomId: third.pane.roomId,
        holderType: "OPERATOR", holderId: "user:operator", reason: "Direct browser interaction", ttlSeconds: 60 });
      registerVaultFenceHooks(third.store, { fenceHandoff: async (paneId) => { steps.push(`fence ${paneId}`); }, fencedTargets: async () => [] });
      await releaseBrowserControlLease({ store: third.store, browserSessionManager: third.browserSessionManager, activity: createBrowserControlActivity() } as never,
        { pane: third.pane, lease: own, traceId: "trace:own", auditAction: "pane.browser.control.release" });
      expect(steps).toEqual([]);
      registerVaultFenceHooks(third.store, { fenceHandoff: async () => { throw new Error("Browser Host unavailable"); }, fencedTargets: async () => [] });
      vi.setSystemTime(start + 61_000);
      await settleEndedOperatorLease(third.store, third.sessionId);
      expect(third.store.getBrowserHandoffRequest(third.handoff.handoffRequestId)?.status).toBe("COMPLETED");
    } finally {
      vi.useRealTimers();
    }
  });
});
