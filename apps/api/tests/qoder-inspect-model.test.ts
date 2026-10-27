import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const secret = "qoder-inspect-model-test-only";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("Space Control inspection of a Qoder pane", () => {
  it("reports the model Qoder's footer shows, before any model switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-qoder-inspect-"));
    // The real wrapper prints `qodercli --list-models` rows as id<TAB>name.
    const row = "Claude Opus 5.5 (API credits) (space-gateway-claude/claude-opus-5-5)";
    await writeFile(join(root, "qoder-vscode-parity"), `#!/bin/sh\n[ "$1" = models ] && printf 'Qwen3.8-Flash\\tQwen3.8-Flash\\n${row}\\t${row}\\n'\nexit 0\n`, "utf8");
    await chmod(join(root, "qoder-vscode-parity"), 0o755);
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:ADMIN", role: "ADMIN", email: "control@space.local" });
    const room = store.createRoom({ name: "Qoder inspect", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Cody", mode: "TERMINAL", terminalRuntimeId: "cli:qoder", cwd: "/etc" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:qoder", providerId: "qoder", agentId: "qoder", status: "RUNNING" });
    store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "qoder-host", cols: 100, rows: 30 });
    // A fresh pane launched without a model: only the footer names it (observed on pane Cody, 2026-10-17).
    const screen = "\x1b[2J\x1b[2;2HShift+Tab to Accept Edits\x1b[4;2H>   Type your message or @path/to/file\x1b[6;2HClaude Opus 5.5 (API credits) (space-gateway-claude) Model · Extra High · ctx 3% · /etc";
    const host = {
      health: async () => ({ hostPid: 1, startedAt: "2026-10-18T00:00:00.000Z", buildCommit: null, sessions: [] }),
      inspect: async () => null,
      attach: async () => ({ attachmentId: "observer", session: { generationId: "qoder-host", nextOutputSequence: 1 }, replay: [{ data: screen }] }),
      input: async () => ({ accepted: true, acceptedAtMs: Date.now() }), resize: async () => undefined,
      detach: async () => true, terminate: async () => true, close: async () => undefined
    };
    const app = await createApp({ store, cliHostClient: host as never,
      config: getApiConfig({ SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_WORKSPACE_ROOT: root,
        SPACE_INTERNAL_API_TOKEN: secret, SPACE_LOG_LEVEL: "silent", SPACE_ARTIFACT_ROOT: join(root, "artifacts") }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
    cleanups.push(() => app.close().then(() => rm(root, { recursive: true, force: true })));
    const cookie = signSession({ id: "user:ADMIN", role: "ADMIN", email: "control@space.local" }, secret);
    const response = await app.inject({ method: "POST", url: "/api/control/v1/inspect",
      headers: { cookie: `space_session=${cookie}`, "x-space-csrf-token": createCsrfToken(cookie, secret)! },
      payload: { roomId: room.id, section: "MODELS", paneId: pane.id } });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({ runtimeId: "cli:qoder", state: "IDLE", modelId: "space-gateway-claude/claude-opus-5-5" });
  });
});
