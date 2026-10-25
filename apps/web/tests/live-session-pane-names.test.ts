// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  SPACE_SEND_PROMPT_TOOL,
  SPACE_CLOSE_PANES_TOOL,
  SPACE_MINIMIZE_PANES_TOOL,
  SPACE_MAXIMIZE_PANES_TOOL,
  SPACE_RESTORE_PANES_TOOL,
  SPACE_STOP_PANE_TOOL,
  SPACE_SET_PANE_COLOR_TOOL,
  SPACE_SET_PANE_MODEL_TOOL,
  SPACE_RUN_CLI_SHORTCUT_TOOL,
  SPACE_INSPECT_ROOM_TOOL,
  resolveTargetCliPane,
  liveRoomContextMessage,
  buildLiveSessionContext
} from "../src/features/live-pane/live-session.js";
import { livePromptPaneReceipts, resolveLivePaneTargets } from "../src/features/live-pane/live-pane-targets.js";
import { PANE_NAMES, PANE_NAME_ALIASES } from "@space/contracts";

describe("Live Pane 16 unique pane names integration", () => {
  describe("Tool parameter schemas", () => {
    const toolsWithPaneNameAndNames = [
      ["SPACE_SEND_PROMPT_TOOL", SPACE_SEND_PROMPT_TOOL],
      ["SPACE_CLOSE_PANES_TOOL", SPACE_CLOSE_PANES_TOOL],
      ["SPACE_MINIMIZE_PANES_TOOL", SPACE_MINIMIZE_PANES_TOOL],
      ["SPACE_MAXIMIZE_PANES_TOOL", SPACE_MAXIMIZE_PANES_TOOL],
      ["SPACE_RESTORE_PANES_TOOL", SPACE_RESTORE_PANES_TOOL],
      ["SPACE_STOP_PANE_TOOL", SPACE_STOP_PANE_TOOL],
      ["SPACE_SET_PANE_COLOR_TOOL", SPACE_SET_PANE_COLOR_TOOL],
      ["SPACE_SET_PANE_MODEL_TOOL", SPACE_SET_PANE_MODEL_TOOL],
      ["SPACE_RUN_CLI_SHORTCUT_TOOL", SPACE_RUN_CLI_SHORTCUT_TOOL]
    ] as const;

    it.each(toolsWithPaneNameAndNames)("ensures %s contains paneName and paneNames in schema", (_name, tool) => {
      const properties = (tool.parameters as any)?.properties;
      expect(properties).toBeDefined();
      expect(properties.paneName).toBeDefined();
      expect(properties.paneName.type).toBe("string");
      expect(properties.paneNames).toBeDefined();
      expect(properties.paneNames.type).toBe("array");
      expect(properties.paneNames.items.type).toBe("string");
    });

    it("ensures SPACE_INSPECT_ROOM_TOOL contains paneName", () => {
      const properties = (SPACE_INSPECT_ROOM_TOOL.parameters as any)?.properties;
      expect(properties).toBeDefined();
      expect(properties.paneName).toBeDefined();
      expect(properties.paneName.type).toBe("string");
    });
  });

  describe("resolveTargetCliPane name targeting and Greek transliterations", () => {
    const mockCliPanes = [
      { id: "pane-1", mode: "TERMINAL", terminalRuntimeId: "cli:codex", paneName: "Andy", title: "Codex Agent" },
      { id: "pane-2", mode: "TERMINAL", terminalRuntimeId: "cli:gemini", paneName: "Bob", title: "Gemini CLI" },
      { id: "pane-3", mode: "TERMINAL", terminalRuntimeId: "cli:opencode", paneName: "Nik", title: "OpenCode CLI" },
      { id: "pane-4", mode: "TERMINAL", terminalRuntimeId: "cli:claude", paneName: "Zoe", title: "Claude Pane" }
    ];

    it("resolves target by exact English paneName", () => {
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "Andy" })).toEqual(mockCliPanes[0]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "Bob" })).toEqual(mockCliPanes[1]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "Nik" })).toEqual(mockCliPanes[2]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "Zoe" })).toEqual(mockCliPanes[3]);
    });

    it("resolves target case-insensitively", () => {
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "andy" })).toEqual(mockCliPanes[0]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "BOB" })).toEqual(mockCliPanes[1]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "nik" })).toEqual(mockCliPanes[2]);
    });

    it("resolves target by Greek transliterations", () => {
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "Άντι" })).toEqual(mockCliPanes[0]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "αντι" })).toEqual(mockCliPanes[0]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "Μπομπ" })).toEqual(mockCliPanes[1]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "μπομπ" })).toEqual(mockCliPanes[1]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "Νικ" })).toEqual(mockCliPanes[2]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "νικ" })).toEqual(mockCliPanes[2]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "Ζόι" })).toEqual(mockCliPanes[3]);
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "ζοι" })).toEqual(mockCliPanes[3]);
    });

    it("resolves target using paneNames array", () => {
      expect(resolveTargetCliPane(mockCliPanes, { paneNames: ["Μπομπ"] })).toEqual(mockCliPanes[1]);
      expect(resolveTargetCliPane(mockCliPanes, { paneNames: ["NonExistent", "Άντι"] })).toEqual(mockCliPanes[0]);
    });

    it("returns null when no matching name found", () => {
      expect(resolveTargetCliPane(mockCliPanes, { paneName: "UnknownName" })).toBeNull();
    });
  });

  describe("liveRoomContextMessage structured active panes summary", () => {
    it("formats the ACTIVE PANES IN ROOM header with pane names", () => {
      const roomContext: any = {
        roomId: "room_test123",
        roomName: "Test Room",
        panes: [
          { id: "p1", paneName: "Andy", mode: "TERMINAL", runtimeId: "cli:codex", title: "Main CLI", activity: "RUNNING" },
          { id: "p2", paneName: "Bob", mode: "CHAT", runtimeId: null, title: "Assistant Chat", activity: "IDLE" },
          { id: "p3", paneName: "Cody", mode: "FILES", runtimeId: null, title: "Repo Explorer", status: "OPEN" },
          { id: "p4", paneName: "Dana", isClosed: true, title: "Closed Pane" }
        ]
      };

      const msg = liveRoomContextMessage(roomContext);
      const header = msg.split("\n\n")[0];
      expect(header).toContain("ACTIVE PANES IN ROOM:");
      expect(header).toContain("- Andy [TERMINAL/codex]: Main CLI (RUNNING)");
      expect(header).toContain("- Bob [CHAT]: Assistant Chat (IDLE)");
      expect(header).toContain("- Cody [FILES]: Repo Explorer (OPEN)");
      // Excludes closed pane from active summary header
      expect(header).not.toContain("Dana");
    });

    it("handles rooms with no active panes", () => {
      const roomContext: any = {
        roomId: "room_empty",
        roomName: "Empty Room",
        panes: []
      };
      const msg = liveRoomContextMessage(roomContext);
      expect(msg).toContain("ACTIVE PANES IN ROOM: (None)");
    });
  });

  describe("System prompt voice guidance", () => {
    it("includes the 16 unique pane names and Greek transliterations in instructions", async () => {
      const ctx = await buildLiveSessionContext({ model: "gpt-live-1", enableMcpTools: true });
      const prompt = ctx.combinedPrompt;

      // Check canonical English names in instructions
      for (const name of PANE_NAMES) {
        expect(prompt).toContain(name);
      }

      // Check sample Greek transliterations
      expect(prompt).toContain("Άντι");
      expect(prompt).toContain("Μπομπ");
      expect(prompt).toContain("Νικ");
      expect(prompt).toContain("Ζόι");

      // Check Natural Speech Confirmation Rule
      expect(prompt).toContain("NATURAL SPEECH CONFIRMATION RULE");
      expect(prompt).toContain("paneName");
      expect(prompt).toContain("paneNames");
    });
  });

  describe("livePromptPaneReceipts includes paneName", () => {
    it("associates paneName from panes list into receipt objects", () => {
      const panes = [
        { id: "p-andy", paneName: "Andy" },
        { id: "p-bob", paneName: "Bob" }
      ];
      const receipts = livePromptPaneReceipts(
        ["p-andy", "p-bob"],
        { results: [{ paneId: "p-andy", status: "COMPLETED" }] },
        panes
      );
      expect(receipts).toHaveLength(2);
      expect(receipts[0]?.paneId).toBe("p-andy");
      expect(receipts[0]?.paneName).toBe("Andy");
      expect(receipts[1]?.paneId).toBe("p-bob");
      expect(receipts[1]?.paneName).toBe("Bob");
    });
  });

  describe("Multi-pane targeting in resolveLivePaneTargets", () => {
    const scope = { userId: "operator", liveSessionId: "conversation" };
    const panes = [
      { id: "p1", mode: "TERMINAL", paneName: "Andy" },
      { id: "p2", mode: "TERMINAL", paneName: "Bob" },
      { id: "p3", mode: "TERMINAL", paneName: "Cody" },
      { id: "p4", mode: "TERMINAL", paneName: "Dana" }
    ];

    it("resolves multiple Greek transliterations at once", () => {
      const targets = resolveLivePaneTargets("room:a", panes, { paneNames: ["Άντι", "Μπομπ", "Κόντι"] }, scope, true);
      expect(targets).toEqual(["p1", "p2", "p3"]);
    });

    it("resolves mixed English and Greek names", () => {
      const targets = resolveLivePaneTargets("room:a", panes, { paneNames: ["Andy", "Μπομπ", "Dana"] }, scope, true);
      expect(targets).toEqual(["p1", "p2", "p4"]);
    });
  });
});
