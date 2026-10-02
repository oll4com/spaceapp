import { defaultUserSettings } from "@space/contracts";
import { createDemoFixture, type DemoFixture } from "./demo-fixture.js";

export function createCurrentMockFixture(): DemoFixture {
  const fixture = createDemoFixture();
  fixture.auth = {
    isAuthenticated: true, isSetupRequired: false,
    user: { id: "user:demo-user", email: "demo@spaceapp.dev", role: "USER" },
    settings: {
      ...structuredClone(defaultUserSettings),
      modernAppearance: "dark",
      dateTime: {
        timeZone: "UTC",
        timeFormat: "24h",
        dateFormat: "DD/MM/YYYY"
      }
    }
  };
  fixture.rooms[0]!.name = "Room 1";
  for (const room of fixture.rooms) {
    room.paneLayoutColumns = 2;
    room.paneLayoutHeight = 1;
  }
  const artifact = fixture.artifacts[0]!;
  fixture.artifacts.push(
    { ...structuredClone(artifact), id: "artifact:mock-workspace-map", paneId: null, mimeType: "image/svg+xml", storageUri: "space-artifact://agent-files/workspace-map.svg", metadata: { originalFilename: "workspace-map.svg", runtimeId: "cli:codex", previewKind: "IMAGE", mockFile: "workspace-map.svg" } },
    { ...structuredClone(artifact), id: "artifact:mock-launch-brief", paneId: null, kind: "EXPORT", mimeType: "text/markdown", storageUri: "space-artifact://agent-files/launch-brief.md", metadata: { originalFilename: "launch-brief.md", runtimeId: "cli:codex", previewKind: "TEXT", mockFile: "launch-brief.md" } }
  );
  const template = fixture.panes.find(p => p.mode === "TERMINAL")!;
  const variants = [
    ["codex", "Build the Space workspace"], ["opencode", "Review the interface"],
    ["gemini", "Implement the room layout"], ["claude", "Verify themes and controls"]
  ];
  const terminals = variants.map(([id, title], index) => ({
    ...structuredClone(template), id: `pane:demo-${id}`, title: title!, order: index,
    terminalRuntimeId: `cli:${id}`, isMinimized: false, isClosed: false, cwd: "/workspace"
  }));
  const researchRoomId = fixture.rooms[1]!.id;
  const researchChat = fixture.panes.find(p => p.id === "pane:demo-research-chat")!;
  const researchPane = (id: string, title: string, mode: "YOUTUBE" | "BROWSER" | "FILES", order: number) => ({
    ...structuredClone(template), id, roomId: researchRoomId, title, mode, order,
    terminalRuntimeId: null, cwd: "/opt/spaceapp", isMinimized: false, isClosed: false
  });
  fixture.panes = [...terminals,
    { ...structuredClone(researchChat), order: 0 },
    researchPane("pane:demo-video", "Discover Space", "YOUTUBE", 1),
    researchPane("pane:demo-research-browser", "Browser 4", "BROWSER", 2),
    researchPane("pane:demo-research-files", "Files 4", "FILES", 3)
  ];
  return fixture;
}
