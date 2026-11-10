import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneCliSession } from "@space/contracts";

// ADAPTER-010: a Gemini pane's account switch relaunches its CLI on the pane's own conversation (the wrapper reads pane-<id>.json
// and runs `agy --conversation <id>` on `--continue`), never a fresh one with that file deleted.
const conversation = "0f8e4c2a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const files = vi.hoisted(() => ({ conversation: null as string | null, unlinked: [] as string[] }));
vi.mock("../src/gemini-native-session.js", async (orig) => ({ ...await orig<object>(),
  readGeminiPaneConversation: vi.fn(async () => files.conversation),
  writeGeminiPaneConversation: vi.fn(async (_paneId: string, id: string) => { files.conversation = id; }),
  readGeminiNativeConversationIdFromProcessTree: vi.fn(async () => null) }));
vi.mock("node:fs/promises", async (orig) => ({ ...await orig<object>(),
  unlink: vi.fn(async (path: string) => { files.unlinked.push(path); files.conversation = null; }) }));
const { createRoomPaneCliController } = await import("../src/room-pane-cli-controller.js");

const pane = { id: "pane:gem1", roomId: "room:r1", mode: "TERMINAL", terminalRuntimeId: "cli:gemini" } as Pane;
const session = { sessionId: "cli_session:old", paneId: pane.id, runtimeId: "cli:gemini", accountProfileId: "acct-a", isActive: true, status: "RUNNING",
  codexThreadId: null } as unknown as PaneCliSession;

function controller() {
  const launches: Array<{ selection: unknown; conversationAtLaunch: string | null }> = [];
  const deps = {
    store: { updatePaneCliSession: vi.fn(async () => session) },
    cliTerminalManager: {
      activeSessionPids: vi.fn(async () => new Map()),
      ensurePaneControlReady: vi.fn(async (_pane: Pane, _trace: string, selection: unknown) => {
        launches.push({ selection, conversationAtLaunch: files.conversation });
        return session;
      })
    },
    roomCliSession: vi.fn(async () => session),
    inspectRoomCli: vi.fn(async () => ({ state: "IDLE" }))
  };
  return { launches, control: createRoomPaneCliController(deps as unknown as Parameters<typeof createRoomPaneCliController>[0]) };
}

describe("Gemini pane account switch (ADAPTER-010)", () => {
  beforeEach(() => { files.conversation = null; files.unlinked = []; });

  it("relaunches on the new account resuming the pane's conversation, with its file still there", async () => {
    files.conversation = conversation;
    const { launches, control } = controller();
    await control.configure(pane, { accountProfileId: "main" } as never, "req:test");
    expect(launches).toEqual([{ selection: { accountProfileId: "main", launchMode: "RESUME" }, conversationAtLaunch: conversation }]);
    expect(files.unlinked).toEqual([]);
  });

  it("starts fresh and clears a stale pane file when there is no conversation to carry", async () => {
    const { launches, control } = controller();
    await control.configure(pane, { accountProfileId: "main" } as never, "req:test");
    expect(launches).toEqual([{ selection: { accountProfileId: "main", launchMode: "FRESH" }, conversationAtLaunch: null }]);
    expect(files.unlinked).toHaveLength(2);
  });
});
