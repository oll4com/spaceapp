import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { paneCliModelSettingsStatusSchema } from "@space/contracts";

const sessionSecret = "opencode-model-settings-test-secret";
const csrfHeaderName = "x-space-csrf-token";
// OpenCode 2 serves Basic auth with the fixed user "opencode".
const username = "opencode";
const password = "test-password";

const apps: FastifyInstance[] = [];

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    [csrfHeaderName]: createCsrfToken(session, sessionSecret)!
  };
}

interface MockOpenCodeServerState {
  models: Array<{ id: string; providerID: string; name: string; status: string; enabled: boolean }>;
  currentModel: { id: string; providerID: string; variant?: string | null } | null;
  turnActive: boolean;
  switched: Array<{ id: string; providerID: string; variant?: string | null }>;
  denied?: boolean;
  title?: string;
  titleUpdates: string[];
  titleDenied?: boolean;
  aborted: string[];
  abortDenied?: boolean;
}

function startMockOpenCodeServer(state: MockOpenCodeServerState) {
  state.switched = [];
  state.titleUpdates = [];
  state.aborted = [];
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push(`${req.method} ${req.url}`);
      const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
      if (req.headers.authorization !== expectedAuthorization) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.url === "/api/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { version: "2.0.32" } }));
        return;
      }
      if (req.url?.startsWith("/api/model")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          data: state.models.map((model) => ({ ...model }))
        }));
        return;
      }
      if (req.url === "/api/session/active") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: state.turnActive ? { ses_mock01: { type: "busy" } } : {} }));
        return;
      }
      if (req.url?.endsWith("/interrupt") && req.method === "POST") {
        if (state.abortDenied) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "abort unavailable" }));
          return;
        }
        const nativeSessionId = decodeURIComponent(req.url.slice("/api/session/".length, -"/interrupt".length));
        state.aborted.push(nativeSessionId);
        state.turnActive = false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ interrupted: true }));
        return;
      }
      if (req.url?.startsWith("/api/session/") && req.method === "GET") {
        const nativeSessionId = decodeURIComponent(req.url.slice("/api/session/".length));
        const current = state.currentModel
          ? {
              id: state.currentModel.id,
              providerID: state.currentModel.providerID,
              variant: state.currentModel.variant ?? null
            }
          : null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ data: {
            id: nativeSessionId,
            model: current,
            title: state.title ?? null,
            time: { created: 1783555200000, updated: 1783555200000 }
          } })
        );
        return;
      }
      if (req.url?.startsWith("/api/session/") && req.method === "PATCH" && !req.url.endsWith("/model")) {
        if (state.titleDenied) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "title update unavailable" }));
          return;
        }
        try {
          const payload = JSON.parse(body) as { title?: string };
          state.title = payload.title ?? state.title;
          if (payload.title) state.titleUpdates.push(payload.title);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { title: state.title } }));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
        }
        return;
      }
      if (req.url?.startsWith("/api/session/") && req.method === "POST" && req.url.endsWith("/model")) {
        if (state.denied) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "model not allowed" }));
          return;
        }
        try {
          const payload = JSON.parse(body) as { model?: { id: string; providerID: string; variant?: string | null } };
          state.currentModel = payload.model ?? null;
          if (payload.model) state.switched.push(payload.model);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
        }
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return { server, requests, state };
}

function paneCliSessionFixture(store: InMemorySpaceStore, suffix: string) {
  const room = store.createRoom({ name: `OpenCode room ${suffix}`, initialPaneCount: 0 });
  const pane = store.createPane({
    roomId: room.id,
    title: `${suffix} OpenCode`,
    mode: "TERMINAL",
    terminalRuntimeId: "cli:opencode",
    cwd: "/etc"
  });
  const session = store.createPaneCliSession({
    paneId: pane.id,
    roomId: room.id,
    runtimeId: "cli:opencode",
    providerId: "opencode",
    agentId: "opencode",
    modelId: null,
    reasoningEffort: "default",
    cwd: "/etc",
    status: "RUNNING",
    statusReason: "OpenCode test session",
    isActive: true
  });
  return { room, pane, session };
}

