import { describe, expect, it } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { renderNousWorld } from "../src/nous/digest.js";

// R40-2 (48 h to 2/11: 16 space_open_panes refused "Room … is capped at 16 active panes"): each room's heading says how full it is.
describe("Nous world: room fill", () => {
  const pane = (id: string, name: string) => ({ id, roomId: "room:a", mode: "TERMINAL", title: name, paneName: name, isClosed: false }) as Pane;
  const world = (rooms: Array<{ room: Room; panes: Pane[] }>) => renderNousWorld({
    rooms: rooms.map(({ room, panes }) => ({ room, sample: { data: panes, activity: {}, details: {}, sampledAt: "" } })) as never,
    notifications: [], plans: [], tasks: [], trains: "", decisions: [], notes: [], now: "2026-11-02T13:00:00.000Z" });

  it("names a full room and the fill of the others", () => {
    const full = { id: "room:a", name: "Bruno", paneCap: 2 } as Room;
    const roomy = { id: "room:b", name: "Eva", paneCap: 16 } as Room;
    const text = world([{ room: full, panes: [pane("pane:1", "Andy"), pane("pane:2", "Bob")] }, { room: roomy, panes: [pane("pane:3", "Cody")] }]);
    expect(text).toContain("### Bruno (full: 2 of 2 panes open; space_open_panes here is refused until a finished pane closes: open new panes in a room with space)");
    expect(text).toContain("### Eva (1 of 16 panes open)");
  });
});
