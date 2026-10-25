import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createDashboardCliProofController, dashboardProofTasks, redactProofScreenTail } from "../src/agents-dashboard-proof.js";
import { cliInputProofRoomDescriptionPrefix } from "../src/proof-room-routes.js";

function fixture(options: { kind?: "AGENT_PROOF" | "WORKSPACE"; runtimeId?: string; cwd?: string } = {}) {
  const store = new InMemorySpaceStore();
  const runtimeId = options.runtimeId ?? "cli:qwen";
  const room = store.createRoom({ name: "Agent Proof · dashboard", description: `${cliInputProofRoomDescriptionPrefix}${runtimeId}]`, initialPaneCount: 0, kind: options.kind ?? "AGENT_PROOF" });
  const pane = store.createPane({ roomId: room.id, title: "Qwen Code CLI", mode: "TERMINAL", terminalRuntimeId: runtimeId, cwd: options.cwd ?? "/etc" });
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId, providerId: "qwen", agentId: "qwen", purpose: "NORMAL", status: "RUNNING" });
  const send = vi.fn(async () => ({ submitted: true }));
  const interrupt = vi.fn(async () => ({}));
  const screen = vi.fn(async () => "Signed in as operator@example.com\n⠼ Thinking... (esc to cancel, 4s)\n> Type your message");
  const controller = createDashboardCliProofController({ store, send, interrupt, screen });
  return { store, room, pane, session, send, interrupt, screen, controller };
}

describe("agents dashboard CLI proof", () => {
  it("sends only the fixed task to an owned single-pane CLI input proof room", async () => {
    const { room, pane, session, send, controller } = fixture();
    const result = await controller.start(room.id, "STREAM", "trace:dashboard-proof");
    expect(result).toMatchObject({ submitted: true, task: "STREAM", paneId: pane.id, sessionId: session.sessionId, runtimeId: "cli:qwen" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: pane.id }), dashboardProofTasks.STREAM, "trace:dashboard-proof");
    controller.close();
  });
  it("refuses operator rooms and changed fixtures", async () => {
    const workspace = fixture({ kind: "WORKSPACE" });
    await expect(workspace.controller.start(workspace.room.id, "STREAM", "trace:x")).rejects.toThrow(/proof room/);
    expect(workspace.send).not.toHaveBeenCalled();
    const elsewhere = fixture({ cwd: "/opt/spaceapp" });
    await expect(elsewhere.controller.screen(elsewhere.room.id)).rejects.toThrow(/proof room/);
    const extra = fixture();
    extra.store.createPane({ roomId: extra.room.id, title: "Second", mode: "TERMINAL", terminalRuntimeId: "cli:qwen", cwd: "/etc" });
    await expect(extra.controller.start(extra.room.id, "SHELL", "trace:x")).rejects.toThrow(/proof room/);
  });
  it("interrupts on request and reads the classified, redacted status lines", async () => {
    const { room, interrupt, controller } = fixture();
    await controller.start(room.id, "SHELL", "trace:x");
    expect(await controller.interrupt(room.id, "trace:y")).toEqual({ interrupted: true, roomId: room.id });
    expect(interrupt).toHaveBeenCalledOnce();
    const screen = await controller.screen(room.id);
    expect(screen).toMatchObject({ state: "RUNNING", rule: "busy-key" });
    expect(screen.tail.join("\n")).not.toContain("operator@example.com");
    expect(redactProofScreenTail("key sk-abcdefghijklmnop and ghp_ABCDEFGHIJKLMNOPQRSTUV")).toEqual(["key <secret> and <secret>"]);
  });
});
