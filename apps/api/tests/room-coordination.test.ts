import { describe, expect, it, vi } from "vitest";
import type { RoomAgentEvent } from "@space/contracts";
import { InMemoryControlRepository } from "@space/db";
import { SpaceConflictError } from "@space/runtime";
import { createRoomCoordination } from "../src/room-coordination.js";

const at = "2026-10-15T07:00:00.000Z";
const event: RoomAgentEvent = { eventId: "room_agent_event:overlap1", roomId: "room:coord0001", paneId: null, paneName: null, kind: "OVERLAP", severity: "ATTENTION",
  title: "Finn and Jack change the same files", detail: "Shared files: a.ts.", status: "OPEN", decision: null, createdAt: at, updatedAt: at };

function setup(chat: { running?: boolean; pending?: number; tools?: boolean } = {}) {
  const coordination = createRoomCoordination({ store: { listPanes: async () => [], getPane: vi.fn(), getRoom: vi.fn() } as never,
    controlRepository: new InMemoryControlRepository(), describeRoom: async () => "Room" });
  const send = vi.fn(async () => ({}));
  const room = { owner: async () => "user:operator", send,
    chat: { isRunning: () => chat.running ?? false, pendingConfirmations: () => chat.pending ? [{ expiresAt: Date.now() + chat.pending }] : [],
      toolsAvailable: async () => chat.tools ?? true } };
  return { coordinate: () => coordination.coordinate(event, room), send };
}

describe("room coordination", () => {
  it("starts a Room Agent turn as the owner with only the overlap title, and waits while it cannot act", async () => {
    const ready = setup();
    expect(await ready.coordinate()).toBe(true);
    expect(ready.send).toHaveBeenCalledWith("room:coord0001", expect.stringMatching(/^Room monitor: Finn and Jack change the same files\.\n/), "coordinate:room_agent_event:overlap1",
      expect.any(String), { holderType: "OPERATOR", holderId: "user:operator" });
    expect(String((ready.send.mock.calls[0] as unknown[])[1])).not.toContain("a.ts");

    for (const busy of [setup({ running: true }), setup({ pending: 60_000 }), setup({ tools: false })]) {
      expect(await busy.coordinate()).toBe(false);
      expect(busy.send).not.toHaveBeenCalled();
    }
    const conflict = setup();
    conflict.send.mockRejectedValueOnce(new SpaceConflictError("The Room Agent is still answering."));
    expect(await conflict.coordinate()).toBe(false);
  });
});
