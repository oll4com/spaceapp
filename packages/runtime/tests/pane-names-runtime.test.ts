import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "../src/index.js";

describe("runtime pane names allocation", () => {
  it("allocates unique sequential names across both CLI and non-CLI panes", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Testing Room", paneCap: 16 });

    // 1. Chat pane (non-CLI)
    const chat = store.createPane({ roomId: room.id, title: "Chat", mode: "CHAT" });
    expect(chat.paneName).toBe("Andy");

    // 2. Terminal pane (CLI)
    const cli = store.createPane({ roomId: room.id, title: "Codex", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
    expect(cli.paneName).toBe("Bob");

    // 3. Databases pane (non-CLI)
    const db = store.createPane({ roomId: room.id, title: "Databases", mode: "DATABASES" });
    expect(db.paneName).toBe("Cody");

    // 4. Browser pane (non-CLI)
    const browser = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    expect(browser.paneName).toBe("Dana");

    // 5. YouTube pane (non-CLI)
    const yt = store.createPane({ roomId: room.id, title: "YouTube", mode: "YOUTUBE" });
    expect(yt.paneName).toBe("Emma");
  });

  it("reuses closed pane names for subsequent panes", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Reuse Room", paneCap: 16 });

    const p1 = store.createPane({ roomId: room.id, title: "P1", mode: "CHAT" }); // Andy
    const p2 = store.createPane({ roomId: room.id, title: "P2", mode: "TERMINAL" }); // Bob
    const p3 = store.createPane({ roomId: room.id, title: "P3", mode: "BROWSER" }); // Cody

    expect(p1.paneName).toBe("Andy");
    expect(p2.paneName).toBe("Bob");
    expect(p3.paneName).toBe("Cody");

    // Close Bob
    store.updatePane(p2.id, { isClosed: true });

    // Next pane should reuse Bob
    const p4 = store.createPane({ roomId: room.id, title: "P4", mode: "DATABASES" });
    expect(p4.paneName).toBe("Bob");

    // Next pane after Bob should be Dana
    const p5 = store.createPane({ roomId: room.id, title: "P5", mode: "CHAT" });
    expect(p5.paneName).toBe("Dana");
  });

  it("reopening a pane keeps its name if free, otherwise allocates first available", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Reopen Room", paneCap: 16 });

    const p1 = store.createPane({ roomId: room.id, title: "P1", mode: "CHAT" }); // Andy
    const p2 = store.createPane({ roomId: room.id, title: "P2", mode: "TERMINAL" }); // Bob

    // Close Andy
    store.updatePane(p1.id, { isClosed: true });

    // Open another pane that claims Andy
    const p3 = store.createPane({ roomId: room.id, title: "P3", mode: "BROWSER" });
    expect(p3.paneName).toBe("Andy");

    // Now reopen p1; its original name "Andy" is taken by p3, so it should get first available ("Cody")
    const reopenedP1 = store.updatePane(p1.id, { isClosed: false });
    expect(reopenedP1.paneName).toBe("Cody");
  });

  it("batch creation allocates distinct sequential names", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Batch Room", paneCap: 16 });

    const panes = store.createPanes([
      { roomId: room.id, title: "CLI", mode: "TERMINAL" },
      { roomId: room.id, title: "Chat", mode: "CHAT" },
      { roomId: room.id, title: "Files", mode: "FILES" },
      { roomId: room.id, title: "DB", mode: "DATABASES" }
    ]);

    expect(panes.map((p) => p.paneName)).toEqual(["Andy", "Bob", "Cody", "Dana"]);
  });

  it("moving a pane keeps its name if free in target room, else allocates first available", () => {
    const store = new InMemorySpaceStore();
    const r1 = store.createRoom({ name: "Room 1", paneCap: 16 });
    const r2 = store.createRoom({ name: "Room 2", paneCap: 16 });

    // Room 1 has Andy
    const p1 = store.createPane({ roomId: r1.id, title: "P1", mode: "CHAT" });
    expect(p1.paneName).toBe("Andy");

    // Room 2 already has Andy
    const r2p1 = store.createPane({ roomId: r2.id, title: "R2P1", mode: "CHAT" });
    expect(r2p1.paneName).toBe("Andy");

    // Move p1 to Room 2; Andy is taken in Room 2, so p1 should become Bob
    const moveResult = store.movePane(p1.id, { targetRoomId: r2.id });
    expect(moveResult.targetPane.paneName).toBe("Bob");
  });
});
