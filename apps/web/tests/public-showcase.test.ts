import { describe, expect, it } from "vitest";
import { createShowcaseFixture } from "../src/demo/showcase-fixture.js";
import { createCurrentMockFixture } from "../src/demo/mock-fixture.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";

describe("isolated public showcase", () => {
  it("leaves normal demo data untouched and gives each tour room a complete workspace", () => {
    const normal = createCurrentMockFixture();
    const tour = createShowcaseFixture();
    expect(normal.rooms.map((r) => r.name)).toEqual([
      "Room 1",
      "Research Lab",
      "Operations",
      "Copilots (coming next)",
    ]);
    expect(tour.rooms.map((r) => r.name)).toEqual([
      "Build",
      "Research",
      "Create",
      "Remote",
    ]);
    expect(new Set(tour.panes.map((p) => p.id)).size).toBe(tour.panes.length);
    for (const room of tour.rooms)
      expect(tour.panes.filter((p) => p.roomId === room.id)).toHaveLength(4);
    expect(new Set(tour.panes.map((p) => p.mode))).toEqual(
      new Set([
        "TERMINAL",
        "CHAT",
        "BROWSER",
        "YOUTUBE",
        "FILES",
        "DEMOS",
        "LIVE",
        "HARNESS",
        "VNC",
      ]),
    );
    tour.rooms[0]!.name = "changed";
    expect(createCurrentMockFixture().rooms[0]!.name).toBe("Room 1");
  });
  it("uses the existing simulated runtime, including a local Harness surface", async () => {
    const { runtime } = createDemoRuntime({ fixture: createShowcaseFixture() });
    expect(runtime.api.harnessUrl).toContain("demo/media/harness-preview.html");
    const agent = await runtime.api.roomAgent(createShowcaseFixture().rooms[0]!.id);
    expect(agent.messages).toHaveLength(2);
    expect(agent.roomInventory?.totalPanes).toBe(4);
  });
});
