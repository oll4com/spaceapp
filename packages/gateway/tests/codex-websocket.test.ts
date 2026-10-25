import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { registerCodexProxyRoutes } from "../src/providers/codex/codex-proxy.js";
import { CodexWebSocketRegistry } from "../src/providers/codex/codex-websocket.js";
import { UpstreamWebSocketHealth } from "../src/providers/codex/upstream-websocket.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 9));
const accountA = `gw_account:${"a".repeat(32)}`;
const accountB = `gw_account:${"b".repeat(32)}`;
type Json = Record<string, unknown>;

const events = {
  created: (id: string) => ({ type: "response.created", response: { id, model: "gpt-5.6-sol", status: "in_progress" } }),
  delta: (text: string) => ({ type: "response.output_text.delta", delta: text }),
  completed: (id: string) => ({ type: "response.completed", response: { id, model: "gpt-5.6-sol", status: "completed", output: [],
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 7 } } })
};

interface UpstreamConnection { accountId: string | null; headers: IncomingMessage["headers"]; frames: Json[]; socket: WebSocket }
type Script = (connection: UpstreamConnection, frame: Json) => void;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(script: Script, options: { handshake?: (request: IncomingMessage) => number | null; timing?: { idleMs: number; keepaliveMs: number; upstreamIdleMs: number } } = {}) {
  // A stand-in for chatgpt.com's Responses WebSocket.
  const connections: UpstreamConnection[] = [];
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: (info, done) => {
    const status = options.handshake?.(info.req) ?? null;
    if (status) done(false, status, "refused", { "content-type": "application/json" });
    else done(true);
  } });
  upstream.on("headers", (headers) => headers.push("x-codex-turn-state: upstream-turn-1", "x-codex-primary-used-percent: 33"));
  upstream.on("connection", (socket, request) => {
    const connection: UpstreamConnection = { accountId: (request.headers["chatgpt-account-id"] as string | undefined) ?? null, headers: request.headers, frames: [], socket };
    connections.push(connection);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Json;
      connection.frames.push(frame);
      script(connection, frame);
    });
  });
  await new Promise<void>((resolve) => upstream.once("listening", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => { for (const client of upstream.clients) client.terminate(); upstream.close(() => resolve()); }));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const repository = new InMemoryGatewayRepository();
  for (const [accountId, external, used] of [[accountA, "chatgpt-a", 10], [accountB, "chatgpt-b", 50]] as const) {
    const credentials: StoredCredentials = { accessToken: `token-${external}`, refreshToken: "rt", idToken: null, upstreamAccountId: external, accessExpiresAtMs: null };
    await repository.upsertAccount({ accountId, provider: "CODEX", label: external, email: null, externalAccountId: external, planType: "plus",
      credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), accountId), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null,
      lastRefreshAt: new Date().toISOString() });
    await repository.saveUsageWindows(accountId, [{ window: "PRIMARY", usedPercent: used, resetAt: null, windowMinutes: 300 }]);
  }
  await repository.updateSettings({ planPriority: [], routingStrategy: "USAGE_WEIGHTED" });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"c".repeat(32)}`, name: "CLI", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [], expiresAt: null, createdBy: null });
  const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const registry = new CodexWebSocketRegistry(options.timing);
  let clock = Date.now();
  const health = new UpstreamWebSocketHealth(() => clock);
  const httpCalls: Json[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    httpCalls.push(JSON.parse(String(init.body)) as Json);
    const body = [events.created("resp_http"), events.delta("over http"), events.completed("resp_http")]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true,
    live: { inFlightByAccount: () => pool.inFlight(), activeWebSockets: () => registry.active(), relayTasks: () => registry.relays() },
    routes: (app, helpers) => registerCodexProxyRoutes(app, helpers, { pool, logs, settings: () => repository.getSettings(), fetchImpl,
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/backend-api`, webSockets: registry, upstreamWebSocketHealth: health }) });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.app.close());
  const port = (server.app.server.address() as AddressInfo).port;

  /** A client socket with every frame it receives; `next(type)` waits for the next frame of a type. */
  const connect = async (path = "/backend-api/codex/responses", headers: Record<string, string> = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${plainKey}`, originator: "codex_cli_rs", ...headers } });
    const received: Json[] = [];
    const waiters: Array<{ type: string; resolve: (frame: Json) => void; from: number }> = [];
    let acceptHeaders: IncomingMessage["headers"] = {};
    socket.on("upgrade", (response) => { acceptHeaders = response.headers; });
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Json;
      received.push(frame);
      for (const waiter of [...waiters]) if (frame.type === waiter.type) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame); }
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    cleanups.push(() => socket.terminate());
    const next = (type: string) => new Promise<Json>((resolve) => waiters.push({ type, resolve, from: received.length }));
    const create = (body: Json) => socket.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-sol", input: "hi", stream: true, ...body }));
    return { socket, received, next, create, closed, acceptHeaders: () => acceptHeaders };
  };
  const handshake = (path = "/backend-api/codex/responses", headers: Record<string, string> = { authorization: `Bearer ${plainKey}` }) =>
    new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      socket.on("unexpected-response", (_request, response) => { resolve(response.statusCode ?? 0); socket.terminate(); });
      socket.on("open", () => { resolve(101); socket.terminate(); });
      socket.on("error", () => undefined);
    });
  return { repository, logs, registry, health, connections, connect, handshake, httpCalls, fetchImpl, server, port, plainKey,
    advance: (ms: number) => { clock += ms; } };
}

const reply = (connection: UpstreamConnection, ...frames: Json[]) => { for (const frame of frames) connection.socket.send(JSON.stringify(frame)); };

describe("Codex over a client WebSocket", () => {
  it("relays a response from the least-used account and keeps one upstream socket for later turns", async () => {
    let turn = 0;
    const gateway = await setup((connection) => { turn += 1; reply(connection, events.created(`resp_${turn}`), events.delta("Hello"), events.completed(`resp_${turn}`)); });
    const client = await gateway.connect("/backend-api/codex/responses", { session_id: "thread-1" });
    expect(client.acceptHeaders()["x-codex-turn-state"]).toMatch(/^turn_[0-9a-f]{32}$/);
    const done = client.next("response.completed");
    client.create({});
    expect((await done).response).toMatchObject({ id: "resp_1" });
    expect(client.received.map((frame) => frame.type)).toEqual(["response.created", "response.output_text.delta", "response.completed"]);
    const [upstream] = gateway.connections;
    expect(upstream!.accountId).toBe("chatgpt-a");
    expect(upstream!.headers).toMatchObject({ authorization: "Bearer token-chatgpt-a", "openai-beta": "responses_websockets=2026-02-06", session_id: "thread-1",
      originator: "codex_cli_rs" });
    expect(upstream!.frames[0]).toMatchObject({ type: "response.create", model: "gpt-5.6-sol", store: false });
    expect(upstream!.frames[0]).not.toHaveProperty("stream");

    const second = client.next("response.completed");
    client.create({ previous_response_id: "resp_1", input: "again" });
    expect((await second).response).toMatchObject({ id: "resp_2" });
    expect(gateway.connections).toHaveLength(1);
    expect(upstream!.frames[1]).toMatchObject({ previous_response_id: "resp_1" });
    expect(gateway.registry.active()).toBe(1);
    expect(gateway.registry.relays()).toBe(1);
    await gateway.logs.flush();
    const logs = await gateway.repository.listRequestLogs({ limit: 5 });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ status: "success", transport: "websocket", upstreamTransport: "websocket", accountId: accountA, inputTokens: 100, outputTokens: 7 });
    expect(logs.find((log) => log.stickyKind === "CONTINUATION")).toBeTruthy();
  });

  it("moves a rate-limited request to another account before the client sees anything", async () => {
    const gateway = await setup((connection) => {
      if (connection.accountId === "chatgpt-a") reply(connection, events.created("resp_a"), { type: "error", status: 429, error: { code: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 600 } });
      else reply(connection, events.created("resp_b"), events.delta("from b"), events.completed("resp_b"));
    });
    const client = await gateway.connect();
    const done = client.next("response.completed");
    client.create({});
    expect((await done).response).toMatchObject({ id: "resp_b" });
    expect(client.received.some((frame) => frame.type === "error" || JSON.stringify(frame).includes("resp_a"))).toBe(false);
    expect(gateway.connections.map((connection) => connection.accountId)).toEqual(["chatgpt-a", "chatgpt-b"]);
  });

  it("masks a missing previous response and reports an upstream close mid-stream as response.failed", async () => {
    const gateway = await setup((connection, frame) => {
      if (frame.previous_response_id) reply(connection, { type: "error", status: 400, error: { code: "previous_response_not_found", message: "Previous response with id 'resp_secret' not found.", param: "previous_response_id" } });
      else { reply(connection, events.created("resp_1"), events.delta("partial")); setTimeout(() => connection.socket.close(1011), 20); }
    });
    const client = await gateway.connect();
    const failed = client.next("response.failed");
    client.create({});
    expect((await failed).response).toMatchObject({ status: "failed", error: { code: "stream_incomplete", message: "Upstream websocket closed before response.completed (close_code=1011)" } });
    const error = client.next("error");
    client.create({ previous_response_id: "resp_secret" });
    const masked = await error;
    expect(masked.error).toEqual({ code: "previous_response_not_found", message: "Previous response was not found; retry without previous_response_id." });
    expect(JSON.stringify(client.received)).not.toContain("resp_secret");
  });

  it("refuses the upgrade without a key, and with 426 while WebSocket is off or cooling down", async () => {
    let refuse = false;
    const gateway = await setup((connection) => reply(connection, events.created("r"), events.completed("r")), { handshake: () => (refuse ? 503 : null) });
    expect(await gateway.handshake("/backend-api/codex/responses", {})).toBe(401);
    expect(await gateway.handshake()).toBe(101);
    await gateway.repository.updateSettings({ upstreamStreamTransport: "HTTP" });
    expect(await gateway.handshake()).toBe(426);
    await gateway.repository.updateSettings({ upstreamStreamTransport: "DEFAULT" });
    // An upstream open that fails at the transport turns WebSocket off for 60 s; the session is closed so the client reconnects over HTTP.
    refuse = true;
    const client = await gateway.connect();
    const error = client.next("error");
    client.create({});
    expect((await error).error).toMatchObject({ code: "upstream_unavailable" });
    expect((await client.closed).code).toBe(1011);
    expect(gateway.health.coolingDown()).toBe(true);
    expect(await gateway.handshake()).toBe(426);
    gateway.advance(60_001);
    expect(await gateway.handshake()).toBe(101);
  });

  it("records codex.rate_limits as account usage and keeps codex events away from /v1 clients", async () => {
    const gateway = await setup((connection) => reply(connection, events.created("r1"),
      { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 71, window_minutes: 300, reset_at: Math.floor(Date.now() / 1000) + 600 } } },
      events.delta("x"), events.completed("r1")));
    const client = await gateway.connect("/v1/responses");
    const done = client.next("response.completed");
    client.create({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] });
    await done;
    expect(client.received.some((frame) => String(frame.type).startsWith("codex."))).toBe(false);
    await vi.waitFor(async () => {
      const account = (await gateway.repository.listAccounts()).find((candidate) => candidate.id === accountA);
      expect(account?.primaryWindow.usedPercent).toBe(71);
    });
  });

  it("closes an idle socket (1001) and drains idle sockets (1012)", async () => {
    const gateway = await setup((connection) => reply(connection, events.created("r"), events.completed("r")), { timing: { idleMs: 150, keepaliveMs: 10_000, upstreamIdleMs: 600_000 } });
    const idle = await gateway.connect();
    expect(await idle.closed).toEqual({ code: 1001, reason: "Idle downstream websocket timeout" });
    const open = await gateway.connect();
    const drained = gateway.registry.drain();
    expect((await open.closed).code).toBe(1012);
    await drained;
    expect(gateway.registry.active()).toBe(0);
  });
});

describe("Codex HTTP requests over an upstream WebSocket", () => {
  it("promotes an HTTP request when the transport is WebSocket, and falls back to HTTP for 60 s after a failed open", async () => {
    let refuse = false;
    const gateway = await setup((connection) => reply(connection, events.created("resp_ws"), events.delta("over ws"), events.completed("resp_ws")),
      { handshake: () => (refuse ? 502 : null) });
    await gateway.repository.updateSettings({ upstreamStreamTransport: "WEBSOCKET" });
    const post = () => gateway.server.app.inject({ method: "POST", url: "/backend-api/codex/responses", headers: { authorization: `Bearer ${gateway.plainKey}` },
      payload: { model: "gpt-5.6-sol", stream: true, input: "hi" } });
    const promoted = await post();
    expect(promoted.statusCode).toBe(200);
    expect(promoted.body).toContain("event: response.completed");
    expect(promoted.body).toContain("resp_ws");
    expect(gateway.httpCalls).toHaveLength(0);
    expect(gateway.connections[0]!.frames[0]).toMatchObject({ type: "response.create", input: [{ role: "user" }] });

    refuse = true;
    const fallback = await post();
    expect(fallback.body).toContain("resp_http");
    expect(gateway.httpCalls).toHaveLength(1);
    const connectionsBefore = gateway.connections.length;
    const pinned = await post();
    expect(pinned.body).toContain("resp_http");
    // While cooling down, no WebSocket open is even tried.
    expect(gateway.connections.length).toBe(connectionsBefore);
    await gateway.logs.flush();
    const logs = await gateway.repository.listRequestLogs({ limit: 5 });
    expect(logs.map((log) => log.upstreamTransport).sort()).toEqual(["http", "http", "websocket"]);
  });
});

describe("Codex WebSocket compression wiring", () => {
  it("applies Codex's output policy to WebSocket turns of Codex CLI and keeps the off header", async () => {
    let turn = 0;
    const gateway = await setup((connection) => { turn += 1; reply(connection, events.created(`resp_${turn}`), events.completed(`resp_${turn}`)); });
    await gateway.repository.updateSettings({ compressionProviders: { CODEX: { outputPolicy: "LEAN" } } });
    const client = await gateway.connect("/backend-api/codex/responses", { "user-agent": "codex_cli_rs/0.162.1" });
    const done = client.next("response.completed");
    client.create({ instructions: "Base." });
    await done;
    expect(String(gateway.connections[0]!.frames[0]!.instructions)).toMatch(/^Base\.\n\n\[Space Gateway output policy v1: lean\]\n\nYou are a lazy senior developer\./);
    const opted = await gateway.connect("/backend-api/codex/responses", { "user-agent": "codex_cli_rs/0.162.1", "x-space-gateway-output-policy": "off" });
    const second = opted.next("response.completed");
    opted.create({ instructions: "Base." });
    await second;
    expect(gateway.connections.at(-1)!.frames.at(-1)!.instructions).toBe("Base.");
  });
});
