import { expect, it } from "vitest";
import { defaultSecurityCopilotPaneMetadata, resolveSecurityCopilotPaneMetadata } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";

it("persists Security Copilot pane settings through ordinary updates, reads a new pane as defaults and refuses other modes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Security fixture", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Security Copilot", mode: "SECURITY_COPILOT", terminalRuntimeId: "cli:claude" });
  expect(pane.terminalRuntimeId).toBe("cli:claude");
  expect(resolveSecurityCopilotPaneMetadata(pane.securityCopilotMetadata)).toEqual(defaultSecurityCopilotPaneMetadata());
  const metadata = defaultSecurityCopilotPaneMetadata();
  metadata.settings.autonomy = "ASSIST";
  metadata.settings.paused = true;
  expect(store.updateSecurityCopilotMetadata(pane.id, metadata).securityCopilotMetadata).toEqual(metadata);
  store.updatePane(pane.id, { title: "Renamed" });
  expect(store.getPane(pane.id).securityCopilotMetadata).toEqual(metadata);
  const design = store.createPane({ roomId: room.id, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:claude" });
  expect(() => store.updateSecurityCopilotMetadata(design.id, metadata)).toThrow(/Security Copilot pane/);
  // The pane owns a CLI session (the copilot's agent).
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", modelId: null } as never);
  expect(session.paneId).toBe(pane.id);
  store.updatePane(pane.id, { isClosed: true });
  expect(() => store.updateSecurityCopilotMetadata(pane.id, metadata)).toThrow(/Security Copilot pane/);
});
