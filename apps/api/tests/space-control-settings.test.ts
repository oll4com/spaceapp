import { describe, expect, it, vi } from "vitest";
import { InMemoryControlRepository } from "@space/db";
import { controlUnavailableResources } from "@space/contracts";
import {
  captureControlSettingsSnapshot,
  restoreControlSettingsSnapshot,
  executeControlPluginAction,
  executeControlAppearanceAction,
  resolveControlSettingsAction
} from "../src/space-control-settings.js";

const actor = { id: "operator:settings", role: "ADMIN" as const };
function fixture() {
  return {
    actor,
    roomId: "room:settings",
    input: { label: "Before edit" },
    repository: new InMemoryControlRepository(),
    inspect: vi.fn(async () => ({ appearance: { theme: "graphite" }, voice: null }))
  };
}

describe("Control settings adapters", () => {
  it("persists and verifies a restorable settings snapshot", async () => {
    const input = fixture();
    const result = await captureControlSettingsSnapshot(input);
    expect(result).toMatchObject({ status: "SNAPSHOT_CREATED", restorable: true, verifiedVersion: 1 });
    expect(await input.repository.get("settings_snapshot", actor.id, result.snapshotId)).toMatchObject({
      roomId: input.roomId,
      version: 1,
      value: { id: result.snapshotId, restorable: true, kind: "RESTORED_CONFIG" }
    });
    expect(await input.repository.get("settings_snapshot", "another-owner", result.snapshotId)).toBeNull();
  });

  it("rolls back settings to a captured snapshot with confirmation", async () => {
    const input = fixture();
    const snapshot = await captureControlSettingsSnapshot(input);
    const rollbackResult = await restoreControlSettingsSnapshot({
      actor: input.actor,
      roomId: input.roomId,
      input: { snapshotId: snapshot.snapshotId, confirm: true },
      repository: input.repository
    });
    expect(rollbackResult.status).toBe("COMPLETED");
    expect(rollbackResult.evidence.snapshotId).toBe(snapshot.snapshotId);
    expect(rollbackResult.evidence.restored).toBe(true);
  });

  it("rejects rollback without confirmation", async () => {
    const input = fixture();
    await expect(
      restoreControlSettingsSnapshot({
        actor: input.actor,
        roomId: input.roomId,
        input: { confirm: false },
        repository: input.repository
      })
    ).rejects.toThrow(/confirmation/);
  });

  it("fails if the snapshot write is rejected", async () => {
    const input = fixture();
    vi.spyOn(input.repository, "write").mockResolvedValue(false);
    await expect(captureControlSettingsSnapshot(input)).rejects.toThrow(/could not be persisted/);
  });

  it("does not report a snapshot when inspection fails", async () => {
    const input = fixture();
    input.inspect.mockRejectedValue(new Error("Inspection unavailable"));
    const write = vi.spyOn(input.repository, "write");
    await expect(captureControlSettingsSnapshot(input)).rejects.toThrow(/Inspection unavailable/);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["missing", "foreign-room", "foreign-owner", "changed-value"])("rejects %s read-back", async (failure) => {
    const input = fixture();
    const get = input.repository.get.bind(input.repository);
    vi.spyOn(input.repository, "get").mockImplementation(async (...args) => {
      const record = await get(...args);
      if (!record || failure === "missing") return null;
      if (failure === "foreign-room") record.roomId = "room:other";
      if (failure === "foreign-owner") record.actorId = "operator:other";
      if (failure === "changed-value") record.value = { ...(record.value as object), settings: {} };
      return record;
    });
    await expect(captureControlSettingsSnapshot(input)).rejects.toThrow(/could not be verified/);
  });

  it("executes plugin connect and disconnect actions", async () => {
    const input = fixture();
    const mockPluginsService = {
      disconnectPlugin: vi.fn(async (id: string) => ({ pluginId: id, status: "NOT_CONNECTED" })),
      connectPlugin: vi.fn(async (opts: any) => ({ pluginId: opts.pluginId, status: "CONNECTED" })),
      getPlugins: vi.fn(async () => [{ id: "builtin_docs", authType: "none", authFields: [] }])
    };

    // Disconnect plugin
    const disconnectOutcome = await executeControlPluginAction({
      actor: input.actor,
      roomId: input.roomId,
      input: { pluginId: "github", enabled: false },
      repository: input.repository,
      pluginsService: mockPluginsService
    });
    expect(disconnectOutcome.status).toBe("COMPLETED");
    expect(mockPluginsService.disconnectPlugin).toHaveBeenCalledWith("github");

    // Connect zero-auth plugin
    const connectOutcome = await executeControlPluginAction({
      actor: input.actor,
      roomId: input.roomId,
      input: { pluginId: "builtin_docs", enabled: true },
      repository: input.repository,
      pluginsService: mockPluginsService
    });
    expect(connectOutcome.status).toBe("COMPLETED");
    expect(mockPluginsService.connectPlugin).toHaveBeenCalledWith({ pluginId: "builtin_docs" });
  });

  it("executes appearance preferences mutation and persists", async () => {
    const input = fixture();
    const outcome = await executeControlAppearanceAction({
      actor: input.actor,
      roomId: input.roomId,
      input: { theme: "forest", zoomLevel: 110, terminalFontSize: 16 },
      repository: input.repository
    });
    expect(outcome.status).toBe("COMPLETED");
    expect(outcome.evidence.preferences).toEqual({ theme: "forest", zoomLevel: 110, terminalFontSize: 16 });
    expect(outcome.evidence.persisted).toBe(true);
  });

  it.each(["appearance", "voice", "task_titles", "tools", "plugins"])("normalizes %s inside the existing operation", (domain) => {
    const resolved = resolveControlSettingsAction({
      kind: "resource",
      operation: "settings.update",
      input: { domain, patch: { enabled: true } },
      approvalReason: "Explicit operator request"
    });
    expect(resolved).toMatchObject({
      kind: "resource",
      operation: `settings.${domain}`,
      input: { enabled: true },
      approvalReason: "Explicit operator request"
    });
  });

  it("rejects unknown domains and missing patches without dispatch", () => {
    for (const input of [
      { domain: "credentials", patch: {} },
      { domain: "tools" },
      { domain: "voice", patch: {}, surprise: true }
    ]) {
      expect(() => resolveControlSettingsAction({ kind: "resource", operation: "settings.update", input })).toThrow();
    }
  });

  it("has 0 unavailable actions in advertised catalog", () => {
    expect(Object.keys(controlUnavailableResources)).toHaveLength(0);
  });
});
