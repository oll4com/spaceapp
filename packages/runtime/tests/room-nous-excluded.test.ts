import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "../src/index.js";

describe("room Nous switch", () => {
  it("keeps nousExcluded across later renames until it is switched back", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Dino", initialPaneCount: 0 });
    expect(store.updateRoom(room.id, { name: "Dino", nousExcluded: true }).nousExcluded).toBe(true);
    expect(store.updateRoom(room.id, { name: "Dino 2" }).nousExcluded).toBe(true);
    expect(store.updateRoom(room.id, { name: "Dino 2", nousExcluded: false }).nousExcluded).toBe(false);
  });
});
