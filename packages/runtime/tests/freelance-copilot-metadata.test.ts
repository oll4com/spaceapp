import { expect, it } from "vitest";
import { defaultFreelanceCopilotPaneMetadata } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";

it("persists Freelance Copilot settings through ordinary updates and refuses other pane modes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Freelance fixture", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Freelance Copilot", mode: "FREELANCE_COPILOT", terminalRuntimeId: "cli:claude" });
  expect(pane.terminalRuntimeId).toBe("cli:claude");
  expect(pane.freelanceCopilotMetadata ?? null).toBeNull();
  const metadata = defaultFreelanceCopilotPaneMetadata();
  metadata.settings.channels.FIVERR.autonomyCap = "ASSIST";
  metadata.settings.browserEgress = "thailand";
  expect(store.updateFreelanceCopilotMetadata(pane.id, metadata).freelanceCopilotMetadata).toEqual(metadata);
  store.updatePane(pane.id, { title: "Renamed" });
  expect(store.getPane(pane.id).freelanceCopilotMetadata).toEqual(metadata);
  expect(store.updatePane(pane.id, { status: "RUNNING" }).terminalRuntimeId).toBe("cli:claude");
  const marketing = store.createPane({ roomId: room.id, title: "Marketing Copilot", mode: "MARKETING_COPILOT", terminalRuntimeId: "cli:claude" });
  expect(() => store.updateFreelanceCopilotMetadata(marketing.id, metadata)).toThrow(/Freelance Copilot pane/);
  // The pane owns a CLI session and a managed browser session, like Job and Marketing Copilot.
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", modelId: null } as never);
  expect(session.paneId).toBe(pane.id);
  store.updatePane(pane.id, { isClosed: true });
  expect(() => store.updateFreelanceCopilotMetadata(pane.id, metadata)).toThrow(/Freelance Copilot pane/);
});
