import type { Pane } from "@space/contracts";
import { createCurrentMockFixture } from "./mock-fixture.js";

// A separate, ephemeral fixture; the ordinary interactive mock is unchanged.
export function createShowcaseFixture() {
  const f = createCurrentMockFixture();
  f.auth.settings = {
    ...f.auth.settings!,
    roomTheme: "motion",
    uiTheme: "motion",
  };
  f.rooms = [
    { ...f.rooms[0]!, name: "Build", paneLayoutColumns: 2 },
    { ...f.rooms[1]!, name: "Research", paneLayoutColumns: 2 },
    { ...f.rooms[2]!, name: "Create", paneLayoutColumns: 2 },
    {
      ...f.rooms[0]!,
      id: "room:showcase-remote",
      name: "Remote",
      order: 3,
      paneLayoutColumns: 2,
    },
  ];
  const template = f.panes[0]!;
  const make = (
    room: number,
    mode: Pane["mode"],
    title: string,
    order: number,
    extra: Partial<Pane> = {},
  ): Pane => ({
    ...structuredClone(template),
    id: `pane:showcase-${room}-${order}`,
    roomId: f.rooms[room]!.id,
    title,
    mode,
    order,
    terminalRuntimeId: mode === "TERMINAL" ? "cli:codex" : null,
    providerId: mode === "CHAT" ? "demo-codex" : null,
    modelId: mode === "CHAT" ? "gpt-5.6-sol" : null,
    cwd: "/opt/spaceapp",
    isClosed: false,
    isMinimized: false,
    isMaximized: false,
    ...extra,
  });
  // Keep the existing terminal IDs: native transcript and model fixtures use them.
  f.panes = [
    ...f.panes
      .filter((p) => p.roomId === f.rooms[0]!.id)
      .map((p) => ({
        ...p,
        title:
          p.terminalRuntimeId === "cli:codex"
            ? "Codex CLI"
            : p.terminalRuntimeId === "cli:claude"
              ? "Claude Code CLI"
              : p.terminalRuntimeId === "cli:gemini"
                ? "Gemini CLI"
                : "OpenCode CLI",
      })),
    make(1, "CHAT", "Research chat", 0),
    make(1, "BROWSER", "Browser", 1),
    make(1, "YOUTUBE", "YouTube", 2),
    make(1, "FILES", "File Manager", 3),
    make(2, "DEMOS", "Demo Projects", 0),
    make(2, "LIVE", "Live audio", 1),
    make(2, "HARNESS", "DeepSeek Harness", 2),
    make(2, "FILES", "Project files", 3),
    make(3, "VNC", "Remote desktop", 0, {
      vncTarget: {
        presetId: "demo-desktop",
        host: "demo.local",
        port: 5900,
        password: null,
      },
    }),
    make(3, "BROWSER", "Browser", 1),
    make(3, "TERMINAL", "Codex CLI", 2),
    make(3, "CHAT", "Remote notes", 3),
  ];
  f.clipboardItems = f.clipboardItems.map((item, i) => ({
    ...item,
    title: i === 0 ? "Workspace review" : item.title,
    text:
      i === 0
        ? "Review layouts, explore the workspace docks, and keep useful outputs in Agent Files."
        : item.text,
  }));
  return f;
}
