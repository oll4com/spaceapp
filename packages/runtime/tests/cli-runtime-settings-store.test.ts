import { describe, expect, it } from "vitest";
import { cliToggleRuntimeIds } from "@space/contracts";
import { InMemorySpaceStore } from "../src/store.js";

async function addTask(store: InMemorySpaceStore, roomId: string, runtimeId: "cli:codex" | "cli:deepseek", suffix: string) {
  const pane = store.createPane({
    roomId,
    title: `${suffix} task`,
    mode: "TERMINAL",
    terminalRuntimeId: runtimeId
  });
  const session = store.createPaneCliSession({
    paneId: pane.id,
    roomId,
    runtimeId,
    providerId: runtimeId === "cli:deepseek" ? "deepseek" : "codex",
    agentId: runtimeId.slice(4),
    modelId: runtimeId === "cli:deepseek" ? "deepseek-v4-flash" : "gpt-5.6-sol",
    reasoningEffort: "medium",
    cwd: "/etc",
    status: "EXITED",
    statusReason: "test history",
    isActive: false
  });
  store.appendPaneCliTranscriptChunk({
    sessionId: session.sessionId,
    paneId: pane.id,
    roomId,
    sequence: 0,
    stream: "stdin",
    content: `${suffix} prompt`
  });
  store.appendPaneCliTranscriptChunk({
    sessionId: session.sessionId,
    paneId: pane.id,
    roomId,
    sequence: 1,
    stream: "stdout",
    content: `${suffix} answer`
  });
  return session;
}

describe("InMemorySpaceStore CLI runtime settings", () => {
  it("defaults every toggle runtime to enabled and persists explicit updates", () => {
    const store = new InMemorySpaceStore();
    expect(store.listCliRuntimeSettings()).toHaveLength(cliToggleRuntimeIds.length);
    expect(store.listCliRuntimeSettings().every((setting) => setting.enabled)).toBe(true);
    expect(store.listCliRuntimeSettings().every((setting) => setting.vpnEnabled === false)).toBe(true);

    const disabled = store.updateCliRuntimeSetting(
      "cli:deepseek",
      { enabled: false, confirmationToken: "c".repeat(32) },
      "user:admin"
    );
    expect(disabled).toMatchObject({ runtimeId: "cli:deepseek", enabled: false, updatedBy: "user:admin" });
    expect(store.getCliRuntimeSetting("cli:deepseek").enabled).toBe(false);

    const enabled = store.updateCliRuntimeSetting("cli:deepseek", { enabled: true }, "user:admin");
    expect(enabled.enabled).toBe(true);

    const vpn = store.updateCliRuntimeVpnSetting("cli:deepseek", { enabled: true }, "user:admin");
    expect(vpn).toMatchObject({ enabled: true, vpnEnabled: true });
    const hidden = store.updateCliRuntimeSetting(
      "cli:deepseek",
      { enabled: false, confirmationToken: "d".repeat(32) },
      "user:admin"
    );
    expect(hidden).toMatchObject({ enabled: false, vpnEnabled: true });
  });

  it("filters disabled runtime history before pagination and restores the same record", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Runtime history", initialPaneCount: 0 });
    const deepseek = await addTask(store, room.id, "cli:deepseek", "deepseek");
    await addTask(store, room.id, "cli:codex", "codex");

    const hidden = store.listPaneCliTaskHistory({
      page: 1,
      pageSize: 1,
      runtimeIds: ["cli:codex"]
    });
    expect(hidden.total).toBe(1);
    expect(hidden.items[0]?.session.runtimeId).toBe("cli:codex");

    const restored = store.listPaneCliTaskHistory({
      page: 1,
      pageSize: 1,
      runtimeIds: ["cli:deepseek"]
    });
    expect(restored.total).toBe(1);
    expect(restored.items[0]?.taskId).toBe(deepseek.sessionId);
    expect(store.getPaneCliSession(deepseek.sessionId)).toMatchObject({
      sessionId: deepseek.sessionId,
      runtimeId: "cli:deepseek"
    });
  });
});
