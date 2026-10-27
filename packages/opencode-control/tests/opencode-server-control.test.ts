import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abortOpenCodeSession,
  createOpenCodeSession,
  fetchOpenCodeAgentNames,
  fetchOpenCodeSessionMessages,
  openCodeV2MessagesAsV1,
  sendOpenCodePrompt,
  fetchOpenCodeCurrentModel,
  fetchOpenCodeSessionIsTurnActive,
  fetchOpenCodeSessionModels,
  fetchOpenCodeSessionTitle,
  openCodeServerBaseUrl,
  openCodeServerIsHealthy,
  openCodeSessionExists,
  openCodeSharedServerHost,
  opencodeServerControlPath,
  parseOpenCodeCompositeModelId,
  readOpenCodeServerControl,
  readOpenCodeServerControlFromMapping,
  readOpenCodeSessionTurnActive,
  resolveOpenCodeTitleFallbackControl,
  switchOpenCodeSessionModel,
  updateOpenCodeSessionTitle,
  type OpenCodeServerControl
} from "../src/index.js";

const username = "space-opencode";
const password = "test-password";
const controlFixture: OpenCodeServerControl = {
  version: 1,
  spaceSessionId: "cli_session:opencode-test",
  nativeSessionId: "ses_abc123",
  serverPort: 0,
  serverUsername: username,
  serverPassword: password,
  updatedAt: "2026-08-03T00:00:00.000Z"
};

describe("parseOpenCodeCompositeModelId", () => {
  it("splits a composite provider/model id on the first separator", () => {
    expect(parseOpenCodeCompositeModelId("opencode/deepseek-v4-flash-free")).toEqual({
      providerId: "opencode",
      modelId: "deepseek-v4-flash-free"
    });
    expect(parseOpenCodeCompositeModelId("openrouter/accounts/foo/bar")).toEqual({
      providerId: "openrouter",
      modelId: "accounts/foo/bar"
    });
  });

  it("rejects malformed composite ids", () => {
    expect(parseOpenCodeCompositeModelId("no-separator")).toBeNull();
    expect(parseOpenCodeCompositeModelId("/empty-provider")).toBeNull();
    expect(parseOpenCodeCompositeModelId("empty-model/")).toBeNull();
    expect(parseOpenCodeCompositeModelId("")).toBeNull();
  });
});

