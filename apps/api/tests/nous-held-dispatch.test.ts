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

  it("R65-1: keeps a model through readiness failures until its empty prompt, but still reports permanent failures", async () => {
    const f = fixture("CALM");
    await f.held.hold(owner, andy, "Set the model", "light", { modelId: "gpt-6-astra", reasoningEffort: "high" });
    for (const result of ["Pane has no active session.", "Native state is unknown.", "Send or clear the current CLI draft before changing model settings.",
      "Wait for the OpenCode turn to finish.", "Wait for this CLI turn to finish before changing models."]) {
      f.deliver.mockResolvedValueOnce({ ok: false, result });
      expect(await f.held.tick()).toEqual({ delivered: 0, failed: 0 });
    }
    expect(f.notices).toEqual([]);
    expect(await f.held.tick()).toEqual({ delivered: 1, failed: 0 });
    expect(f.sent.at(-1)?.model).toEqual({ modelId: "gpt-6-astra", reasoningEffort: "high" });
    expect(await f.held.summary(owner)).toBeNull();
    await f.held.hold(owner, andy, "Set the model", "light", { modelId: "gpt-6-astra" });
    // 5/11 Bruno/Bob: a menu that did not confirm is a failed try, not a wait (it was retried each minute, each try an Esc "Kept model").
    f.deliver.mockResolvedValue({ ok: false, result: "Claude Code has not confirmed the model change." });
    await f.held.tick(); await f.held.tick();
    expect(await f.held.tick()).toEqual({ delivered: 0, failed: 1 });
    expect(f.notices.at(-1)).toMatchObject({ key: expect.stringMatching(/^held-failed:/), line: expect.stringContaining("has not confirmed the model change") });
  });

  it("R84 12/11: keeps a configure while its CLI has no session, then runs it once (13 configures in 7 d failed after the 30 s wait)", async () => {
    const f = fixture("CALM");
    const configure = { kind: "configure", accountProfileId: "space-gateway", when: "AFTER_TURN" };
    await f.held.hold(owner, andy, "Configure", "light", undefined, configure);
    f.deliver.mockResolvedValueOnce({ ok: false, result: '{"results":[{"status":"FAILED","detail":"Pane has no active session."}]}' });
    expect(await f.held.tick()).toEqual({ delivered: 0, failed: 0 });
    expect(await f.held.tick()).toEqual({ delivered: 1, failed: 0 });
    expect(f.sent.at(-1)).toMatchObject({ paneId: "pane:andy0001", configure });
    expect(await f.held.summary(owner)).toBeNull();
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

  it("names a pane not ready for input on 2 tries once, before the last try (2026-10-30 REVIEW: Alex/Dana read UNKNOWN)", async () => {
    const f = fixture("CALM");
    f.deliver.mockImplementation(async () => ({ ok: false, result: "Andy: not confirmed ready for input (state UNKNOWN)." }));
    await f.held.hold(owner, andy, "Next step.");
    await f.held.tick();
    expect(f.notices).toEqual([]);
    await f.held.tick();
    expect(f.notices).toEqual([{ key: expect.stringMatching(/^held-stuck:nous_held:/), line: expect.stringContaining("was not ready for input on 2 tries of a text held since") }]);
    expect(f.notices[0]!.line).toContain("restart it (space_restart_pane) and the text goes after. One try is left.");
    await f.held.tick();
    expect(f.notices.map((notice) => notice.key.split(":")[0])).toEqual(["held-stuck", "held-failed"]);
  });

  it("never types a text again that stayed an unsent draft: it leaves the queue and Space's own draft line is the only one (31/10 Alex/Max)", async () => {
    const f = fixture("CALM");
    f.deliver.mockImplementation(async () => ({ ok: false, result: "Max: The CLI kept the text as an unsent draft after Enter; it was not submitted." }));
    await f.held.hold(owner, andy, "Next step.");
    expect(await f.held.tick()).toEqual({ delivered: 0, failed: 1 });
    await f.held.tick();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.notices).toEqual([]);
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
