import { describe, expect, it, vi } from "vitest";
import { createSpaceControlIntegration } from "../src/space-control-integration.js";

const actor = { id: "user:operator" } as never;
const panes: Record<string, { id: string; roomId: string; mode: string; terminalRuntimeId?: string }> = {
  "pane:cli": { id: "pane:cli", roomId: "room:one", mode: "TERMINAL", terminalRuntimeId: "cli:codex" },
  "pane:browser": { id: "pane:browser", roomId: "room:one", mode: "BROWSER" }
};

function fixture(fenced = false) {
  const controlInvoke = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
  const action = vi.fn(async () => ({ text: "page text", session: { currentUrl: "https://example.com/a?q=1" } }));
  const release = vi.fn(async () => false);
  const { controlIntegration } = createSpaceControlIntegration({
    store: {
      getPane: async (id: string) => panes[id],
      getArtifact: async () => ({ id: "artifact:x", roomId: "room:other" })
    } as never,
    config: { browserEvidenceArtifactRoot: "/nonexistent" },
    eventBus: { publish: vi.fn() },
    browserSessionManager: { action } as never,
    controlRepository: {} as never,
    cliRuntimeVisibility: { createDisablePreview: async () => ({ confirmationToken: "token:1" }) as never },
    controlUser: async () => undefined,
    controlInvoke,
    openControlPanes: vi.fn() as never,
    vault: { protection: { ownerOf: async () => (fenced ? "user:operator" : null), release } },
    spaceControl: { inspect: vi.fn() }
  });
  const run = (spec: Record<string, unknown>) => controlIntegration(actor, "room:one", { kind: "resource", input: {}, ...spec } as never);
  return { run, controlIntegration, controlInvoke, action, release };
}

describe("Space Control integration", () => {
  it("keeps a CLI pane's account out of panes.update and strips id and confirm from the body", async () => {
    const { run, controlInvoke } = fixture();
    await expect(run({ operation: "panes.update", id: "pane:cli", input: { accountProfileId: "main" } })).rejects.toThrow("use configure with accountProfileId");
    await run({ operation: "panes.update", id: "pane:browser", input: { title: "B", confirm: true } });
    expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "PATCH", "/api/panes/pane%3Abrowser", { title: "B" });
    await run({ operation: "links.update", input: { id: "link:1", title: "L" } });
    expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "PATCH", "/api/links/link%3A1", { title: "L" });
    await run({ operation: "links.list", input: { q: "docs", page: 2, skip: null } });
    expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "GET", "/api/links?q=docs&page=2", undefined);
    await expect(run({ operation: "links.update", input: {} })).rejects.toThrow("Resource ID is required.");
    await expect(run({ operation: "files.preview", id: "artifact:x" })).rejects.toThrow("Artifact is outside this room.");
  });

  it("maps protected ops to their tools and refuses Asteroids actions it cannot do", async () => {
    const { run, controlInvoke } = fixture();
    await run({ operation: "ops.status", input: { a: 1 }, approvalReason: "asked" });
    expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "POST", "/api/mcp/tools/execute",
      { roomId: "room:one", toolId: "space-readonly:space_status", arguments: { a: 1 }, approvalReason: "asked" });
    await expect(run({ operation: "ops.deploy" })).rejects.toThrow("Unknown protected operation.");
    await expect(run({ operation: "asteroids.control", input: { action: "pause" } })).rejects.toThrow("no verified execution adapter");
    await expect(run({ operation: "asteroids.control", input: { action: "start" } })).rejects.toThrow("Choose an explicit configured model");
    await run({ operation: "asteroids.control", input: { action: "start", modelId: "m1" } });
    expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "POST", "/api/asteroids/benchmark/runs",
      { mode: "championship", contestants: ["m1", "baseline/scripted-pilot"], rounds: 1 });
  });

  it("reads no page text while a Vault fill holds the browser", async () => {
    const fenced = fixture(true);
    await expect(fenced.run({ operation: "browser.content", id: "pane:browser" })).rejects.toThrow("holds a Vault fill");
    expect(fenced.action).not.toHaveBeenCalled();
    const open = fixture();
    expect(await open.run({ operation: "browser.content", id: "pane:browser" })).toMatchObject({ paneId: "pane:browser", text: "page text" });
  });

  it("switches CLI runtimes with the disable preview's token, VPN routes, and refuses other kinds", async () => {
    const { controlIntegration, controlInvoke } = fixture();
    const call = (spec: Record<string, unknown>) => controlIntegration(actor, "room:one", spec as never);
    await call({ kind: "cli", runtimeId: "cli:codex", enabled: false });
    expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "PATCH", "/api/cli/runtime-settings/cli%3Acodex", { enabled: false, confirmationToken: "token:1" });
    await expect(call({ kind: "vpn", operation: "rotate" })).rejects.toThrow("Choose an available VPN profile.");
    await call({ kind: "vpn", operation: "rotate", profile: "greece" });
    expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "POST", "/api/cli/egress/profiles/greece/random-city");
    await expect(call({ kind: "layout" })).rejects.toThrow("Unsupported integration action.");
  });
});