describe("readOpenCodeServerControl", () => {
  let tempRoot: string;
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-control-"));
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    await mkdir(controlDir, { recursive: true, mode: 0o710 });
    const controlPath = join(controlDir, "cli_session_opencode-test.json");
    await writeFile(
      controlPath,
      `${JSON.stringify({ ...controlFixture, serverPort: 43210 })}\n`,
      { encoding: "utf8", mode: 0o640 }
    );
    await chmod(controlPath, 0o640);
  });
  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("reads a valid control file", async () => {
    const control = await readOpenCodeServerControl("cli_session:opencode-test", tempRoot);
    expect(control).not.toBeNull();
    expect(control?.nativeSessionId).toBe("ses_abc123");
    expect(control?.serverPort).toBe(43210);
    expect(control?.serverUsername).toBe(username);
    expect(control?.serverPassword).toBe(password);
  });

  it("returns null when the control file is missing", async () => {
    expect(await readOpenCodeServerControl("cli_session:missing", tempRoot)).toBeNull();
  });

  it("returns null for a control file with a mismatched space session id", async () => {
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    const badPath = join(controlDir, "cli_session_wrong.json");
    await writeFile(badPath, JSON.stringify({ ...controlFixture, spaceSessionId: "cli_session:other", serverPort: 43211 }), {
      encoding: "utf8",
      mode: 0o640
    });
    expect(await readOpenCodeServerControl("cli_session:opencode-test", tempRoot)).not.toBeNull();
    expect(await readOpenCodeServerControl("cli_session:wrong", tempRoot)).toBeNull();
    await rm(badPath, { force: true });
  });

  it("returns null for malformed control payloads", async () => {
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    const badPath = join(controlDir, "cli_session_malformed.json");
    await writeFile(badPath, "{not-json", { encoding: "utf8", mode: 0o640 });
    expect(await readOpenCodeServerControl("cli_session:malformed", tempRoot)).toBeNull();
    await rm(badPath, { force: true });
  });

  it("reads a control file with an explicit serverHost", async () => {
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    const hostPath = join(controlDir, "cli_session_hosted.json");
    await writeFile(
      hostPath,
      `${JSON.stringify({ ...controlFixture, spaceSessionId: "cli_session:hosted", serverHost: "10.254.240.13", serverPort: 43212 })}\n`,
      { encoding: "utf8", mode: 0o640 }
    );
    const control = await readOpenCodeServerControl("cli_session:hosted", tempRoot);
    expect(control?.serverHost).toBe("10.254.240.13");
    await rm(hostPath, { force: true });
  });

  it("substitutes loopback server hosts with the opencode shared bridge address", async () => {
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    for (const [spaceSessionId, loopbackHost] of [
      ["cli_session:loopback4", "127.0.0.1"],
      ["cli_session:loopbackname", "localhost"]
    ] as const) {
      const path = join(controlDir, `${spaceSessionId.replace(/:/g, "_")}.json`);
      await writeFile(
        path,
        `${JSON.stringify({ ...controlFixture, spaceSessionId, serverHost: loopbackHost, serverPort: 43213 })}\n`,
        { encoding: "utf8", mode: 0o640 }
      );
      const control = await readOpenCodeServerControl(spaceSessionId, tempRoot);
      expect(control?.serverHost).toBe(openCodeSharedServerHost);
      await rm(path, { force: true });
    }
  });

  it("keeps a loopback host recorded by a launcher that runs in the host network", async () => {
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    const path = join(controlDir, "cli_session_hostnet.json");
    await writeFile(
      path,
      `${JSON.stringify({ ...controlFixture, spaceSessionId: "cli_session:hostnet", serverHost: "127.0.0.1", serverNetwork: "host", serverPort: 43214 })}\n`,
      { encoding: "utf8", mode: 0o640 }
    );
    const control = await readOpenCodeServerControl("cli_session:hostnet", tempRoot);
    expect(control?.serverHost).toBe("127.0.0.1");
    await rm(path, { force: true });
  });
});

