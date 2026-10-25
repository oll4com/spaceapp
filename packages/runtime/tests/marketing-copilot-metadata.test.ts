import { expect, it } from "vitest";
import { defaultMarketingCopilotPaneMetadata } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";

it("persists Marketing Copilot settings through ordinary updates and refuses other pane modes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Marketing fixture", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Marketing Copilot", mode: "MARKETING_COPILOT", terminalRuntimeId: "cli:claude" });
  expect(pane.terminalRuntimeId).toBe("cli:claude");
  expect(pane.marketingCopilotMetadata ?? null).toBeNull();
  const metadata = defaultMarketingCopilotPaneMetadata();
  metadata.settings.autonomy = "RULES";
  metadata.settings.channels.REDDIT.enabled = false;
  expect(store.updateMarketingCopilotMetadata(pane.id, metadata).marketingCopilotMetadata).toEqual(metadata);
  store.updatePane(pane.id, { title: "Renamed" });
  expect(store.getPane(pane.id).marketingCopilotMetadata).toEqual(metadata);
  expect(store.updatePane(pane.id, { status: "RUNNING" }).terminalRuntimeId).toBe("cli:claude");
  const mail = store.createPane({ roomId: room.id, title: "Mail Copilot", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude" });
  expect(() => store.updateMarketingCopilotMetadata(mail.id, metadata)).toThrow(/Marketing Copilot pane/);
  // The pane owns a CLI session and a managed browser session, like Job Copilot.
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", modelId: null } as never);
  expect(session.paneId).toBe(pane.id);
  store.updatePane(pane.id, { isClosed: true });
  expect(() => store.updateMarketingCopilotMetadata(pane.id, metadata)).toThrow(/Marketing Copilot pane/);
});
