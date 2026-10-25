import { describe, expect, it, vi } from "vitest";
import { InMemoryControlRepository } from "@space/db";
import { createHeldDispatch, holdCalmPrompts, holdUnlessAllowed, mayDeliver, type HeldDelivery, type NousLoadLevel } from "../src/nous/held-dispatch.js";

const owner = "user:operator";
const andy = { roomId: "room:dino0001", roomName: "Dino", paneId: "pane:andy0001", paneName: "Andy" };
const bob = { roomId: "room:dino0001", roomName: "Dino", paneId: "pane:bob00001", paneName: "Bob" };

function fixture(level: NousLoadLevel = "BUSY", repository = new InMemoryControlRepository()) {
  const state = { level };
  const sent: HeldDelivery[] = [];
  const notices: Array<{ key: string; line: string }> = [];
  const deliver = vi.fn(async (item: HeldDelivery) => { sent.push(item); return { ok: true, result: "sent" }; });
  const held = createHeldDispatch({ repository, level: async () => state.level, deliver,
    notice: async (_owner, key, line) => { notices.push({ key, line }); }, now: () => "2026-10-17T10:31:00.000Z" });
  return { held, state, sent, notices, deliver, repository };
}

describe("Nous's held dispatch", () => {
  it("delivers normal work only when calm and light work also when busy, never when overloaded", () => {
    expect(mayDeliver("CALM", "normal")).toBe(true);
    expect(mayDeliver("BUSY", "normal")).toBe(false);
    expect(mayDeliver("BUSY", "light")).toBe(true);
    expect(mayDeliver("OVERLOADED", "light")).toBe(false);
  });

  it("holds texts per pane, first in first out, one per pane per tick once the server is calm, and tells Nous", async () => {
    const f = fixture("BUSY");
    expect(await f.held.hold(owner, andy, "Step 2 of the plan.")).toMatchObject({ waiting: 1 });
    expect(await f.held.hold(owner, andy, "Then step 3.")).toMatchObject({ waiting: 2 });
    await f.held.hold(owner, bob, "Run the scoped tests.");
    expect(await f.held.summary(owner)).toBe("Held for a calm server: 3 texts (Dino/Andy 2 since 10:31 UTC, Dino/Bob 1 since 10:31 UTC).");
    expect(await f.held.tick()).toEqual({ delivered: 0, failed: 0 });
    expect(f.sent).toEqual([]);

    f.state.level = "CALM";
    expect(await f.held.tick()).toEqual({ delivered: 2, failed: 0 });
    expect(f.sent.map((item) => `${item.paneName}: ${item.text}`).sort()).toEqual(["Andy: Step 2 of the plan.", "Bob: Run the scoped tests."]);
    expect(f.notices).toEqual([{ key: "held-delivered", line: expect.stringMatching(/^The server is CALM: delivered 2 held texts to Dino\/(Andy|Bob), Dino\/(Andy|Bob)\.$/) }]);
    await f.held.tick();
    expect(f.sent.at(-1)).toMatchObject({ paneName: "Andy", text: "Then step 3.", owner });
    expect(await f.held.summary(owner)).toBeNull();
    expect(await f.held.summary("user:someone")).toBeNull();
  });

  it("lets light work pass at BUSY ahead of a calm server, in its pane's order", async () => {
    const f = fixture("BUSY");
    await f.held.hold(owner, andy, "Read the failing test.", "light");
    await f.held.hold(owner, andy, "Then build it all.");
    await f.held.tick();
    await f.held.tick();
    expect(f.sent.map((item) => item.text)).toEqual(["Read the failing test."]);
  });

  it("keeps held texts across a restart (the queue is a stored record)", async () => {
    const repository = new InMemoryControlRepository();
    await fixture("OVERLOADED", repository).held.hold(owner, andy, "After the restart.");
    const restarted = fixture("CALM", repository);
    await restarted.held.tick();
    expect(restarted.sent.map((item) => item.text)).toEqual(["After the restart."]);
  });

  it("drops nothing silently: after three failed tries the text goes back to Nous's inbox", async () => {
    const f = fixture("CALM");
    f.deliver.mockImplementation(async () => ({ ok: false, result: "The pane is closed." }));
    await f.held.hold(owner, andy, "Never arrives.");
    await f.held.tick();
    await f.held.tick();
    expect(f.notices).toEqual([]);
    expect(await f.held.tick()).toEqual({ delivered: 0, failed: 1 });
    expect(f.notices).toEqual([{ key: expect.stringMatching(/^held-failed:nous_held:/), line: expect.stringContaining("could not be delivered (3 tries: The pane is closed.). Its text: \"Never arrives.\"") }]);
    expect(await f.held.summary(owner)).toBeNull();
  });

  it("holds a calm send only while the load does not allow it; urgent never waits", async () => {
    const f = fixture("BUSY");
    const nous = { level: async () => f.state.level, hold: f.held.hold };
    expect(await holdUnlessAllowed(nous, owner, [andy, bob], "Next step.")).toBe("The server is BUSY: held for Andy (1 waiting), Bob (1 waiting). "
      + "It goes when the server allows and you hear back in the inbox; priority \"urgent\" sends at once.");
    expect(await holdUnlessAllowed(nous, owner, [andy], "Look at the log.", "light")).toBeNull();
    expect(await holdUnlessAllowed(nous, owner, [andy], "Now.", "urgent")).toBeNull();
    f.state.level = "CALM";
    expect(await holdUnlessAllowed(nous, owner, [andy], "Calm now.")).toBeNull();
    expect(await f.held.summary(owner)).toContain("2 texts");
  });

  it("splits space_execute's calm prompts from the rest of the batch", async () => {
    const f = fixture("OVERLOADED");
    const nous = { level: async () => f.state.level, hold: f.held.hold };
    const room = { id: andy.roomId, name: "Dino" };
    const panes = [{ id: andy.paneId, paneName: "Andy", title: "x" }];
    const layout = { kind: "layout", operation: "apply" };
    const calm = { kind: "pane", operation: "prompt", target: { paneIds: [andy.paneId] }, text: "Step 3.", when: "calm", priority: "light" };
    const now = { kind: "pane", operation: "prompt", target: { paneIds: [andy.paneId] }, text: "Stop.", when: "NOW" };
    const held = await holdCalmPrompts(nous, owner, room, panes, [layout, calm, now]);
    expect(held.actions).toEqual([layout, now]);
    expect(held.held).toEqual([expect.stringContaining("The server is OVERLOADED: held for Andy (1 waiting)")]);
    f.state.level = "BUSY";
    expect((await holdCalmPrompts(nous, owner, room, panes, [calm])).actions)
      .toEqual([{ kind: "pane", operation: "prompt", target: { paneIds: [andy.paneId] }, text: "Step 3.", when: "AFTER_TURN" }]);
  });
});
