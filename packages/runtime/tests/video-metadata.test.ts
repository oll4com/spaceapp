import { expect, it } from "vitest";
import { defaultVideoPaneMetadata, resolveVideoPaneMetadata } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";

it("persists Video pane settings through ordinary updates, reads unconfigured panes as defaults and refuses other modes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Video fixture", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Video", mode: "VIDEO", terminalRuntimeId: "cli:claude" });
  expect(pane.terminalRuntimeId).toBe("cli:claude");
  expect(resolveVideoPaneMetadata(pane.videoMetadata)).toEqual(defaultVideoPaneMetadata());
  const metadata = defaultVideoPaneMetadata();
  metadata.settings.requestAutonomy = "APPROVAL";
  metadata.settings.defaultFormatIds = ["x", "ig-reel"];
  expect(store.updateVideoMetadata(pane.id, metadata).videoMetadata).toEqual(metadata);
  store.updatePane(pane.id, { title: "Renamed" });
  expect(store.getPane(pane.id).videoMetadata).toEqual(metadata);
  expect(store.updatePane(pane.id, { status: "RUNNING" }).terminalRuntimeId).toBe("cli:claude");
  const design = store.createPane({ roomId: room.id, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:claude" });
  expect(() => store.updateVideoMetadata(design.id, metadata)).toThrow(/Video pane/);
  // The pane owns a CLI session (the editor).
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", modelId: null } as never);
  expect(session.paneId).toBe(pane.id);
  store.updatePane(pane.id, { isClosed: true });
  expect(() => store.updateVideoMetadata(pane.id, metadata)).toThrow(/Video pane/);
});
