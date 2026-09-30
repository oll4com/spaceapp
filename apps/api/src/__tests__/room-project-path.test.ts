import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomPaneCommands } from "../room-pane-commands.js";

describe("Room Project Path & CWD auto-propagation", () => {
  const now = new Date().toISOString();
  const mockOptions = {
    discover: async () => ({
      data: [
        {
          id: "cli:codex",
          providerId: "codex",
          providerName: "Codex",
          agentId: "codex",
          agentName: "Codex",
          displayName: "Codex CLI",
          capabilities: ["CLI" as const],
          status: "ENABLED" as const,
          adapterStatus: "ENABLED" as const,
          authState: "READY" as const,
          statusReason: null,
          cliCommand: "codex-vscode-parity",
          checkedAt: now
        }
      ],
      checkedAt: now
    }),
    enabledRuntimeIds: async () => ["cli:codex"],
    harnessAvailable: async () => true
  };

  it("creates a room with projectPath and persists it in memory store", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({
      name: "Agoda Coach Project",
      projectPath: "/var/lib/spaceapp-user/agent-workspace/active/20260820-agoda-interview-coach",
      initialPaneCount: 0
    });

    expect(room.name).toBe("Agoda Coach Project");
    expect(room.projectPath).toBe("/var/lib/spaceapp-user/agent-workspace/active/20260820-agoda-interview-coach");
  });

  it("updates room projectPath via updateRoom", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({
      name: "Test Room",
      initialPaneCount: 0
    });
    expect(room.projectPath).toBeNull();

    const updated = store.updateRoom(room.id, {
      name: "Updated Room",
      projectPath: "/var/lib/spaceapp-user/agent-workspace/active/my-new-project"
    });

    expect(updated.projectPath).toBe("/var/lib/spaceapp-user/agent-workspace/active/my-new-project");

    // Also clearing it
    const cleared = store.updateRoom(room.id, {
      name: "Cleared Room",
      projectPath: null
    });
    expect(cleared.projectPath).toBeNull();
  });

  it("propagates room projectPath to terminal panes created via room-pane-commands", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({
      name: "Project Room",
      projectPath: "/var/lib/spaceapp-user/agent-workspace/active/my-project",
      initialPaneCount: 0
    });

    const commands = createRoomPaneCommands({ ...(mockOptions as any), store });
    const resolved = await commands.resolve(room.id, [
      { mode: "TERMINAL", terminalRuntimeId: "cli:codex" }
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.mode).toBe("TERMINAL");
    expect(resolved[0]?.cwd).toBe("/var/lib/spaceapp-user/agent-workspace/active/my-project");
  });

  it("falls back to /etc if room has no projectPath", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({
      name: "Default Room",
      initialPaneCount: 0
    });

    const commands = createRoomPaneCommands({ ...(mockOptions as any), store });
    const resolved = await commands.resolve(room.id, [
      { mode: "TERMINAL", terminalRuntimeId: "cli:codex" }
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.cwd).toBe("/etc");
  });
});
