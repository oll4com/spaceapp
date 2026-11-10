import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPaneCliModel } from "../src/pane-cli-model.js";

const pane = { id: "pane:one", roomId: "room:one", mode: "TERMINAL" } as never;
const droid = { sessionId: "cli:droid-one", runtimeId: "cli:droid", accountProfileId: "main", modelId: null, reasoningEffort: null, isActive: true, status: "RUNNING" };
const codex = { sessionId: "cli:codex-one", runtimeId: "cli:codex", cwd: "/tmp", modelId: null, reasoningEffort: null };
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pane-cli-model-"));
  // A wrapper that lists one model, in the TSV every native wrapper prints for `models`.
  await writeFile(join(dir, "droid-vscode-parity"), "#!/bin/sh\nprintf 'claude-fable-5.1\\tFable 5.1\\tlow,medium,high\\thigh\\n'\n");
  await chmod(join(dir, "droid-vscode-parity"), 0o755);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

function fixture(screen: string, runtimes: Array<{ id: string; detectedCommandPath?: string }>, codexModels: unknown[] = [], socket = true) {
  const sent: string[] = [];
  const model = createPaneCliModel({
    store: { getPaneCliSession: async () => codex, getActivePaneCliSession: async () => droid } as never,
    cliTerminalManager: {
      observeRoomScreen: async () => ({ text: screen, revision: 1 }),
      sendInput: async (_id: string, data: string) => { sent.push(data); }
    } as never,
    cliRuntimeRegistryCache: { read: async () => ({ data: runtimes }) } as never,
    codexSessionSocketProbe: async () => socket,
    codexSocketControlFactory: () => ({ listModels: async () => codexModels }) as never,
    findCodexThreadRuntimeSettings: vi.fn()
  });
  return { model, sent };
}

describe("pane CLI model", () => {
  it("reads a native CLI's catalog and refuses a CLI that has none", async () => {
    const { model } = fixture("> ", [{ id: "cli:droid", detectedCommandPath: join(dir, "droid-vscode-parity") }]);
    const settings = await model.readPaneNativeModelSettings(droid as never);
    expect(settings).toMatchObject({ controlMode: "NATIVE", current: null, isTurnActive: false });
    expect(settings.models.map((entry) => entry.id)).toEqual(["claude-fable-5.1"]);
    await expect(fixture("> ", [{ id: "cli:droid" }]).model.readPaneNativeModelSettings(droid as never)).rejects.toThrow("This CLI does not expose a model catalog.");
  });

  it("switches only to an advertised model and never during a turn", async () => {
    const input = { pane, active: droid as never, reasoningEffort: "high", traceId: "trace:one", assertControl: async () => undefined };
    const idle = fixture("> ", [{ id: "cli:droid", detectedCommandPath: join(dir, "droid-vscode-parity") }]);
    await expect(idle.model.applyNativePaneModel({ ...input, modelId: "gpt-nope" })).rejects.toThrow("The selected model settings are not advertised by this CLI.");
    const busy = fixture("✻ Working… (esc to interrupt)", [{ id: "cli:droid", detectedCommandPath: join(dir, "droid-vscode-parity") }]);
    await expect(busy.model.applyNativePaneModel({ ...input, modelId: "claude-fable-5.1" })).rejects.toThrow("Wait for this CLI turn to finish before changing models.");
    expect([...idle.sent, ...busy.sent]).toEqual([]);
  });

  it("gives live model settings only for a Codex pane whose app-server answers with a catalog", async () => {
    await expect(fixture("", []).model.readPaneCliModelSettings(pane, droid as never, "trace:one")).rejects.toThrow("Model switching is available only for Codex CLI panes.");
    await expect(fixture("", [], [], false).model.readPaneCliModelSettings(pane, codex as never, "trace:one")).rejects.toThrow("Live Codex model control is unavailable");
    await expect(fixture("", []).model.readPaneCliModelSettings(pane, codex as never, "trace:one")).rejects.toThrow("Codex did not advertise any selectable models.");
  });
});
