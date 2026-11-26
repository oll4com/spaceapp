import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { controlExecuteSchema } from "@space/contracts";
import { createSpaceControlIntegration } from "../src/space-control-integration.js";
import { sanitizeControlExecute } from "../src/space-control-routes.js";

const actor = { id: "user:operator" } as never;
const panes: Record<string, { id: string; roomId: string; mode: string; terminalRuntimeId?: string; title?: string; isClosed?: boolean }> = {
  "pane:cli": { id: "pane:cli", roomId: "room:one", mode: "TERMINAL", terminalRuntimeId: "cli:codex" },
  "pane:browser": { id: "pane:browser", roomId: "room:one", mode: "BROWSER" },
  "pane:shell": { id: "pane:shell", roomId: "room:one", mode: "TERMINAL" },
  "pane:closed": { id: "pane:closed", roomId: "room:one", mode: "BROWSER", title: "CLI Browser", isClosed: true }
};

function fixture(fenced = false, root = "/nonexistent") {
  const controlInvoke = vi.fn<(...args: unknown[]) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
  const action = vi.fn(async () => ({ text: "page text", session: { currentUrl: "https://example.com/a?q=1" } }));
  const release = vi.fn(async () => false);
  const { controlIntegration } = createSpaceControlIntegration({
    store: {
      getPane: async (id: string) => panes[id],
      getArtifact: async (id: string) => ({ id, roomId: id === "artifact:room1" ? "room:one" : "room:other" })
    } as never,
    config: { browserEvidenceArtifactRoot: root },
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
    await expect(run({ operation: "links.update", input: {} })).rejects.toThrow("links.update needs id: the resource id.");
    // 23/11 REVIEW: the refusal says how to send a pane id and where to find it, so the retry succeeds.
    await expect(run({ operation: "panes.move", input: { targetRoomId: "room:other" } })).rejects.toThrow("panes.move needs id: the pane id, as id or input.paneId (inspect STATE or space_room_status lists each pane's id).");
    await expect(run({ operation: "files.preview", id: "artifact:x" })).rejects.toThrow("Artifact is outside this room.");
    for (const spec of [
      { operation: "files.preview", id: "artifact:room1" },
      { operation: "files.preview", input: { id: "artifact:room1" } },
      { operation: "files.preview", input: { artifactId: "artifact:room1" } },
      { operation: "files.preview", input: { path: "/api/artifacts/artifact:room1/preview" } }
    ]) {
      await run(spec);
      expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "GET", "/api/artifacts/artifact%3Aroom1/preview", undefined);
    }
    const sanitized = controlExecuteSchema.parse(sanitizeControlExecute({
      roomId: "room:one", requestId: "req:1",
      actions: [{ kind: "resource", operation: "files.preview", path: "/api/artifacts/artifact:room1/preview" }]
    }));
    expect(sanitized.actions[0]).toMatchObject({ kind: "resource", operation: "files.preview", id: "artifact:room1" });
  });

  it("moves and splits a plain shell pane (no runtime, like Dana): layout ops never drive the CLI (22/11, Dana stayed in Cleo)", async () => {
    const { run, controlInvoke } = fixture();
    await run({ operation: "panes.move", id: "pane:shell", input: { targetRoomId: "room:two" } });
    expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "POST", "/api/panes/pane%3Ashell/move", { targetRoomId: "room:two" });
    await run({ operation: "panes.split", id: "pane:shell", input: { direction: "vertical" } });
    expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "POST", "/api/panes", expect.objectContaining({ mode: "TERMINAL", split: expect.objectContaining({ parentId: "pane:shell" }) }));
    await expect(run({ operation: "panes.update", id: "pane:shell", input: { terminalRuntimeId: "cli:bogus" } })).rejects.toThrow("Unsupported CLI runtime.");
  });

  it("answers a move of a closed pane as a no-op naming why, without calling the move route (Daily Nous errors 22/11)", async () => {
    const { run, controlInvoke } = fixture();
    await expect(run({ operation: "panes.move", id: "pane:closed", input: { targetRoomId: "room:two" } }))
      .resolves.toMatchObject({ ok: true, noop: expect.stringMatching(/^Pane CLI Browser is closed: nothing moved\. .*reopen it/) });
    expect(controlInvoke).not.toHaveBeenCalled();
  });

  it("takes files.preview's id from input as Nous sends it, and names what a missing id means (×11 in 7 d)", async () => {
    const { run, controlInvoke } = fixture();
    for (const input of [{ id: "artifact:x" }, { artifactId: "artifact:x" }]) await expect(run({ operation: "files.preview", input })).rejects.toThrow("Artifact is outside this room.");
    await expect(run({ operation: "files.preview", input: { path: "/tmp/a.md" } })).rejects.toThrow("files.preview needs id: the artifact id (artifact:...), not a file path");
    await run({ operation: "browser.navigate", input: { paneId: "pane:browser", url: "https://example.com" } });
    expect(controlInvoke).toHaveBeenLastCalledWith("user:operator", "POST", expect.stringContaining("pane%3Abrowser"), { url: "https://example.com" });
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

  it("returns the ops tool's answer from its MCP result file, never a file outside mcp-executions", async () => {
    const root = await mkdtemp(join(tmpdir(), "ops-output-"));
    try {
      await mkdir(join(root, "mcp-executions", "x"), { recursive: true });
      const inside = join(root, "mcp-executions", "x", "result.json"), outside = join(root, "result.json");
      for (const path of [inside, outside]) await writeFile(path, JSON.stringify({ result: { structuredContent: { ok: true, output: "log line" } } }));
      const { run, controlInvoke } = fixture(false, root);
      controlInvoke.mockResolvedValueOnce({ status: "EXECUTED", artifact: { metadata: { localPath: inside } } } as never);
      expect(await run({ operation: "ops.logs", input: { service: "api" } })).toMatchObject({ output: { structuredContent: { output: "log line" } } });
      controlInvoke.mockResolvedValueOnce({ status: "EXECUTED", artifact: { metadata: { localPath: outside } } } as never);
      expect(await run({ operation: "ops.logs", input: {} })).not.toHaveProperty("output");
    } finally { await rm(root, { recursive: true, force: true }); }
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
