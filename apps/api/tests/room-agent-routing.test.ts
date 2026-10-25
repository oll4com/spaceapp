import { describe, expect, it } from "vitest";
import { roomAgentFailureText, routedQuickCommand } from "../src/room-agent.js";

describe("Room Agent direct commands", () => {
  it("explains a mission runtime that could not start", () => {
    expect(roomAgentFailureText("Codex App Server exited before the turn completed. Run the Codex App Server handshake/turn smoke and inspect space-worker logs."))
      .toBe("Missions could not start: the Room Agent's mission runtime (Codex App Server) is not available here. Questions, @mentions and direct commands still work.");
    expect(roomAgentFailureText("BLOCKED: plan invalid")).toBe("BLOCKED: plan invalid");
  });

  it("turns complete quick phrases into the routed commands the batch and browser executors take", () => {
    expect(routedQuickCommand({ type: "OPEN_PANES", count: 2, mode: "TERMINAL", runtimeId: "cli:codex" })).toEqual({ type: "OPEN_PANES", counts: { codex: 2 } });
    expect(routedQuickCommand({ type: "OPEN_PANES", count: 1, mode: "BROWSER" })).toEqual({ type: "OPEN_PANES", counts: { browser: 1 } });
    expect(routedQuickCommand({ type: "OPEN_PANES", count: 1, mode: "CHAT" })).toEqual({ type: "OPEN_PANES", counts: { chat: 1 } });
    expect(routedQuickCommand({ type: "SEARCH", query: "books", engine: "GOOGLE" }, "pane:browser")).toEqual({ type: "SEARCH", query: "books", engine: "GOOGLE", paneId: "pane:browser" });
    expect(routedQuickCommand({ type: "MUSIC", action: "NEXT", target: "YOUTUBE" })).toEqual({ type: "PLAYBACK", action: "NEXT", target: "YOUTUBE" });
  });
});
