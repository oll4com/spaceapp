import { expect, it } from "vitest";
import { defaultJobApplyPaneMetadata } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";

it("persists Job Applications settings through ordinary updates and refuses other pane modes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Job apply fixture", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Job Applications", mode: "JOB_APPLY", terminalRuntimeId: "cli:opencode" });
  expect(pane.terminalRuntimeId).toBe("cli:opencode");
  expect(pane.jobApplyMetadata ?? null).toBeNull();
  const metadata = defaultJobApplyPaneMetadata();
  metadata.settings.paused = true;
  metadata.settings.dailyCaps.linkedin = 10;
  expect(store.updateJobApplyMetadata(pane.id, metadata).jobApplyMetadata).toEqual(metadata);
  store.updatePane(pane.id, { title: "Renamed" });
  expect(store.getPane(pane.id).jobApplyMetadata).toEqual(metadata);
  expect(() => store.updateJobApplyMetadata(pane.id, { ...metadata, settings: { ...metadata.settings, minDelayMs: 9, maxDelayMs: 1 } })).toThrow();
  const terminal = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
  expect(() => store.updateJobApplyMetadata(terminal.id, metadata)).toThrow(/Job Applications pane/);
  store.updatePane(pane.id, { isClosed: true });
  expect(() => store.updateJobApplyMetadata(pane.id, metadata)).toThrow(/Job Applications pane/);
});

it("keeps a Job Copilot pane's CLI runtime across ordinary pane updates and still clears it for non-CLI panes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Jobs", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Job Copilot", mode: "JOB_APPLY", terminalRuntimeId: "cli:claude" });
  expect(store.updatePane(pane.id, { status: "RUNNING" }).terminalRuntimeId).toBe("cli:claude");
  expect(store.updatePane(pane.id, { title: "Job Copilot 1" }).terminalRuntimeId).toBe("cli:claude");
  expect(store.updatePane(pane.id, { terminalRuntimeId: "cli:codex" }).terminalRuntimeId).toBe("cli:codex");
  const browser = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
  expect(store.updatePane(browser.id, { status: "RUNNING" }).terminalRuntimeId).toBeNull();
  const terminal = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
  expect(store.updatePane(terminal.id, { mode: "CHAT" }).terminalRuntimeId).toBeNull();
});
