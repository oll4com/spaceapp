import { expect, it } from "vitest";
import { defaultDesignPaneMetadata, resolveDesignPaneMetadata } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";

it("persists Design pane settings through ordinary updates, reads old DESIGN rows as defaults and refuses other modes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Design fixture", initialPaneCount: 0 });
  // An old DESIGN pane (no runtime, no metadata) still reads as a valid Design pane.
  const legacy = store.createPane({ roomId: room.id, title: "Design Notes", mode: "DESIGN" });
  expect(resolveDesignPaneMetadata(legacy.designMetadata)).toEqual(defaultDesignPaneMetadata());
  const pane = store.createPane({ roomId: room.id, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:claude" });
  expect(pane.terminalRuntimeId).toBe("cli:claude");
  expect(pane.designMetadata ?? null).toBeNull();
  const metadata = defaultDesignPaneMetadata();
  metadata.settings.requestAutonomy = "APPROVAL";
  metadata.settings.defaultFormatId = "linkedin-banner";
  expect(store.updateDesignMetadata(pane.id, metadata).designMetadata).toEqual(metadata);
  store.updatePane(pane.id, { title: "Renamed" });
  expect(store.getPane(pane.id).designMetadata).toEqual(metadata);
  expect(store.updatePane(pane.id, { status: "RUNNING" }).terminalRuntimeId).toBe("cli:claude");
  const marketing = store.createPane({ roomId: room.id, title: "Marketing Copilot", mode: "MARKETING_COPILOT", terminalRuntimeId: "cli:claude" });
  expect(() => store.updateDesignMetadata(marketing.id, metadata)).toThrow(/Design pane/);
  // The pane owns a CLI session (the designer).
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", modelId: null } as never);
  expect(session.paneId).toBe(pane.id);
  store.updatePane(pane.id, { isClosed: true });
  expect(() => store.updateDesignMetadata(pane.id, metadata)).toThrow(/Design pane/);
});
