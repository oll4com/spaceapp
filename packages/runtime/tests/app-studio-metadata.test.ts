import { expect, it } from "vitest";
import { defaultAppStudioPaneMetadata, resolveAppStudioPaneMetadata } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";

it("persists App Studio pane settings through ordinary updates, reads a new pane as defaults and refuses other modes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "App Studio fixture", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "App Studio", mode: "APP_STUDIO", terminalRuntimeId: "cli:claude" });
  expect(pane.terminalRuntimeId).toBe("cli:claude");
  expect(resolveAppStudioPaneMetadata(pane.appStudioMetadata)).toEqual(defaultAppStudioPaneMetadata());
  const metadata = defaultAppStudioPaneMetadata();
  metadata.settings.devices = ["android-360x800", "iphone-440x956"];
  metadata.settings.paused = true;
  expect(store.updateAppStudioMetadata(pane.id, metadata).appStudioMetadata).toEqual(metadata);
  store.updatePane(pane.id, { title: "Renamed" });
  expect(store.getPane(pane.id).appStudioMetadata).toEqual(metadata);
  expect(store.updatePane(pane.id, { status: "RUNNING" }).terminalRuntimeId).toBe("cli:claude");
  const design = store.createPane({ roomId: room.id, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:claude" });
  expect(() => store.updateAppStudioMetadata(design.id, metadata)).toThrow(/App Studio pane/);
  // The pane owns a CLI session (the app builder).
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", modelId: null } as never);
  expect(session.paneId).toBe(pane.id);
  store.updatePane(pane.id, { isClosed: true });
  expect(() => store.updateAppStudioMetadata(pane.id, metadata)).toThrow(/App Studio pane/);
});