describe("readOpenCodeServerControlFromMapping", () => {
  it("resolves control from persistent mapping file and shared env", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-mapping-"));
    try {
      const mappingDir = join(tempRoot, "opencode", "space-cli-sessions");
      const opencodeDir = join(tempRoot, "opencode");
      await mkdir(mappingDir, { recursive: true, mode: 0o710 });
      const envPath = join(opencodeDir, "space-shared-server.env");
      await writeFile(envPath, `OPENCODE_SERVER_USERNAME=shared-user\nOPENCODE_SERVER_PASSWORD=shared-pass\n`, {
        encoding: "utf8",
        mode: 0o640
      });
      const mappingPath = join(mappingDir, "cli_session_test.json");
      await writeFile(
        mappingPath,
        JSON.stringify({
          version: 1,
          spaceSessionId: "cli_session:test",
          nativeSessionId: "ses_persisted123",
          updatedAt: "2026-10-06T08:00:00.000Z"
        }),
        { encoding: "utf8", mode: 0o640 }
      );

      const control = await readOpenCodeServerControlFromMapping("cli_session:test", tempRoot);
      expect(control).not.toBeNull();
      expect(control?.nativeSessionId).toBe("ses_persisted123");
      expect(control?.spaceSessionId).toBe("cli_session:test");
      expect(control?.serverUsername).toBe("shared-user");
      expect(control?.serverPassword).toBe("shared-pass");
      expect(control?.serverPort).toBe(47047);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns null when mapping file does not exist", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-mapping-"));
    try {
      expect(await readOpenCodeServerControlFromMapping("cli_session:nonexistent", tempRoot)).toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveOpenCodeTitleFallbackControl", () => {
  it("returns the most recent live control when one exists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-fallback-"));
    try {
      const controlDir = join(tempRoot, "opencode", "space-cli-control");
      await mkdir(controlDir, { recursive: true, mode: 0o710 });
      const controlPath = join(controlDir, "cli_session_live.json");
      await writeFile(
        controlPath,
        `${JSON.stringify({ ...controlFixture, spaceSessionId: "cli_session:live", serverHost: "127.0.0.1", serverPort: 47047 })}\n`,
        { encoding: "utf8", mode: 0o640 }
      );
      const control = await resolveOpenCodeTitleFallbackControl(tempRoot);
      expect(control).not.toBeNull();
      expect(control?.spaceSessionId).toBe("cli_session:live");
      expect(control?.serverHost).toBe(openCodeSharedServerHost);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("builds a control from the shared server env file when no live control exists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-fallback-env-"));
    try {
      const opencodeDir = join(tempRoot, "opencode");
      await mkdir(opencodeDir, { recursive: true, mode: 0o750 });
      const envPath = join(opencodeDir, "space-shared-server.env");
      await writeFile(
        envPath,
        `SPACE_OPENCODE_SHARED=1\nOPENCODE_SERVER_USERNAME=shared-user\nOPENCODE_SERVER_PASSWORD=shared-pass\n`,
        { encoding: "utf8", mode: 0o640 }
      );
      const control = await resolveOpenCodeTitleFallbackControl(tempRoot);
      expect(control).not.toBeNull();
      expect(control?.spaceSessionId).toBe("space-shared");
      expect(control?.nativeSessionId).toBe("");
      expect(control?.serverPort).toBe(47047);
      expect(control?.serverHost).toBe(openCodeSharedServerHost);
      expect(control?.serverUsername).toBe("shared-user");
      expect(control?.serverPassword).toBe("shared-pass");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns null when there is no control and no shared env file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-fallback-empty-"));
    try {
      expect(await resolveOpenCodeTitleFallbackControl(tempRoot)).toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

const zeroTokenUnknown = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_empty_first",
  sessionID: "ses_abc123",
  parentID: "msg_user_turn",
  role: "assistant",
  finish: "unknown",
  time: { created: 1786000000000, completed: 1786000000100 },
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 }
  },
  ...overrides
});

const messageUpdated = (info: Record<string, unknown>) => ({
  type: "message.updated",
  properties: { info }
});

describe("an OpenCode server that answers with its web UI", () => {
  let server: ReturnType<typeof createServer>;
  const control: OpenCodeServerControl = { ...controlFixture, nativeSessionId: "ses_v2" };

  beforeAll(async () => {
    server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><title>OpenCode</title></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    control.serverPort = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reports an unknown turn state, which guards treat as busy", async () => {
    expect(await readOpenCodeSessionTurnActive(control, "ses_v2")).toBeNull();
    expect(await fetchOpenCodeSessionIsTurnActive(control, "ses_v2")).toBe(false);
  });
});

