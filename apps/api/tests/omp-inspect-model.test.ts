import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type * as OmpNativeModelModule from "../src/omp-native-model.js";

// The launcher read runs through sudo on the host; here it reports what omp's own session file records.
// vi.mock is hoisted above the imports, so app.ts loads the mocked reader.
const nativeModel = vi.hoisted(() => vi.fn());
vi.mock("../src/omp-native-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OmpNativeModelModule>();
  return { ...actual, loadOmpNativeModel: nativeModel };
});

const secret = "omp-inspect-model-test-only";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); nativeModel.mockReset(); });

async function ompPane(screen: string, catalogDelaySeconds = 0) {
  const root = await mkdtemp(join(tmpdir(), "space-omp-inspect-"));
  // The real wrapper prints `omp models --json` rows as id<TAB>name<TAB>efforts<TAB>default effort.
  await writeFile(join(root, "omp-vscode-parity"), `#!/bin/sh\n[ "$1" = models ] && sleep ${catalogDelaySeconds} && printf '${[
    "space-gateway/gpt-6-sol\\tGPT-6 Sol\\tlow,medium,high,xhigh,max\\tlow\\n",
    "space-gateway-claude/claude-opus-5-5\\tClaude Opus 5.5 (API credits)\\tlow,medium,high,xhigh,max\\tlow\\n"
  ].join("")}'\nexit 0\n`, "utf8");
  await chmod(join(root, "omp-vscode-parity"), 0o755);
  const store = new InMemorySpaceStore();
  store.upsertUser({ id: "user:ADMIN", role: "ADMIN", email: "control@space.local" });
  const room = store.createRoom({ name: "Oh My Pi inspect", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Cody", mode: "TERMINAL", terminalRuntimeId: "cli:omp", cwd: "/etc" });
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:omp", providerId: "oh-my-pi", agentId: "omp",
    status: "RUNNING", modelId: "space-gateway/gpt-6-sol", reasoningEffort: "medium" });
  store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "omp-host", cols: 42, rows: 30 });
  const host = {
    health: async () => ({ hostPid: 1, startedAt: "2026-10-18T00:00:00.000Z", buildCommit: null, sessions: [] }),
    inspect: async () => ({ status: "RUNNING", pid: 3000 }),
    attach: async () => ({ attachmentId: "observer", session: { generationId: "omp-host", nextOutputSequence: 1 }, replay: [{ data: screen }] }),
    input: async () => ({ accepted: true, acceptedAtMs: Date.now() }), resize: async () => undefined,
    detach: async () => true, terminate: async () => true, close: async () => undefined
  };
  const app = await createApp({ store, cliHostClient: host as never,
    config: getApiConfig({ SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_WORKSPACE_ROOT: root,
      SPACE_INTERNAL_API_TOKEN: secret, SPACE_LOG_LEVEL: "silent", SPACE_ARTIFACT_ROOT: join(root, "artifacts") }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
  cleanups.push(() => app.close().then(() => rm(root, { recursive: true, force: true })));
  const cookie = signSession({ id: "user:ADMIN", role: "ADMIN", email: "control@space.local" }, secret);
  const headers = { cookie: `space_session=${cookie}`, "x-space-csrf-token": createCsrfToken(cookie, secret)! };
  return { app, headers, room, pane, session, store };
}

// A 42-column pane: omp's status rail keeps the spinner and the folder but drops the model (pane Cody, 2026-10-18).
const narrowScreen = "\x1b[2J\x1b[2;2H Reading this pane's model\x1b[4;1H ⠧ 1m > 🌳 …e50b ▶───16%──┃──1M─\x1b[5;1H╰─";
// A wide pane whose rail still names the launch model (the rail is the screen fallback).
const wideScreen = "\x1b[2J\x1b[2;2H Reading this pane's model\x1b[4;1H π > ◑ GPT-6 Sol > 🌳 main ▶─2%──\x1b[5;1H╰─   ⇧⇥ to change thinking";

async function inspectModel(screen: string) {
  const { app, headers, room, pane, session, store } = await ompPane(screen);
  const response = await app.inject({ method: "POST", url: "/api/control/v1/inspect", headers,
    payload: { roomId: room.id, section: "MODELS", paneId: pane.id } });
  expect(response.statusCode).toBe(200);
  const settings = await app.inject({ method: "GET", url: `/api/panes/${pane.id}/cli/model-settings`, headers });
  const recorded = { session: store.getPaneCliSession(session.sessionId), pane: store.getPane(pane.id) };
  return { inspected: response.json()[0], current: settings.json().current, pane, session, recorded };
}

describe("Space Control inspection of an Oh My Pi pane", () => {
  it.each([["narrow", narrowScreen], ["wide", wideScreen]])("reports the model omp's own session records after a switch made inside the CLI (%s pane)", async (_width, screen) => {
    nativeModel.mockResolvedValue({ modelId: "space-gateway-claude/claude-opus-5-5", reasoningEffort: "xhigh" });
    const { inspected, current, pane, session, recorded } = await inspectModel(screen);
    expect(inspected).toMatchObject({ runtimeId: "cli:omp", modelId: "space-gateway-claude/claude-opus-5-5" });
    expect(current).toEqual({ modelId: "space-gateway-claude/claude-opus-5-5", reasoningEffort: "xhigh" });
    // Bound to the live process the pane host reports for this session.
    expect(nativeModel).toHaveBeenCalledWith(expect.objectContaining({ paneId: pane.id, sessionId: session.sessionId }), 3000);
    // The session and the pane record the switch, so the room state and the pane's next launch name it too.
    expect(recorded.session).toMatchObject({ modelId: "space-gateway-claude/claude-opus-5-5", reasoningEffort: "xhigh" });
    expect(recorded.pane).toMatchObject({ modelId: "space-gateway-claude/claude-opus-5-5", reasoningEffort: "xhigh" });
  });

  it("keeps the launch model when omp's session cannot be read or names a model outside the catalog", async () => {
    nativeModel.mockResolvedValue(null);
    const unread = await inspectModel(narrowScreen);
    expect(unread.inspected).toMatchObject({ runtimeId: "cli:omp", modelId: "space-gateway/gpt-6-sol" });
    expect(unread.current).toEqual({ modelId: "space-gateway/gpt-6-sol", reasoningEffort: "medium" });
    expect(unread.recorded.session).toMatchObject({ modelId: "space-gateway/gpt-6-sol", reasoningEffort: "medium" });
    nativeModel.mockResolvedValue({ modelId: "openrouter/retired-model:free", reasoningEffort: "high" });
    const unknown = await inspectModel(narrowScreen);
    expect(unknown.inspected).toMatchObject({ modelId: "space-gateway/gpt-6-sol" });
    expect(unknown.current).toEqual({ modelId: "space-gateway/gpt-6-sol", reasoningEffort: "medium" });
    expect(unknown.recorded.session).toMatchObject({ modelId: "space-gateway/gpt-6-sol", reasoningEffort: "medium" });
  });

  it("answers within Space Control's inspection window while omp's model catalog is still loading", async () => {
    nativeModel.mockResolvedValue({ modelId: "space-gateway-claude/claude-opus-5-5", reasoningEffort: "xhigh" });
    // omp lists ~600 models in about 2 s; the inspection gives a pane 2.5 s.
    const { app, headers, room, pane } = await ompPane(narrowScreen, 3);
    const response = await app.inject({ method: "POST", url: "/api/control/v1/inspect", headers,
      payload: { roomId: room.id, section: "MODELS", paneId: pane.id } });
    // A timed-out inspection answers only { state: "UNKNOWN", reason }.
    expect(response.json()[0]).toMatchObject({ runtimeId: "cli:omp", modelId: "space-gateway-claude/claude-opus-5-5" });
  });
});
