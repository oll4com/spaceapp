import { describe, expect, it } from "vitest";
import { SpaceFeatureDisabledError } from "@space/runtime";
import { idleProofRooms } from "../src/proof-room-sweep.js";
import { deleteRoomWithTeardown } from "../src/room-routes.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const room = (id: string, kind: string, updatedMinutesAgo: number) => ({ id, kind, name: id, updatedAt: ago(updatedMinutesAgo), ownerUserId: null });
const pane = (id: string, roomId: string, updatedMinutesAgo: number, isClosed = false) => ({ id, roomId, isClosed, updatedAt: ago(updatedMinutesAgo) });

describe("Agent Proof room autosweep (operator 2/11 10:04 BKK)", () => {
  it("picks only abandoned AGENT_PROOF rooms: empty for 30 minutes, or panes idle for 6 hours", async () => {
    const rooms = [
      room("room:emptyOld", "AGENT_PROOF", 31), room("room:emptyNew", "AGENT_PROOF", 29), room("room:closedPaneRecent", "AGENT_PROOF", 120),
      room("room:workspace", "WORKSPACE", 10_000), room("room:idlePanes", "AGENT_PROOF", 600), room("room:working", "AGENT_PROOF", 600),
      room("room:recentTurn", "AGENT_PROOF", 600)
    ];
    const panes: Record<string, ReturnType<typeof pane>[]> = {
      "room:closedPaneRecent": [pane("pane:c", "room:closedPaneRecent", 5, true)],
      "room:idlePanes": [pane("pane:i", "room:idlePanes", 400)],
      "room:working": [pane("pane:w", "room:working", 400)],
      "room:recentTurn": [pane("pane:r", "room:recentTurn", 400)]
    };
    const details: Record<string, Record<string, { status: string; since?: string; source: string }>> = {
      "room:idlePanes": { "pane:i": { status: "idle", since: ago(370), source: "native" } },
      "room:working": { "pane:w": { status: "working", since: ago(500), source: "native" } },
      "room:recentTurn": { "pane:r": { status: "done", since: ago(60), source: "native" } }
    };
    const idle = await idleProofRooms({
      store: { listRooms: async () => rooms, listPanes: async (roomId: string) => panes[roomId] ?? [] } as never,
      readDetails: async (roomId) => (details[roomId] ?? {}) as never, now: NOW
    });
    expect(idle.map((entry) => entry.id)).toEqual(["room:emptyOld", "room:idlePanes"]);
  });

  it("deletes through the room delete path and audits the sweep's reason", async () => {
    const audits: Array<Record<string, unknown>> = [];
    const removed: string[] = [];
    const proofState = { removeProofState: async (key: string) => { removed.push(key); } };
    const deleted = await deleteRoomWithTeardown({
      config: { browserEvidenceArtifactRoot: "/tmp/none" }, cliRenderAi: { dispose: () => undefined },
      store: { listPanes: async () => [], deleteRoom: async (id: string) => ({ ...room(id, "AGENT_PROOF", 31), paneCap: 16, description: null }) },
      browserSessionManager: { stopPane: async () => undefined }, cliTerminalManager: { detachSession: async () => undefined },
      youtubePlaybackStore: proofState, youtubeAccountStore: proofState, browserAccountStore: proofState
    } as never, "room:emptyOld", {
      traceId: "trace:sweep", actor: { holderType: "OPERATOR", holderId: "space:proof-room-autosweep" }, proofStateUserId: "user:operator",
      log: { info: () => undefined, error: () => undefined } as never, reason: "proof-room-autosweep", audit: async (input) => { audits.push(input); }
    });
    expect(deleted.id).toBe("room:emptyOld");
    expect(removed).toEqual(Array(3).fill("user:operator:proof:room:emptyOld"));
    expect(audits).toEqual([expect.objectContaining({ action: "room.delete", targetId: "room:emptyOld", metadata: expect.objectContaining({ reason: "proof-room-autosweep" }) })]);
  });
});

describe("Room delete while the Browser Host is down (operator 10/11 23:46 BKK, Hetzner clone)", () => {
  it("deletes the room when stopPane answers BROWSER_HOST_UNAVAILABLE, counting it in the audit; any other stop error still refuses", async () => {
    let stopError: Error = new SpaceFeatureDisabledError("BROWSER_HOST_UNAVAILABLE", "The Browser Host is unavailable.", { hostCode: "BROWSER_HOST_UNAVAILABLE" });
    const audits: Array<Record<string, unknown>> = [];
    const deletedIds: string[] = [];
    const proofState = { removeProofState: async () => undefined };
    const remove = () => deleteRoomWithTeardown({
      config: { browserEvidenceArtifactRoot: "/tmp/none" }, cliRenderAi: { dispose: () => undefined },
      store: { listPanes: async () => [{ id: "pane:b", roomId: "room:clone", mode: "BROWSER", isClosed: false }],
        getActivePaneBrowserSession: async (paneId: string) => ({ paneId, sessionId: "browser:1" }),
        deleteRoom: async (id: string) => { deletedIds.push(id); return { ...room(id, "WORKSPACE", 5), paneCap: 16, description: null }; } },
      browserSessionManager: { stopPane: async () => { throw stopError; } }, cliTerminalManager: { detachSession: async () => undefined },
      youtubePlaybackStore: proofState, youtubeAccountStore: proofState, browserAccountStore: proofState
    } as never, "room:clone", {
      traceId: "trace:delete", actor: { holderType: "OPERATOR", holderId: "user:operator" }, proofStateUserId: "user:operator",
      log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never, audit: async (input) => { audits.push(input); }
    });
    expect((await remove()).id).toBe("room:clone");
    expect(audits[0]).toMatchObject({ action: "room.delete", metadata: { closedBrowserSessions: 0, browserStopSkippedHostDown: 1 } });
    stopError = new SpaceFeatureDisabledError("BROWSER_SESSIONS_DISABLED", "Browser sessions are disabled.");
    await expect(remove()).rejects.toBe(stopError);
    expect(deletedIds).toEqual(["room:clone"]);
  });
});