describe("opencode-control against an OpenCode 2 server", () => {
  // Shapes recorded from OpenCode 2.0.31 (2026-10-16): /api routes, HTTP Basic with the fixed user name "opencode".
  let server: ReturnType<typeof createServer>;
  let busy = false;
  // A directory's MCP servers as 2.0.32 lists them on its first calls: none yet, then pending, then connected.
  const mcpListings: unknown[][] = [[], [{ name: "space_dispatcher", status: { status: "pending" } }], [{ name: "space_dispatcher", status: { status: "connected" } }]];
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const control: OpenCodeServerControl = { ...controlFixture, nativeSessionId: "ses_v2turn", serverUsername: "space-opencode", directory: "/work" };
  const messages = [
    { id: "msg_3", time: { created: 3 }, type: "idle", outcome: "succeeded" },
    { id: "msg_2", time: { created: 2, completed: 2.5 }, type: "assistant", agent: "build", model: { id: "big-pickle", providerID: "opencode", variant: "default" },
      content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "TOKEN" }], finish: "stop", cost: 0,
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } } },
    { id: "msg_1", time: { created: 1 }, type: "user", text: "read token.txt", files: [{ uri: "file:///tmp/shot.png" }] }
  ];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        calls.push({ method: request.method ?? "GET", path: `${url.pathname}${url.search}`, body: raw ? JSON.parse(raw) : undefined });
        const json = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
        if (request.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) return json(401, { _tag: "UnauthorizedError" });
        const route = `${request.method} ${url.pathname}`;
        if (route === "GET /api/info") return json(200, { version: "2.0.31", pid: 1 });
        if (route === "GET /api/session/active") return json(200, { data: busy ? { ses_v2turn: { type: "running" } } : {} });
        if (route === "POST /api/session") return json(200, { data: { id: "ses_v2new", title: "t" } });
        if (route === "GET /api/mcp") return json(200, { location: { directory: "/work" }, data: mcpListings.length > 1 ? mcpListings.shift() : mcpListings[0] });
        if (route === "GET /api/session/ses_v2turn") return json(200, { data: { id: "ses_v2turn", title: "Native title", time: { updated: 7 }, model: { id: "big-pickle", providerID: "opencode", variant: "default" } } });
        if (route === "PATCH /api/session/ses_v2turn") return json(200, { data: { id: "ses_v2turn" } });
        if (route === "GET /api/session/ses_v2turn/message") return json(200, { data: messages, cursor: {} });
        if (route === "POST /api/session/ses_v2turn/prompt") return json(200, { data: { id: "msg_9", type: "user" } });
        if (route === "POST /api/session/ses_v2turn/interrupt") return json(200, { interrupted: true });
        if (route === "POST /api/session/ses_v2turn/model") { response.writeHead(204); return response.end(); }
        if (route === "POST /api/session/ses_unknown/model") return json(404, { _tag: "NotFoundError" });
        if (route === "GET /api/model") return json(200, { data: [{ id: "big-pickle", providerID: "opencode", name: "Big Pickle", status: "active", enabled: true, variants: [] },
          { id: "deepseek-v4.1-flash-free", providerID: "opencode", name: "DeepSeek", status: "active", enabled: true, variants: [{ id: "low" }, { id: "max" }] }] });
        if (route === "GET /api/agent") return json(200, { data: [{ id: "build", name: "Build", mode: "primary", hidden: false },
          { id: "plan", name: "Plan", mode: "primary", hidden: false }, { id: "explore", name: "Explore", mode: "subagent", hidden: false }] });
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html>");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    control.serverPort = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("builds the base URL and the control path", () => {
    expect(openCodeServerBaseUrl(4096, "10.0.0.5")).toBe("http://10.0.0.5:4096");
    expect(opencodeServerControlPath("cli_session:a/b", "/root/state")).toBe("/root/state/opencode/space-cli-control/cli_session_a_b.json");
  });

  it("passes the reasoning effort as the model variant only when it is advertised (default round-trips)", async () => {
    const lastBody = () => calls.filter((call) => call.path === "/api/session/ses_v2turn/model").at(-1)?.body as { model?: Record<string, string> };
    await switchOpenCodeSessionModel(control, "ses_v2turn", "legacy", "kimi-k3", "high", ["low", "medium", "high"]);
    expect(lastBody().model).toEqual({ id: "kimi-k3", providerID: "legacy", variant: "high" });
    await switchOpenCodeSessionModel(control, "ses_v2turn", "legacy", "kimi-k3", "default", ["low", "medium", "high"]);
    expect(lastBody().model).toEqual({ id: "kimi-k3", providerID: "legacy", variant: "default" });
    for (const [variant, advertised] of [["max", ["low", "medium", "high"]], ["high", undefined], [null, ["high"]]] as const) {
      await switchOpenCodeSessionModel(control, "ses_v2turn", "opencode", "big-pickle", variant, advertised);
      expect(lastBody().model).toEqual({ id: "big-pickle", providerID: "opencode" });
    }
    await expect(switchOpenCodeSessionModel(control, "ses_unknown", "opencode", "kimi-k3")).rejects.toThrow(/HTTP 404/);
  });

  it("detects OpenCode 2 and uses its routes with the fixed user name", async () => {
    expect(await openCodeServerIsHealthy(control)).toBe(true);
    expect(await openCodeSessionExists(control, "ses_v2turn")).toBe(true);
    expect(await createOpenCodeSession(control, "Space chat", "/work")).toBe("ses_v2new");
    expect(calls.find((call) => call.method === "POST" && call.path === "/api/session")?.body).toEqual({ title: "Space chat", location: { directory: "/work" } });
    // The new session's MCP servers are connected before it is handed out, so its first prompt has their tools.
    expect(calls.filter((call) => call.path === "/api/mcp?location%5Bdirectory%5D=%2Fwork")).toHaveLength(3);
    expect(await fetchOpenCodeCurrentModel(control, "ses_v2turn")).toEqual({ id: "big-pickle", providerID: "opencode", variant: "default" });
    expect(await fetchOpenCodeSessionTitle(control, "ses_v2turn")).toEqual({ title: "Native title", updatedAt: 7 });
    await updateOpenCodeSessionTitle(control, "ses_v2turn", "Renamed");
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ title: "Renamed" });
  });

  it("reads models, agents, the running state and interrupts", async () => {
    const models = await fetchOpenCodeSessionModels(control, "/work");
    expect(models.map((model) => [model.modelId, model.variants])).toEqual([["big-pickle", []], ["deepseek-v4.1-flash-free", ["low", "max"]]]);
    expect(calls.find((call) => call.path.startsWith("/api/model"))?.path).toBe("/api/model?location%5Bdirectory%5D=%2Fwork");
    expect(await fetchOpenCodeAgentNames(control, "/work")).toEqual(["build", "plan"]);
    expect(await readOpenCodeSessionTurnActive(control, "ses_v2turn")).toBe(false);
    busy = true;
    expect(await readOpenCodeSessionTurnActive(control, "ses_v2turn")).toBe(true);
    busy = false;
    expect(await abortOpenCodeSession(control, "ses_v2turn")).toBe(true);
    await switchOpenCodeSessionModel(control, "ses_v2turn", "opencode", "deepseek-v4.1-flash-free", "low", ["low", "max"]);
    expect(calls.findLast((call) => call.path === "/api/session/ses_v2turn/model")?.body).toEqual({ model: { id: "deepseek-v4.1-flash-free", providerID: "opencode", variant: "low" } });
  });

  it("returns messages oldest first in the v1 shape and queues prompts", async () => {
    const history = await fetchOpenCodeSessionMessages(control, "ses_v2turn", 30) as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
    expect(history.map((message) => message.info.role)).toEqual(["user", "assistant"]);
    expect(history[0].parts).toEqual([{ type: "text", text: "read token.txt" }, { type: "file", url: "file:///tmp/shot.png" }]);
    expect(history[1].info).toMatchObject({ parentID: "msg_1", modelID: "big-pickle", providerID: "opencode", finish: "stop", tokens: { input: 10 } });
    expect(history[1].parts.at(-1)).toEqual({ type: "text", text: "TOKEN" });
    expect(calls.findLast((call) => call.path.includes("/message"))?.path).toBe("/api/session/ses_v2turn/message?limit=30&order=desc");
    expect(await sendOpenCodePrompt(control, "ses_v2turn", "hello")).toBe(true);
    expect(calls.findLast((call) => call.path === "/api/session/ses_v2turn/prompt")?.body).toEqual({ text: "hello" });
  });

  it("maps an interrupted answer to the v1 abort error", () => {
    const [, answer] = openCodeV2MessagesAsV1([{ id: "u", type: "user", text: "x", time: { created: 1 } },
      { id: "a", type: "assistant", time: { created: 2 }, finish: "error", error: { type: "aborted", message: "Step interrupted" }, content: [] }]);
    expect(answer.info.error).toEqual({ name: "MessageAbortedError", data: { message: "Step interrupted" } });
  });
});
