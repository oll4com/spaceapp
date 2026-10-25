import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { paneCliModelSettingsStatusSchema } from "@space/contracts";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { signSession } from "../src/auth.js";

describe("native model settings routes", () => {
  it("serves all eight native CLI catalogs through the authenticated pane route without inventing current settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-native-models-"));
    const runtimes = ["claude", "gemini", "kimi", "grok", "deepseek", "cursor", "copilot", "hermes"] as const;
    const store = new InMemorySpaceStore();
    const config = getApiConfig({ SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root });
    const panes = [];
    for (const runtime of runtimes) {
      config.cliCredentialSmoke[runtime] = true;
      await writeFile(join(root, config.cliRuntimeCommands[runtime]),
        '#!/bin/sh\n[ "$1" = models ] || exit 64\nprintf "test-model\\tTest Model\\n"\n', { mode: 0o755 });
      const room = store.createRoom({ name: runtime, initialPaneCount: 0 });
      const pane = store.createPane({ roomId: room.id, title: runtime, mode: "TERMINAL", terminalRuntimeId: `cli:${runtime}` });
      store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: `cli:${runtime}`,
        providerId: runtime, agentId: runtime, modelId: null, reasoningEffort: "none", cwd: "/etc",
        status: "RUNNING", isActive: true, statusReason: "Test fixture" });
      panes.push(pane);
    }
    const sessionSecret = "native-model-route-test-only";
    const app = await createApp({ store, config, auth: { sessionSecret, devLogin: false, secureCookies: false } });
    const cookie = `space_session=${signSession({ id: "user:test", email: "test@example.test", role: "ADMIN" }, sessionSecret)}`;
    try {
      for (const pane of panes) {
        const url = `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings/status`;
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
        const response = await app.inject({ method: "GET", url, headers: { cookie } });
        expect(response.statusCode, pane.title).toBe(200);
        const result = paneCliModelSettingsStatusSchema.parse(response.json());
        expect(result.status, pane.title).toBe("AVAILABLE");
        if (result.status === "AVAILABLE") {
          expect(result.settings.controlMode).toBe("NATIVE");
          expect(result.settings.current, pane.title).toBeNull();
          expect(result.settings.models[0]).toMatchObject({ id: pane.terminalRuntimeId === "cli:cursor" ? "cursor-family:test-model"
            : pane.terminalRuntimeId === "cli:claude" ? "claude:test-model" : "test-model", displayName: "Test Model" });
        }
      }
      const hermes = panes.find(pane => pane.terminalRuntimeId === 'cli:hermes')!;
      const active = store.getActivePaneCliSession(hermes.id)!;
      store.updatePaneCliSession(active.sessionId, { reasoningEffort: 'medium' });
      store.appendPaneCliTranscriptChunk({sessionId:active.sessionId,paneId:hermes.id,roomId:hermes.roomId,
        sequence:1,stream:'stdout',content:'Model: test-model\r\n❯ '});
      const url = `/api/panes/${encodeURIComponent(hermes.id)}/cli/model-settings`;
      // The pane's generic startup default is not a native acknowledgement.
      const observed = await app.inject({method:'GET',url,headers:{cookie}});
      expect(observed.json().current).toEqual({modelId:'test-model',reasoningEffort:'unknown'});
      store.updatePaneCliSession(active.sessionId, {modelId:'test-model',reasoningEffort:'medium'});
      const confirmed = await app.inject({method:'GET',url,headers:{cookie}});
      expect(confirmed.json().current).toEqual({modelId:'test-model',reasoningEffort:'medium'});
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
