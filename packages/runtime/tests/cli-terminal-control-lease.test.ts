import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceConflictError, SpaceNotFoundError } from "../src/index.js";

const firstIdentity = {
  browserClientId: "11111111-1111-4111-8111-111111111111",
  tabLineageId: "22222222-2222-4222-8222-222222222222",
  pageClientId: "33333333-3333-4333-8333-333333333333"
};
const secondIdentity = {
  browserClientId: firstIdentity.browserClientId,
  tabLineageId: "44444444-4444-4444-8444-444444444444",
  pageClientId: "55555555-5555-4555-8555-555555555555"
};

function createFixture() {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Terminal control", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "CLI", mode: "TERMINAL", cwd: "/etc" });
  const session = store.createPaneCliSession({
    sessionId: "cli_session:terminal-control",
    paneId: pane.id,
    roomId: room.id,
    runtimeId: "cli:codex",
    providerId: "codex",
    agentId: "codex",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    cwd: "/etc",
    status: "RUNNING",
    statusReason: "Running",
    isActive: true
  });
  return { store, room, pane, session };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("InMemorySpaceStore CLI terminal control leases", () => {
  it("atomically replaces the active page controller and fences the previous lease", () => {
    const { store, pane, room, session } = createFixture();
    const baseInput = {
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      userId: "user:operator",
      ttlSeconds: 30
    };
    const first = store.createPaneCliTerminalControlLease({
      ...baseInput,
      ...firstIdentity,
      leaseId: "cli_terminal_lease:first",
      expectedActiveLeaseId: null
    });
    const second = store.createPaneCliTerminalControlLease({
      ...baseInput,
      ...secondIdentity,
      leaseId: "cli_terminal_lease:second",
      expectedActiveLeaseId: first.leaseId
    });

    expect(store.getPaneCliTerminalControlLease(first.leaseId)).toMatchObject({ status: "REVOKED" });
    expect(store.getActivePaneCliTerminalControlLease(session.sessionId)).toEqual(second);
    expect(() => store.createPaneCliTerminalControlLease({
      ...baseInput,
      ...firstIdentity,
      leaseId: "cli_terminal_lease:stale",
      expectedActiveLeaseId: first.leaseId
    })).toThrow(SpaceConflictError);
    expect(store.getActivePaneCliTerminalControlLease(session.sessionId)).toEqual(second);
  });

  it("heartbeats, releases and rejects stale controller updates", () => {
    const { store, pane, room, session } = createFixture();
    const lease = store.createPaneCliTerminalControlLease({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      userId: "user:operator",
      ...firstIdentity,
      expectedActiveLeaseId: null,
      ttlSeconds: 30
    });
    const heartbeat = store.updatePaneCliTerminalControlLease(lease.leaseId, {
      expectedStatus: "ACTIVE",
      ttlSeconds: 60
    });

    expect(Date.parse(heartbeat.expiresAt)).toBeGreaterThanOrEqual(Date.parse(lease.expiresAt));
    expect(store.updatePaneCliTerminalControlLease(lease.leaseId, {
      expectedStatus: "ACTIVE",
      status: "RELEASED"
    })).toMatchObject({ status: "RELEASED", releasedAt: expect.any(String) });
    expect(store.getActivePaneCliTerminalControlLease(session.sessionId)).toBeNull();
    expect(() => store.updatePaneCliTerminalControlLease(lease.leaseId, {
      expectedStatus: "ACTIVE",
      ttlSeconds: 30
    })).toThrow(SpaceConflictError);
  });

  it("expires a stale lease once and preserves the lifecycle in snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T08:00:00.000Z"));
    const { store, pane, room, session } = createFixture();
    const lease = store.createPaneCliTerminalControlLease({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      userId: "user:operator",
      ...firstIdentity,
      expectedActiveLeaseId: null,
      ttlSeconds: 5
    });

    vi.advanceTimersByTime(5_001);
    expect(store.getActivePaneCliTerminalControlLease(session.sessionId)).toBeNull();
    expect(store.snapshot().paneCliTerminalControlLeases).toContainEqual(expect.objectContaining({
      leaseId: lease.leaseId,
      status: "EXPIRED",
      releasedAt: "2026-07-23T08:00:05.001Z"
    }));
  });

  it("rejects authority records that do not identify the CLI session", () => {
    const { store, room, session } = createFixture();

    expect(() => store.createPaneCliTerminalControlLease({
      sessionId: session.sessionId,
      paneId: "pane:different",
      roomId: room.id,
      userId: "user:operator",
      ...firstIdentity,
      expectedActiveLeaseId: null,
      ttlSeconds: 30
    })).toThrow(SpaceNotFoundError);
  });
});
