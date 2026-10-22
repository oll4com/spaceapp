import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { verifyCliAgentFilesToken } from "../src/cli-agent-files.js";
import { agentTokenTtlMs, cliBrowserBridgeTokenHeader, verifyCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { harnessAgentPrincipal, harnessAgentSessionId, harnessPaneTokenSessions, publishHarnessAgentTokens } from "../src/harness-agent-tokens.js";
import { verifyControlToken } from "../src/space-control-token.js";

const secret = "synthetic-internal-token-for-harness-tests";
const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });
const tempRoot = async () => { const root = await mkdtemp(join(tmpdir(), "space-harness-agent-tokens-")); roots.push(root); return root; };
const tokenConfig = { internalApiToken: secret, browserToolBridgeEnabled: true, host: "0.0.0.0", port: 4910, browserEvidenceTargetOrigin: "https://space.test:4911" };

describe("Harness agent tokens", () => {
  it("publishes a Harness pane's browser, Agent Files and Space Control tokens under its harness session", async () => {
    const root = await tempRoot(), dir = join(root, "tokens");
    let now = Date.parse("2026-10-17T12:00:00Z");
    const options = { config: tokenConfig, dir, groupFrom: root, now: () => now };
    const input = { roomId: "room:hrnRoom0001", paneId: "pane:hrnPane0001" };
    expect(await publishHarnessAgentTokens(options, input)).toBe("written");
    const path = join(dir, "space-pane-hrnPane0001.json");
    const file = JSON.parse(await readFile(path, "utf8"));
    expect(file).toMatchObject({ version: 1, sessionId: "space-pane-hrnPane0001", ...input, env: { SPACE_ROOM_ID: input.roomId,
      SPACE_PANE_ID: input.paneId, SPACE_BROWSER_COMMAND_ENDPOINT: "https://space.test:4911/api/cli/browser/commands",
      SPACE_AGENT_FILES_ENDPOINT: "https://space.test:4911/api/cli/agent-files", SPACE_CONTROL_ENDPOINT: "https://space.test:4911/api/cli/control/mcp" } });
    const claims = { ...input, cliSessionId: harnessAgentSessionId(input.paneId) };
    expect(verifyCliBrowserBridgeToken(tokenConfig, file.env.SPACE_BROWSER_ACTION_TOKEN, now)).toMatchObject(claims);
    expect(verifyCliAgentFilesToken(tokenConfig, file.env.SPACE_AGENT_FILES_TOKEN, now)).toMatchObject(claims);
    expect(verifyControlToken(secret, file.env.SPACE_CONTROL_TOKEN)).toMatchObject(claims);
    expect(file.expiresAt).toBe(now + agentTokenTtlMs);
    // Readable by the harness user's group only.
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect((await stat(dir)).mode & 0o7777).toBe(0o2750);
    now += 5 * 3_600_000;
    expect(await publishHarnessAgentTokens(options, input)).toBe("fresh");
    expect(await publishHarnessAgentTokens(options, { ...input, roomId: "room:hrnRoom0002" })).toBe("written");
    expect(await publishHarnessAgentTokens({ ...options, config: { ...tokenConfig, internalApiToken: null } }, { ...input, paneId: "pane:hrnPane0002" })).toBe("unavailable");
  });

  it("follows the session the operator picked in the pane, never another pane's own session", async () => {
    const root = await tempRoot(), dir = join(root, "tokens");
    let now = Date.parse("2026-10-18T01:00:00Z");
    const options = { config: tokenConfig, dir, groupFrom: root, now: () => now };
    const input = { roomId: "room:hrnRoom0001", paneId: "pane:hrnPane0001" };
    const picked = "session-95b30931-0857-49b8-80fc-eaeae6a0e5be";
    const read = async (name: string) => JSON.parse(await readFile(join(dir, `${name}.json`), "utf8"));
    const exists = (name: string) => stat(join(dir, `${name}.json`)).then(() => true, () => false);
    expect(harnessPaneTokenSessions(input.paneId, picked)).toEqual(["space-pane-hrnPane0001", picked]);
    for (const bound of [undefined, null, "", "space-pane-hrnPane0001", "space-pane-otherPane01", "../x", "a/b", ".hidden", "a:b"])
      expect(harnessPaneTokenSessions(input.paneId, bound)).toEqual(["space-pane-hrnPane0001"]);

    // The picked session gets the pane's tokens next to the pane's own session.
    expect(await publishHarnessAgentTokens(options, { ...input, boundSessionId: picked })).toBe("written");
    const file = await read(picked);
    expect(file).toMatchObject({ version: 1, sessionId: picked, ...input, env: { SPACE_ROOM_ID: input.roomId, SPACE_PANE_ID: input.paneId } });
    expect(verifyControlToken(secret, file.env.SPACE_CONTROL_TOKEN)).toMatchObject({ ...input, cliSessionId: harnessAgentSessionId(input.paneId) });
    expect((await stat(join(dir, `${picked}.json`))).mode & 0o777).toBe(0o640);
    expect(await exists("space-pane-hrnPane0001")).toBe(true);
    expect(await publishHarnessAgentTokens(options, { ...input, boundSessionId: picked })).toBe("fresh");

    // Another pane's own session file is never overwritten with this pane's tokens.
    expect(await publishHarnessAgentTokens(options, { roomId: input.roomId, paneId: "pane:otherPane01" })).toBe("written");
    expect(await publishHarnessAgentTokens(options, { ...input, boundSessionId: "space-pane-otherPane01" })).toBe("fresh");
    expect((await read("space-pane-otherPane01")).paneId).toBe("pane:otherPane01");
    // Showing its own session again drops the file of the session it no longer shows.
    expect(await exists(picked)).toBe(false);

    // Moving to another session moves the tokens; a session another pane now shows keeps that pane's file.
    expect(await publishHarnessAgentTokens(options, { ...input, boundSessionId: picked })).toBe("written");
    expect(await publishHarnessAgentTokens(options, { roomId: input.roomId, paneId: "pane:otherPane01", boundSessionId: picked })).toBe("written");
    expect((await read(picked)).paneId).toBe("pane:otherPane01");
    expect(await publishHarnessAgentTokens(options, { ...input, boundSessionId: "session-next" })).toBe("written");
    expect((await read(picked)).paneId).toBe("pane:otherPane01");
    expect((await read("session-next")).paneId).toBe(input.paneId);

    // Expired files go (the tokens live as long as agent tokens do; a closed pane's are refused before that).
    now += agentTokenTtlMs + 3_600_000;
    expect(await publishHarnessAgentTokens(options, { roomId: input.roomId, paneId: "pane:thirdPane01" })).toBe("written");
    for (const name of [picked, "session-next", "space-pane-hrnPane0001", "space-pane-otherPane01"]) expect(await exists(name)).toBe(false);
    expect(await exists("space-pane-thirdPane01")).toBe(true);
  });

  it("accepts the Harness principal only for an open Harness pane in the token's room", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Harness principal", initialPaneCount: 0 });
    const other = store.createRoom({ name: "Other", initialPaneCount: 0 });
    const harness = store.createPane({ roomId: room.id, mode: "HARNESS", title: "Harness" });
    const cli = store.createPane({ roomId: room.id, mode: "TERMINAL", title: "CLI" });
    const claims = (paneId: string, roomId = room.id, cliSessionId = harnessAgentSessionId(paneId)) => ({ roomId, paneId, cliSessionId });
    expect(await harnessAgentPrincipal(store, claims(harness.id))).toBe(true);
    expect(await harnessAgentPrincipal(store, claims(harness.id, other.id))).toBe(false);
    expect(await harnessAgentPrincipal(store, claims(cli.id))).toBe(false);
    expect(await harnessAgentPrincipal(store, claims(harness.id, room.id, harnessAgentSessionId(cli.id)))).toBe(false);
    store.updatePane(harness.id, { isClosed: true });
    expect(await harnessAgentPrincipal(store, claims(harness.id))).toBe(false);
  });

  it("lets a Harness pane use its room's task bridge and Space Control under the operator's CLI grant", async () => {
    const root = await tempRoot(), store = new InMemorySpaceStore();
    const config = getApiConfig({ SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: secret, SPACE_ARTIFACT_ROOT: root, SPACE_LOG_LEVEL: "silent" });
    const app = await createApp({ store, config, auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
    try {
      store.upsertUser({ id: "user:ADMIN", role: "ADMIN", email: "harness@space.local" });
      const session = signSession({ id: "user:ADMIN", role: "ADMIN", email: "harness@space.local" }, secret);
      const operator = { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, secret)! };
      const room = store.createRoom({ name: "Harness tools", initialPaneCount: 0, kind: "AGENT_PROOF" }, undefined, "user:ADMIN");
      const harness = store.createPane({ roomId: room.id, mode: "HARNESS", title: "Harness" });
      const dir = join(root, "tokens");
      await publishHarnessAgentTokens({ config, dir, groupFrom: root }, { roomId: room.id, paneId: harness.id });
      const { env } = JSON.parse(await readFile(join(dir, `space-pane-${harness.id.slice(5)}.json`), "utf8"));
      const bridge = { [cliBrowserBridgeTokenHeader]: env.SPACE_BROWSER_ACTION_TOKEN, "content-type": "application/json" };
      const created = await app.inject({ method: "POST", url: "/api/cli/task-items", headers: bridge, payload: { title: "Harness task", objective: "Check it." } });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ source: "AGENT", paneId: harness.id });
      const control = (requestId: string) => app.inject({ method: "POST", url: "/api/cli/control/mcp", headers: { "x-space-control-token": env.SPACE_CONTROL_TOKEN },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "space_execute", arguments: { roomId: room.id, requestId, actions: [{ kind: "room", operation: "rename", name: "Renamed by Harness" }] } } } });
      expect((await control("before-grant")).json().error.code).toBe("CONTROL_NOT_GRANTED");
      expect((await app.inject({ method: "POST", url: "/api/control/v1/grant", headers: operator, payload: { roomId: room.id, enabled: true } })).statusCode).toBe(200);
      const allowed = await control("granted");
      expect(allowed.json().result.structuredContent.status).toBe("COMPLETED");
      expect(store.getRoom(room.id).name).toBe("Renamed by Harness");
      // A closed Harness pane's tokens stop working.
      store.updatePane(harness.id, { isClosed: true });
      const closed = await app.inject({ method: "GET", url: "/api/cli/task-items", headers: bridge });
      expect(closed.statusCode).toBe(404);
      expect(closed.json().error.code).toBe("HARNESS_PANE_NOT_FOUND");
      expect((await control("closed")).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