async function writeControlFile(stateRoot: string, spaceSessionId: string, serverPort: number) {
  const controlDir = join(stateRoot, "opencode", "space-cli-control");
  await mkdir(controlDir, { recursive: true, mode: 0o710 });
  await chmod(controlDir, 0o710);
  const fileName = `${spaceSessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
  const path = join(controlDir, fileName);
  await writeFile(
    path,
    `${JSON.stringify({
      version: 1,
      spaceSessionId,
      nativeSessionId: "ses_mock01",
      serverPort,
      // Keep this test server separate from the production netns loopback rewrite.
      serverHost: "127.0.0.2",
      serverUsername: username,
      serverPassword: password,
      updatedAt: new Date().toISOString()
    })}\n`,
    { encoding: "utf8", mode: 0o640 }
  );
  await chmod(path, 0o640);
}

describe("OpenCode live model settings routes", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "space-opencode-state-"));
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("reads live OpenCode model settings and reports AVAILABLE status", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = paneCliSessionFixture(store, "read");
    const mock = startMockOpenCodeServer({
      models: [
        { id: "deepseek-v4-flash-free", providerID: "opencode", name: "DeepSeek V4 Flash Free", status: "active", enabled: true },
        { id: "kimi-k3", providerID: "legacy", name: "Kimi K3", status: "active", enabled: true }
      ],
      currentModel: { id: "deepseek-v4-flash-free", providerID: "opencode" },
      turnActive: false
    });
    const listening = new Promise<number>((resolve) => mock.server.listen(0, "127.0.0.2", () => {
      resolve((mock.server.address() as AddressInfo).port);
    }));
    const port = await listening;
    await writeControlFile(stateRoot, session.sessionId, port);

    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      opencodeStateRoot: stateRoot
    });
    apps.push(app);
    const headers = authHeaders("ADMIN");

    const status = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings/status`,
      headers
    });
    expect(status.statusCode).toBe(200);
    const parsed = paneCliModelSettingsStatusSchema.parse(status.json());
    expect(parsed.status).toBe("AVAILABLE");
    expect(parsed.settings.controlMode).toBe("OPENCODE");
    expect(parsed.settings.isTurnActive).toBe(false);
    expect(parsed.settings.current).toEqual({
      modelId: "opencode/deepseek-v4-flash-free",
      reasoningEffort: "default"
    });
    expect(parsed.settings.models.map((model) => model.id)).toEqual([
      "opencode/deepseek-v4-flash-free",
      "legacy/kimi-k3"
    ]);
    expect(parsed.settings.models[0].supportedReasoningEfforts).toEqual(["default"]);
    expect(parsed.settings.models[0].defaultReasoningEffort).toBe("default");

    const settings = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      sessionId: session.sessionId,
      controlMode: "OPENCODE"
    });
    expect(settings.json().sessionId).toBe(session.sessionId);

    // An idle native footer may lag behind the persisted, server-confirmed selection.
    store.appendPaneCliTranscriptChunk({sessionId:session.sessionId,paneId:pane.id,roomId:pane.roomId,
      sequence:1,stream:'stdout',content:'  ┃ Build · Kimi K3 legacy\r\n  ╹▀▀▀'});
    const native = await app.inject({method:'GET',url:`/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,headers});
    expect(native.json().current).toEqual({modelId:'opencode/deepseek-v4-flash-free',reasoningEffort:'default'});
    mock.state.currentModel = { id: 'kimi-k3', providerID: 'legacy' };
    const changed = await app.inject({method:'GET',url:`/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,headers});
    expect(changed.json().current).toEqual({modelId:'legacy/kimi-k3',reasoningEffort:'default'});

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  it("switches the OpenCode model through the live server and confirms it", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = paneCliSessionFixture(store, "switch");
    const mock = startMockOpenCodeServer({
      models: [
        { id: "deepseek-v4-flash-free", providerID: "opencode", name: "DeepSeek V4 Flash Free", status: "active", enabled: true },
        { id: "kimi-k3", providerID: "legacy", name: "Kimi K3", status: "active", enabled: true }
      ],
      currentModel: { id: "deepseek-v4-flash-free", providerID: "opencode" },
      turnActive: false
    });
    const port = await new Promise<number>((resolve) => mock.server.listen(0, "127.0.0.2", () => {
      resolve((mock.server.address() as AddressInfo).port);
    }));
    await writeControlFile(stateRoot, session.sessionId, port);

    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      opencodeStateRoot: stateRoot
    });
    apps.push(app);
    const headers = authHeaders("ADMIN");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers,
      payload: {
        expectedSessionId: session.sessionId,
        modelId: "legacy/kimi-k3",
        reasoningEffort: "default",
        continueActiveTurn: true
      }
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result).toMatchObject({
      appliedScope: "MODEL_AND_REASONING",
      wasActive: false,
      interrupted: false,
      continuation: "NOT_NEEDED",
      transport: "OPENCODE",
      warning: null
    });
    expect(result.settings.current).toEqual({ modelId: "legacy/kimi-k3", reasoningEffort: "default" });
    expect(result.settings.models.map((model) => model.id)).toContain("legacy/kimi-k3");
    expect(mock.state.currentModel).toEqual({ id: "kimi-k3", providerID: "legacy", variant: "default" });
    expect(mock.state.switched).toContainEqual({ id: "kimi-k3", providerID: "legacy", variant: "default" });
    expect(mock.requests).toContain("POST /api/session/ses_mock01/model");

    const persisted = await store.getPaneCliSession(session.sessionId);
    expect(persisted?.modelId).toBe("legacy/kimi-k3");
    expect(persisted?.reasoningEffort).toBe("default");

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  it("keeps reporting the picker-applied server model across reads", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = paneCliSessionFixture(store, "sticky-server");
    const mock = startMockOpenCodeServer({
      models: [
        { id: "deepseek-v4-flash-free", providerID: "opencode", name: "DeepSeek V4 Flash Free", status: "active", enabled: true },
        { id: "kimi-k3", providerID: "legacy", name: "Kimi K3", status: "active", enabled: true }
      ],
      currentModel: { id: "kimi-k3", providerID: "legacy" },
      turnActive: false
    });
    const port = await new Promise<number>((resolve) => mock.server.listen(0, "127.0.0.2", () => {
      resolve((mock.server.address() as AddressInfo).port);
    }));
    await writeControlFile(stateRoot, session.sessionId, port);
    // Simulate a previous picker switch; the idle TUI footer may still show the old label.
    await store.updatePaneCliSession(session.sessionId, { modelId: "legacy/kimi-k3", reasoningEffort: "default" }, "trace:test");
    store.appendPaneCliTranscriptChunk({sessionId:session.sessionId,paneId:pane.id,roomId:pane.roomId,
      sequence:1,stream:'stdout',content:'  ┃ Build · DeepSeek V4 Flash Free OpenCode Zen\r\n  ╹▀▀▀'});

    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      opencodeStateRoot: stateRoot
    });
    apps.push(app);
    const headers = authHeaders("ADMIN");

    const settings = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().current).toEqual({ modelId: "legacy/kimi-k3", reasoningEffort: "default" });

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  it("aborts a running OpenCode turn through the live server abort endpoint", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = paneCliSessionFixture(store, "abort");
    const mock = startMockOpenCodeServer({
      models: [
        { id: "deepseek-v4-flash-free", providerID: "opencode", name: "DeepSeek V4 Flash Free", status: "active", enabled: true }
      ],
      currentModel: { id: "deepseek-v4-flash-free", providerID: "opencode" },
      turnActive: true
    });
    const port = await new Promise<number>((resolve) => mock.server.listen(0, "127.0.0.2", () => {
      resolve((mock.server.address() as AddressInfo).port);
    }));
    await writeControlFile(stateRoot, session.sessionId, port);

    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      opencodeStateRoot: stateRoot
    });
    apps.push(app);
    const headers = authHeaders("ADMIN");

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/turn-abort`,
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, isTurnActive: false });
    expect(mock.state.aborted).toEqual(["ses_mock01"]);
    expect(mock.requests).toContain("POST /api/session/ses_mock01/interrupt");

    const status = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings/status`,
      headers
    });
    expect(status.statusCode).toBe(200);
    expect(paneCliModelSettingsStatusSchema.parse(status.json()).settings.isTurnActive).toBe(false);

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  it("reports a conflict when the OpenCode server rejects the turn abort", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = paneCliSessionFixture(store, "abort-denied");
    const mock = startMockOpenCodeServer({
      models: [
        { id: "deepseek-v4-flash-free", providerID: "opencode", name: "DeepSeek V4 Flash Free", status: "active", enabled: true }
      ],
      currentModel: { id: "deepseek-v4-flash-free", providerID: "opencode" },
      turnActive: true,
      abortDenied: true
    });
    const port = await new Promise<number>((resolve) => mock.server.listen(0, "127.0.0.2", () => {
      resolve((mock.server.address() as AddressInfo).port);
    }));
    await writeControlFile(stateRoot, session.sessionId, port);

    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      opencodeStateRoot: stateRoot
    });
    apps.push(app);
    const headers = authHeaders("ADMIN");

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/turn-abort`,
      headers
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(mock.state.aborted).toEqual([]);

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  it("rejects an OpenCode model that is not advertised by the runtime", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = paneCliSessionFixture(store, "reject");
    const mock = startMockOpenCodeServer({
      models: [
        { id: "deepseek-v4-flash-free", providerID: "opencode", name: "DeepSeek V4 Flash Free", status: "active", enabled: true }
      ],
      currentModel: { id: "deepseek-v4-flash-free", providerID: "opencode" },
      turnActive: false
    });
    const port = await new Promise<number>((resolve) => mock.server.listen(0, "127.0.0.2", () => {
      resolve((mock.server.address() as AddressInfo).port);
    }));
    await writeControlFile(stateRoot, session.sessionId, port);

    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      opencodeStateRoot: stateRoot
    });
    apps.push(app);
    const headers = authHeaders("ADMIN");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers,
      payload: {
        expectedSessionId: session.sessionId,
        modelId: "opencode/not-advertised",
        reasoningEffort: "default",
        continueActiveTurn: true
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(mock.requests).not.toContain("POST /api/session/ses_mock01/model");
    // Reading live settings records the model OpenCode reports (09f20f4e7e);
    // the rejected target is never persisted.
    const persisted = await store.getPaneCliSession(session.sessionId);
    expect(persisted?.modelId).toBe("opencode/deepseek-v4-flash-free");

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  it.each(["server", "busy"])("rejects an unconfirmed OpenCode switch (%s)", async failure => {
    const store = new InMemorySpaceStore();
    const { pane, session } = paneCliSessionFixture(store, "denied");
    const mock = startMockOpenCodeServer({
      models: [
        { id: "deepseek-v4-flash-free", providerID: "opencode", name: "DeepSeek V4 Flash Free", status: "active", enabled: true },
        { id: "kimi-k3", providerID: "legacy", name: "Kimi K3", status: "active", enabled: true }
      ],
      currentModel: { id: "deepseek-v4-flash-free", providerID: "opencode" },
      turnActive: failure === "busy",
      denied: failure === "server"
    });
    const port = await new Promise<number>((resolve) => mock.server.listen(0, "127.0.0.2", () => {
      resolve((mock.server.address() as AddressInfo).port);
    }));
    await writeControlFile(stateRoot, session.sessionId, port);

    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      opencodeStateRoot: stateRoot
    });
    apps.push(app);
    const headers = authHeaders("ADMIN");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers,
      payload: {
        expectedSessionId: session.sessionId,
        modelId: "legacy/kimi-k3",
        reasoningEffort: "default",
        continueActiveTurn: true
      }
    });

    expect(response.statusCode).toBe(409);
    if (failure !== "server") expect(mock.state.switched).toEqual([]);
    // Reading live settings records the model OpenCode reports (09f20f4e7e);
    // the rejected target is never persisted.
    const persisted = await store.getPaneCliSession(session.sessionId);
    expect(persisted?.modelId).toBe("opencode/deepseek-v4-flash-free");

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  it("reports UNAVAILABLE when the OpenCode control file is missing", async () => {
    const store = new InMemorySpaceStore();
    const { pane } = paneCliSessionFixture(store, "missing");
    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      opencodeStateRoot: stateRoot
    });
    apps.push(app);
    const headers = authHeaders("ADMIN");

    const status = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings/status`,
      headers
    });
    expect(status.statusCode).toBe(200);
    const parsed = paneCliModelSettingsStatusSchema.parse(status.json());
    expect(parsed.status).toBe("UNAVAILABLE");
    expect(parsed.reasonCode).toBe("OPENCODE_SESSION_CONTROL_UNAVAILABLE");

    const settings = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers
    });
    expect(settings.statusCode).toBe(503);
    expect(settings.json().error.code).toBe("OPENCODE_SESSION_CONTROL_UNAVAILABLE");
  });

  it("queues a manual OpenCode title sync while preserving the local rename", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = paneCliSessionFixture(store, "rename");
    const mock = startMockOpenCodeServer({
      models: [],
      currentModel: null,
      turnActive: false,
      title: "Rename OpenCode"
    });
    const listening = new Promise<number>((resolve) => mock.server.listen(0, "127.0.0.2", () => {
      resolve((mock.server.address() as AddressInfo).port);
    }));
    const port = await listening;
    await writeControlFile(stateRoot, session.sessionId, port);

    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      opencodeStateRoot: stateRoot
    });
    apps.push(app);
    const headers = authHeaders("ADMIN");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}`,
      headers,
      payload: { title: "Synced into OpenCode" }
    });

    expect(response.statusCode).toBe(200);
    expect(store.listPanes(store.listRooms()[0].id)[0]?.title).toBe("Synced into OpenCode");
    expect(store.getPane(pane.id).taskMetadata?.nativeSyncStatus).toBe("pending");
    expect(mock.state.title).toBe("Rename OpenCode");
    expect(mock.state.titleUpdates).toEqual([]);

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  it("preserves the local manual title when native OpenCode naming is unavailable", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = paneCliSessionFixture(store, "rename-fail");
    const mock = startMockOpenCodeServer({
      models: [],
      currentModel: null,
      turnActive: false,
      title: "Original OpenCode title",
      titleDenied: true
    });
    const listening = new Promise<number>((resolve) => mock.server.listen(0, "127.0.0.2", () => {
      resolve((mock.server.address() as AddressInfo).port);
    }));
    const port = await listening;
    await writeControlFile(stateRoot, session.sessionId, port);

    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      opencodeStateRoot: stateRoot
    });
    apps.push(app);
    const headers = authHeaders("ADMIN");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}`,
      headers,
      payload: { title: "Must not persist" }
    });

    expect(response.statusCode).toBe(200);
    expect(store.listPanes(store.listRooms()[0].id)[0]?.title).toBe("Must not persist");
    expect(store.getPane(pane.id).taskMetadata?.nativeSyncStatus).toBe("pending");
    expect(mock.state.titleUpdates).toEqual([]);

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });
});
