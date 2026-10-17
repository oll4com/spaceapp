import { describe, expect, it, vi } from "vitest";
import type { ControlOperation } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomAgentTools, roomAgentControlRisk, roomAgentToolDefinitions, type RoomAgentToolDeps } from "../src/room-agent-tools.js";

function operation(command: { roomId: string; requestId: string }, status: ControlOperation["status"] = "COMPLETED"): ControlOperation {
  const at = new Date().toISOString();
  return { id: "operation:test", actorId: "user:operator", roomId: command.roomId, requestId: command.requestId, payloadHash: "hash", status,
    createdAt: at, updatedAt: at, results: [{ index: 0, status: status === "FAILED" ? "FAILED" : "COMPLETED", detail: status === "FAILED" ? "Pane is busy." : "Done.", evidence: {} }],
    cancelRequested: false, nextIndex: 1 };
}

function fixture(screen = "Allow running npm test?\n❯ 1. Yes\n  2. No") {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Tools", initialPaneCount: 0 });
  const [bob, dana] = ["Bob", "Dana"].map((title) => store.createPane({ roomId: room.id, title, mode: "TERMINAL", terminalRuntimeId: "cli:codex" }));
  store.updatePane(bob!.id, { paneName: "Bob" });
  store.updatePane(dana!.id, { paneName: "Dana" });
  const agentPane = store.getOrCreateRoomAgentPane(room.id);
  const monitorEvents = [{ eventId: "event:waiting", roomId: room.id, paneId: bob!.id, paneName: "Bob", kind: "WAITING" as const, severity: "ATTENTION" as const,
    title: "Bob is waiting", detail: null, status: "OPEN" as const, decision: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
  const deps = {
    listPanes: async (roomId: string) => store.listPanes(roomId, true),
    describeRoom: async () => "Room activity: 2 open panes.",
    inspectPane: vi.fn(async (pane) => ({ paneId: pane.id, title: pane.title, runtimeId: "cli:codex", sessionId: "cli_session:bob", state: "WAITING_FOR_INPUT" as const,
      nativeTaskRef: null, modelId: "gpt-5.5", nativeMode: null, checkedAt: new Date().toISOString(), tasks: [], text: screen, promptFingerprint: "fingerprint:1" })),
    interruptPane: vi.fn(async () => ({ interrupted: true })),
    answerCli: vi.fn(async () => ({})),
    controlExecute: vi.fn(async (_actorId: string, command: { roomId: string; requestId: string }) => operation(command)),
    controlCall: vi.fn(async () => ({ status: "COMPLETED" })),
    openPanes: vi.fn(async () => ["Andy", "Cody", "Emma"]),
    search: vi.fn(async () => "Opened Google search for “books”."),
    monitor: {
      listEvents: vi.fn(async () => monitorEvents),
      updateEvent: vi.fn(async (eventId: string, patch: { status?: string; decision?: string | null }) => ({ ...monitorEvents[0]!, eventId, ...patch }) as never),
      changed: vi.fn(async () => {})
    }
  } satisfies RoomAgentToolDeps;
  const tools = createRoomAgentTools(deps);
  const ctx = { roomId: room.id, agentPaneId: agentPane.id, actorId: "user:operator", requestId: "room-agent:request-0001", traceId: "trace:tools" };
  return { store, room, bob: bob!, dana: dana!, agentPane, deps, tools, ctx };
}

describe("Room Agent tools", () => {
  it("publishes plain JSON schemas for every tool", () => {
    expect(roomAgentToolDefinitions.map((tool) => tool.function.name)).toEqual(["room_status", "read_pane", "send_to_pane", "answer_pane_prompt",
      "stop_pane", "open_panes", "close_pane", "reopen_pane", "restart_pane", "arrange_panes", "set_pane_model", "space_control", "search_web_in_browser", "confirm_action", "space_room_release"]);
    for (const tool of roomAgentToolDefinitions) expect(tool.function.parameters).toMatchObject({ type: "object" });
  });

  it("answers a safe prompt bound to the inspected question and settles the monitor event", async () => {
    const c = fixture();
    const outcome = await c.tools.execute("answer_pane_prompt", { pane: "bob", answer: "1" }, c.ctx);
    expect(outcome).toMatchObject({ ok: true, display: 'Answered Bob: "1"' });
    expect(c.deps.answerCli).toHaveBeenCalledWith(expect.objectContaining({ id: c.bob.id }),
      { sessionId: "cli_session:bob", answer: "1", submit: true, expectedPromptFingerprint: "fingerprint:1" }, "trace:tools");
    expect(c.deps.monitor.updateEvent).toHaveBeenCalledWith("event:waiting", { status: "HANDLED", decision: 'The Room Agent answered "1" for you.' }, ["OPEN", "ESCALATED"]);
    expect(c.deps.monitor.changed).toHaveBeenCalledOnce();
  });

  it("never answers a protected prompt and asks before a destructive one", async () => {
    const guarded = fixture("Run `git push origin main`?\n❯ 1. Yes\n  2. No");
    const refused = await guarded.tools.execute("answer_pane_prompt", { pane: "Bob", answer: "1" }, guarded.ctx);
    expect(refused).toMatchObject({ ok: false, refused: expect.stringContaining("git push") });
    expect(guarded.deps.answerCli).not.toHaveBeenCalled();
    const confirmed = await guarded.tools.execute("answer_pane_prompt", { pane: "Bob", answer: "1" }, { ...guarded.ctx, confirmed: true });
    expect(confirmed.refused).toBeTruthy();
    expect(guarded.deps.answerCli).not.toHaveBeenCalled();

    const destructive = fixture("Run rm -rf build/?\n❯ 1. Yes\n  2. No");
    const ask = await destructive.tools.execute("answer_pane_prompt", { pane: "Bob", answer: "1" }, destructive.ctx);
    expect(ask.needsConfirmation).toEqual({ action: 'Answer "1" to Bob\'s prompt (recursive delete)',
      args: { pane: "Bob", answer: "1", expectedPromptFingerprint: "fingerprint:1" } });
    expect(destructive.deps.answerCli).not.toHaveBeenCalled();
    const yes = await destructive.tools.execute("answer_pane_prompt", ask.needsConfirmation!.args, { ...destructive.ctx, confirmed: true });
    expect(yes.ok).toBe(true);
    expect(destructive.deps.answerCli).toHaveBeenCalledOnce();
    destructive.deps.inspectPane.mockImplementationOnce(async (pane) => ({ paneId: pane.id, title: pane.title, runtimeId: "cli:codex", sessionId: "cli_session:bob",
      state: "WAITING_FOR_INPUT" as const, nativeTaskRef: null, modelId: null, nativeMode: null, checkedAt: new Date().toISOString(), tasks: [], text: "another question", promptFingerprint: "fingerprint:2" }));
    const changed = await destructive.tools.execute("answer_pane_prompt", ask.needsConfirmation!.args, { ...destructive.ctx, confirmed: true });
    expect(changed).toMatchObject({ ok: false, display: "Bob's question changed" });
    expect(destructive.deps.answerCli).toHaveBeenCalledOnce();
    const decline = await destructive.tools.execute("answer_pane_prompt", { pane: "Bob", decline: true }, destructive.ctx);
    expect(decline).toMatchObject({ ok: true, display: "Declined Bob's prompt" });
    expect(destructive.deps.answerCli).toHaveBeenLastCalledWith(expect.anything(), { sessionId: "cli_session:bob", key: "ESCAPE" }, "trace:tools");
  });

  it("sends to panes by name, never targets the Room Agent's own pane and names the open panes when one is missing", async () => {
    const c = fixture();
    const sent = await c.tools.execute("send_to_pane", { panes: ["Bob", "dana"], text: "run the tests" }, c.ctx);
    expect(sent).toMatchObject({ ok: true, display: "Sent to Bob and Dana" });
    expect(c.deps.controlExecute).toHaveBeenCalledWith("user:operator", { roomId: c.room.id, requestId: "room-agent:request-0001",
      actions: [{ kind: "pane", operation: "prompt", target: { paneIds: [c.bob.id, c.dana.id], state: "OPEN" }, text: "run the tests", when: "AFTER_TURN" }] });
    const missing = await c.tools.execute("send_to_pane", { panes: ["Zed"], text: "hi" }, c.ctx);
    expect(missing.result).toBe('No pane named "Zed" in this room. Open panes: Bob, Dana.');
    const self = await c.tools.execute("read_pane", { pane: c.agentPane.id }, c.ctx);
    expect(self.ok).toBe(false);
  });

  it("asks before closing, stopping or restarting and closes only when confirmed", async () => {
    const c = fixture();
    for (const [name, args] of [["close_pane", { panes: ["Bob"] }], ["restart_pane", { panes: ["Bob"] }], ["stop_pane", { pane: "Bob" }]] as const) {
      const outcome = await c.tools.execute(name, args, c.ctx);
      expect(outcome.needsConfirmation?.args).toEqual(args);
    }
    expect(c.deps.controlExecute).not.toHaveBeenCalled();
    expect(c.deps.interruptPane).not.toHaveBeenCalled();
    const closed = await c.tools.execute("close_pane", { panes: ["Bob"] }, { ...c.ctx, confirmed: true });
    expect(closed).toMatchObject({ ok: true, display: "Closed Bob" });
    expect(c.deps.controlExecute).toHaveBeenCalledWith("user:operator", expect.objectContaining({ userExplicitlyAuthorized: true,
      actions: [{ kind: "pane", operation: "close", target: { paneIds: [c.bob.id], state: "ALL" }, when: "NOW" }] }));
    c.deps.controlExecute.mockImplementationOnce(async (_actorId, command) => operation(command, "FAILED"));
    const failed = await c.tools.execute("restart_pane", { panes: ["Bob"] }, { ...c.ctx, confirmed: true });
    expect(failed).toMatchObject({ ok: false, display: "Could not restart Bob: Pane is busy." });
  });

  it("opens panes by type, arranges the room and searches the selected browser", async () => {
    const c = fixture();
    expect(await c.tools.execute("open_panes", { panes: [{ type: "codex", count: 2 }, { type: "browser", count: 1 }] }, c.ctx))
      .toMatchObject({ ok: true, display: "Opened 2 Codex panes, 1 Browser pane", result: "Opened 3 panes: Andy, Cody, Emma. They connect in a few seconds." });
    expect(c.deps.openPanes).toHaveBeenCalledWith({ roomId: c.room.id, actorId: "user:operator", requestId: "room-agent:request-0001", traceId: "trace:tools", counts: { codex: 2, browser: 1 } });
    expect((await c.tools.execute("open_panes", { panes: [{ type: "codex", count: 16 }, { type: "claude", count: 1 }] }, c.ctx)).ok).toBe(false);
    expect(await c.tools.execute("arrange_panes", { operation: "grid", columns: 3 }, c.ctx)).toMatchObject({ ok: true, display: "Arranged the panes in 3 columns" });
    expect(await c.tools.execute("arrange_panes", { operation: "maximize", panes: ["Dana"] }, c.ctx)).toMatchObject({ ok: true, display: "Maximized Dana" });
    expect((await c.tools.execute("arrange_panes", { operation: "focus" }, c.ctx)).ok).toBe(false);
    await c.tools.execute("search_web_in_browser", { query: "books" }, { ...c.ctx, selectedBrowserPaneId: "pane:browser" });
    expect(c.deps.search).toHaveBeenCalledWith(expect.objectContaining({ query: "books", engine: "GOOGLE", paneId: "pane:browser" }));
  });

  it("guards Space Control: protected deploys are refused, destructive batches wait for a yes, reads go through", async () => {
    expect(roomAgentControlRisk("space_execute", { actions: [{ kind: "resource", operation: "ops.deploy" }] }).level).toBe("PROTECTED");
    expect(roomAgentControlRisk("space_execute", { actions: [{ kind: "pane", operation: "prompt" }, { kind: "pane", operation: "close" }] }))
      .toEqual({ level: "DESTRUCTIVE", reason: "close panes" });
    expect(roomAgentControlRisk("space_schedules", { command: { actions: [{ kind: "resource", operation: "files.delete" }] } }).level).toBe("DESTRUCTIVE");
    expect(roomAgentControlRisk("space_inspect", { section: "STATE" }).level).toBe("SAFE");
    const c = fixture();
    const deploy = await c.tools.execute("space_control", { tool: "space_execute", arguments: { actions: [{ kind: "resource", operation: "ops.deploy" }] } }, { ...c.ctx, confirmed: true });
    expect(deploy.refused).toBeTruthy();
    const close = await c.tools.execute("space_control", { tool: "space_execute", arguments: { actions: [{ kind: "pane", operation: "close", target: { paneNames: ["Bob"] } }], userExplicitlyAuthorized: true } }, c.ctx);
    expect(close.needsConfirmation).toBeTruthy();
    expect(c.deps.controlCall).not.toHaveBeenCalled();
    await c.tools.execute("space_control", { tool: "space_inspect", arguments: { section: "STATE", roomId: "room:other" } }, c.ctx);
    expect(c.deps.controlCall).toHaveBeenCalledWith("user:operator", "space_inspect", { section: "STATE", roomId: c.room.id });
    await c.tools.execute("space_control", { tool: "space_execute", arguments: { actions: [{ kind: "pane", operation: "prompt", target: { paneNames: ["Bob"] }, text: "hi" }], requestId: "model-chosen" } }, c.ctx);
    expect(c.deps.controlCall).toHaveBeenLastCalledWith("user:operator", "space_execute", expect.objectContaining({ roomId: c.room.id, requestId: "room-agent:request-0001", waitForCompletion: false }));
  });

  it("changes the release train for a pane named in the room and passes refusals back", async () => {
    const c = fixture();
    const releaseTrain = vi.fn(async (input: { op: string }) => {
      if (input.op === "open") throw new Error("run-spaceapp 1.1.5 is open (captain Bob): join it instead of cutting your own version.");
      return "- run-spaceapp 1.1.5: OPEN";
    });
    const tools = createRoomAgentTools({ ...c.deps, releaseTrain });
    expect(await tools.execute("space_room_release", { op: "join", pane: "dana", commit: "3707cca9af" }, c.ctx)).toMatchObject({ ok: true, result: "- run-spaceapp 1.1.5: OPEN" });
    expect(releaseTrain).toHaveBeenCalledWith({ op: "join", product: "run-spaceapp", commit: "3707cca9af" }, { roomId: c.room.id, pane: { paneId: c.dana.id, name: "Dana" }, paneSelf: false });
    expect(await tools.execute("space_room_release", { op: "open", version: "1.1.6", pane: "dana" }, c.ctx)).toMatchObject({ ok: false, result: expect.stringContaining("join it instead") });
    expect(await tools.execute("space_room_release", { op: "join", pane: "zed", commit: "3707cca9af" }, c.ctx)).toMatchObject({ ok: false, result: expect.stringContaining('No pane named "zed"') });
  });

  it("rejects invalid arguments and acts only for an authenticated operator", async () => {
    const c = fixture();
    expect(await c.tools.execute("send_to_pane", { panes: [] }, c.ctx)).toMatchObject({ ok: false, result: expect.stringContaining("Invalid arguments") });
    expect(await c.tools.execute("send_to_pane", { panes: ["Bob"], text: "hi" }, { ...c.ctx, actorId: null })).toMatchObject({ ok: false, refused: "This needs an authenticated operator in the room." });
    expect(await c.tools.execute("room_status", {}, { ...c.ctx, actorId: null })).toMatchObject({ ok: true, result: "Room activity: 2 open panes." });
    expect(await c.tools.execute("no_such_tool", {}, c.ctx)).toMatchObject({ ok: false });
  });
});
