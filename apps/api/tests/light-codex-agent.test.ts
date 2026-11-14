import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { harnessAgentSessionId } from "../src/harness-agent-tokens.js";
import { agentPanePrincipal, lightCodexPrincipal, lightCodexSessionId } from "../src/light-codex-agent.js";
import { verifyControlToken } from "../src/space-control-token.js";

const secret = "synthetic-internal-token-for-light-codex-tests";
const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

describe("Codex light pane identity (plan YqhRIXfLAnfK Δ S2)", () => {
  it("accepts the light principal only for an open light pane in the token's room", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Light principal", initialPaneCount: 0 });
    const other = store.createRoom({ name: "Other", initialPaneCount: 0 });
    const light = store.createPane({ roomId: room.id, mode: "CHAT", title: "Codex light", terminalRuntimeId: "cli:codex" });
    const chat = store.createPane({ roomId: room.id, mode: "CHAT", title: "Chat" });
    const claims = (paneId: string, roomId = room.id, cliSessionId = lightCodexSessionId(paneId)) => ({ roomId, paneId, cliSessionId });
    expect(await lightCodexPrincipal(store, claims(light.id))).toBe(true);
    expect(await lightCodexPrincipal(store, claims(light.id, other.id))).toBe(false);
    expect(await lightCodexPrincipal(store, claims(chat.id))).toBe(false);
    expect(await lightCodexPrincipal(store, claims(light.id, room.id, lightCodexSessionId(chat.id)))).toBe(false);
    // The control preHandler's choice: a light or Harness token is checked against its pane, a CLI session token is not.
    expect(await agentPanePrincipal(store, claims(light.id))).toBe(true);
    expect(await agentPanePrincipal(store, claims(light.id, room.id, harnessAgentSessionId(light.id)))).toBe(false);
    expect(await agentPanePrincipal(store, claims(light.id, room.id, "cli-session:1"))).toBeNull();
    // An update keeps the pane light while it stays CHAT; leaving CHAT ends it.
    expect(store.updatePane(light.id, { title: "Renamed" }).terminalRuntimeId).toBe("cli:codex");
    store.updatePane(light.id, { isClosed: true });
    expect(await lightCodexPrincipal(store, claims(light.id))).toBe(false);
  });

  it("builds the launch env from the pane record for the worker only, and its control token acts as the pane", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-light-codex-")); roots.push(root);
    const store = new InMemorySpaceStore();
    const config = getApiConfig({ SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: secret, SPACE_ARTIFACT_ROOT: root, SPACE_LOG_LEVEL: "silent" });
    const app = await createApp({ store, config, auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
    try {
      store.upsertUser({ id: "user:ADMIN", role: "ADMIN", email: "light@space.local" });
      const session = signSession({ id: "user:ADMIN", role: "ADMIN", email: "light@space.local" }, secret);
      const operator = { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, secret)! };
      const room = store.createRoom({ name: "Light tools", initialPaneCount: 0, kind: "AGENT_PROOF" }, undefined, "user:ADMIN");
      const light = store.createPane({ roomId: room.id, mode: "CHAT", title: "Codex light", terminalRuntimeId: "cli:codex" });
      const chat = store.createPane({ roomId: room.id, mode: "CHAT", title: "Chat" });
      const launchEnv = (paneId: string, headers: Record<string, string> = { "x-space-internal-token": secret }, extra = {}) =>
        app.inject({ method: "POST", url: "/api/internal/agent/light-codex-env", headers, payload: { paneId, ...extra } });

      expect((await launchEnv(light.id, {})).statusCode).toBe(401);
      expect((await launchEnv(light.id, { "x-space-internal-token": "wrong" })).statusCode).toBe(401);
      expect((await launchEnv(light.id, operator)).statusCode).toBe(401);
      // The caller names the pane only; anything else is refused.
      expect((await launchEnv(light.id, undefined, { roomId: "room:other", env: { SPACE_ROOM_ID: "x" } })).statusCode).toBe(422);
      expect((await launchEnv(chat.id)).statusCode).toBe(404);
      expect((await launchEnv("pane:missing")).statusCode).toBe(404);

      const response = await launchEnv(light.id);
      expect(response.statusCode).toBe(200);
      const { env } = response.json() as { env: Record<string, string> };
      expect(env).toMatchObject({ SPACE_ROOM_ID: room.id, SPACE_PANE_ID: light.id, SPACE_CLI_SESSION_ID: lightCodexSessionId(light.id),
        SPACE_CLI_RUNTIME_ID: "cli:codex", SPACE_AGENT_CHANNEL: "CLI" });
      expect(env.SPACE_CODEX_PER_SESSION_APP_SERVER).toBeUndefined();
      expect(env[config.codexAppServerKeyEnv]).toBeUndefined();
      expect(Object.keys(env).filter((name) => /^SPACE_(BROWSER_ACTION_TOKEN|AGENT_FILES_TOKEN)$/.test(name))).toEqual([]);
      expect(verifyControlToken(secret, env.SPACE_CONTROL_TOKEN)).toMatchObject({ roomId: room.id, paneId: light.id, cliSessionId: lightCodexSessionId(light.id) });

      const control = (requestId: string) => app.inject({ method: "POST", url: "/api/cli/control/mcp", headers: { "x-space-control-token": env.SPACE_CONTROL_TOKEN },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "space_execute", arguments: { roomId: room.id, requestId, actions: [{ kind: "room", operation: "rename", name: "Renamed by Codex light" }] } } } });
      expect((await control("before-grant")).json().error.code).toBe("CONTROL_NOT_GRANTED");
      expect((await app.inject({ method: "POST", url: "/api/control/v1/grant", headers: operator, payload: { roomId: room.id, enabled: true } })).statusCode).toBe(200);
      expect((await control("granted")).json().result.structuredContent.status).toBe("COMPLETED");
      expect(store.getRoom(room.id).name).toBe("Renamed by Codex light");
      // A closed light pane gets no env and its token stops working.
      store.updatePane(light.id, { isClosed: true });
      expect((await launchEnv(light.id)).statusCode).toBe(404);
      expect((await control("closed")).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
