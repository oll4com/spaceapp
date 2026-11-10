import { describe, expect, it } from "vitest";
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
