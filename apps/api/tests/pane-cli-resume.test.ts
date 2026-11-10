import { describe, expect, it, vi } from "vitest";
import { getApiConfig } from "../src/config.js";
import { createPaneCliResume, resumeAccountSource } from "../src/pane-cli-resume.js";

const pane = { id: "pane:one", roomId: "room:one", mode: "TERMINAL", terminalRuntimeId: "cli:codex" };
const task = { taskId: "cli_task:one", title: "Fix the build", runtimeId: "cli:codex", session: { roomId: "room:other" }, revision: {} };

function fixture() {
  const getTask = vi.fn(async () => task);
  const { resumePaneCliTask } = createPaneCliResume({
    store: { getActivePaneCliSession: async () => null } as never,
    eventBus: { publish: vi.fn() },
    // Every CLI runtime is discovered DISABLED under this config, so no binary is probed or started.
    config: getApiConfig({ SPACE_CLI_ENABLED: "false" }),
    cliTerminalManager: {} as never,
    cliRuntimeVisibility: { assertEnabled: async () => undefined } as never,
    unifiedCliTaskRegistry: { getTask } as never,
    visibleCliRuntimeIds: async () => ["cli:root", "cli:codex"],
    codexParity: {} as never,
    codexHistoryAccessCoordinator: { withHistoryAttachment: vi.fn() } as never,
    resolveCliSessionAccountProfile: vi.fn() as never,
    assertRoomAccess: vi.fn()
  });
  return { resumePaneCliTask, getTask };
}

describe("pane CLI resume", () => {
  it("needs a task reference, and the Room Agent resumes only its own room's tasks", async () => {
    const { resumePaneCliTask, getTask } = fixture();
    await expect(resumePaneCliTask(pane as never, {}, "trace:one")).rejects.toThrow("Space CLI task reference was not provided.");
    expect(getTask).not.toHaveBeenCalled();
    await expect(resumePaneCliTask(pane as never, { taskId: task.taskId }, "trace:one", undefined, true))
      .rejects.toThrow("Room Agent can resume only tasks belonging to this room.");
    expect(getTask).toHaveBeenCalledWith(task.taskId, ["cli:root", "cli:codex"]);
  });

  it("refuses a runtime it cannot find, one without CLI sessions and one that is switched off", async () => {
    const { resumePaneCliTask } = fixture();
    await expect(resumePaneCliTask({ ...pane, terminalRuntimeId: "cli:nope" } as never, { taskId: task.taskId }, "trace:one"))
      .rejects.toThrow("CLI runtime cli:nope was not found.");
    await expect(resumePaneCliTask({ ...pane, terminalRuntimeId: "web:codex-app-server" } as never, { threadId: "thread" }, "trace:one"))
      .rejects.toThrow("Runtime web:codex-app-server does not support CLI sessions.");
    await expect(resumePaneCliTask(pane as never, { taskId: task.taskId }, "trace:one")).rejects.toMatchObject({ errorCode: "CLI_RUNTIME_DISABLED", details: { runtimeId: "cli:codex", status: "DISABLED" } });
  });

  // EXT-G-6 (2/11 dev): a Gemini pane on space-gateway resumed on main and agy opened another conversation.
  it("a Gemini task resumes on the account it ran on; other terminals keep the resolver's default", () => {
    const session = { accountProfileId: "space-gateway" };
    expect(resumeAccountSource({ mode: "TERMINAL" }, "cli:gemini", { runtimeId: "cli:gemini", session })).toBe(session);
    expect(resumeAccountSource({ mode: "JOB_APPLY" }, "cli:claude", { runtimeId: "cli:claude", session })).toBe(session);
    expect(resumeAccountSource({ mode: "TERMINAL" }, "cli:codex", { runtimeId: "cli:codex", session })).toBeNull();
    expect(resumeAccountSource({ mode: "TERMINAL" }, "cli:gemini", { runtimeId: "cli:claude", session })).toBeNull();
  });
});
