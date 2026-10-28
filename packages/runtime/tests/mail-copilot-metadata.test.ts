import { expect, it } from "vitest";
import { defaultMailCopilotPaneMetadata } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";

it("persists Mail Copilot settings through ordinary updates and refuses other pane modes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Mail fixture", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Mail Copilot", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude" });
  expect(pane.terminalRuntimeId).toBe("cli:claude");
  expect(pane.mailCopilotMetadata ?? null).toBeNull();
  const metadata = defaultMailCopilotPaneMetadata();
  metadata.settings.autonomy = "RULES";
  metadata.settings.accounts = ["me@gmail.com"];
  expect(store.updateMailCopilotMetadata(pane.id, metadata).mailCopilotMetadata).toEqual(metadata);
  store.updatePane(pane.id, { title: "Renamed" });
  expect(store.getPane(pane.id).mailCopilotMetadata).toEqual(metadata);
  expect(store.updatePane(pane.id, { status: "RUNNING" }).terminalRuntimeId).toBe("cli:claude");
  const { dailyRunHour: _hour, ...storedBefore } = metadata.settings;
  expect(store.updateMailCopilotMetadata(pane.id, { ...metadata, settings: storedBefore } as never).mailCopilotMetadata?.settings.dailyRunHour).toBe(9);
  expect(() => store.updateMailCopilotMetadata(pane.id, { ...metadata, settings: { ...metadata.settings, sendsPerHour: 999 } })).toThrow();
  const jobs = store.createPane({ roomId: room.id, title: "Job Copilot", mode: "JOB_APPLY", terminalRuntimeId: "cli:claude" });
  expect(() => store.updateMailCopilotMetadata(jobs.id, metadata)).toThrow(/Mail Copilot pane/);
  expect(() => store.updateJobApplyMetadata(pane.id, { version: 1, settings: {} } as never)).toThrow(/Job Applications pane/);
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", modelId: null } as never);
  expect(session.paneId).toBe(pane.id);
  store.updatePane(pane.id, { isClosed: true });
  expect(() => store.updateMailCopilotMetadata(pane.id, metadata)).toThrow(/Mail Copilot pane/);
});
