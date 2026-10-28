import { expect, it } from "vitest";
import { defaultMonitoringCopilotPaneMetadata, resolveMonitoringCopilotPaneMetadata } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";

it("persists Monitoring Copilot pane settings through ordinary updates, reads a new pane as defaults and refuses other modes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Monitoring fixture", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Monitoring Copilot", mode: "MONITORING_COPILOT", terminalRuntimeId: "cli:claude" });
  expect(pane.terminalRuntimeId).toBe("cli:claude");
  expect(resolveMonitoringCopilotPaneMetadata(pane.monitoringCopilotMetadata)).toEqual(defaultMonitoringCopilotPaneMetadata());
  const metadata = defaultMonitoringCopilotPaneMetadata();
  metadata.settings.collector.lokiUrl = "http://192.0.2.202:3100";
  metadata.settings.notifications.warning = false;
  expect(store.updateMonitoringCopilotMetadata(pane.id, metadata).monitoringCopilotMetadata).toEqual(metadata);
  store.updatePane(pane.id, { title: "Renamed" });
  expect(store.getPane(pane.id).monitoringCopilotMetadata).toEqual(metadata);
  const security = store.createPane({ roomId: room.id, title: "Security", mode: "SECURITY_COPILOT", terminalRuntimeId: "cli:claude" });
  expect(() => store.updateMonitoringCopilotMetadata(security.id, metadata)).toThrow(/Monitoring Copilot pane/);
  // The pane owns a CLI session (the copilot's agent).
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", modelId: null } as never);
  expect(session.paneId).toBe(pane.id);
  store.updatePane(pane.id, { isClosed: true });
  expect(() => store.updateMonitoringCopilotMetadata(pane.id, metadata)).toThrow(/Monitoring Copilot pane/);
});
