import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { createSetupCapabilityChecks } from "../src/setup-capability-checks.js";

describe("first setup optional services", () => {
  it("checks the permitted file root and refuses a missing runtime directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-files-"));
    try {
      const checks = createSetupCapabilityChecks({ store: new InMemorySpaceStore(), workspaceRoot: root,
        checkSourceControl: async () => undefined });
      await expect(checks["pane:files"]!("user:owner")).resolves.toBeUndefined();
      await expect(checks["dock:source-control"]!("user:owner")).resolves.toBeUndefined();
      await rm(root, { recursive: true, force: true });
      await expect(checks["pane:files"]!("user:owner")).rejects.toThrow("File or directory was not found.");
      await expect(checks["dock:source-control"]!("user:owner")).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not claim Media or Shared Chat readiness after their backing store fails", async () => {
    const store = new InMemorySpaceStore();
    const checks = createSetupCapabilityChecks({ store, checkSourceControl: async () => undefined });
    await expect(checks["dock:media"]!("user:owner")).resolves.toBeUndefined();
    await expect(checks["dock:shared-chat"]!("user:owner")).resolves.toBeUndefined();
    store.listArtifacts = () => { throw new Error("Media storage unavailable"); };
    store.listSharedChatMessages = () => { throw new Error("Shared Chat unavailable"); };
    await expect(checks["dock:media"]!("user:owner")).rejects.toThrow("Media storage unavailable");
    await expect(checks["dock:shared-chat"]!("user:owner")).rejects.toThrow("Shared Chat unavailable");
    expect(checks["pane:browser"]).toBeUndefined();
    await expect(checks["widget:clock"]!("user:owner")).resolves.toBeUndefined();
    await expect(checks["widget:countdown-timer"]!("user:owner")).resolves.toBeUndefined();
  });
});
