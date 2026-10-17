import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { createVoiceRealtimeCall } from "../src/voice-transcription.js";

vi.mock("../src/voice-transcription.js", async (original) => ({ ...await original<typeof import("../src/voice-transcription.js")>(), createVoiceRealtimeCall: vi.fn() }));
const secret = "voice-proxy-unit-test-session-secret";
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const servers: WebSocketServer[] = [];
const clients: WebSocket[] = [];
function headers(id = "user:owner:a") {
  const session = signSession({ id, role: "ADMIN", email: "voice@space.test" }, secret);
  return { host: "space.test", origin: "http://space.test", cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, secret)! };
}
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); })));
  vi.clearAllMocks();
});
async function fixture() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); servers.push(server);
  await once(server, "listening");
  const address = server.address() as { port: number };
  vi.mocked(createVoiceRealtimeCall).mockImplementation(async () => ({ provider: "google", protocol: "google-live", model: "test", token: "private-token", websocketUrl: `ws://127.0.0.1:${address.port}` }));
  const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_LOG_LEVEL: "silent" }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } }); apps.push(app);
  return { app, server };
}
describe("voice proxy authenticated routes", () => {
  it("rejects unauthenticated, missing-CSRF and cross-origin creation before minting credentials", async () => {
    const { app } = await fixture();
    const valid = headers(); const { "x-space-csrf-token": omitted, ...withoutCsrf } = valid;
    for (const requestHeaders of [undefined, withoutCsrf, { ...valid, origin: "https://foreign.test" }]) {
      const result = await app.inject({ method: "POST", url: "/api/voice/realtime/calls", headers: requestHeaders, payload: { provider: "google", model: "test" } });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(createVoiceRealtimeCall).not.toHaveBeenCalled();
  });
  it("accepts the configured public origin when the API sees an internal proxy hop", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); servers.push(server);
    await once(server, "listening");
    const upstreamAddress = server.address() as { port: number };
    vi.mocked(createVoiceRealtimeCall).mockResolvedValue({ provider: "google", protocol: "google-live", model: "test", websocketUrl: `ws://127.0.0.1:${upstreamAddress.port}` });
    const app = await createApp({
      store: new InMemorySpaceStore(),
      config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: "http://127.0.0.1:4911" }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false }
    }); apps.push(app);
    const session = signSession({ id: "user:owner:a", role: "ADMIN", email: "voice@space.test" }, secret);
    const csrf = createCsrfToken(session, secret)!;
    const response = await app.inject({
      method: "POST", url: "/api/voice/realtime/calls",
      headers: { host: "127.0.0.1:4910", origin: "http://127.0.0.1:4911", cookie: `space_session=${session}`, "x-space-csrf-token": csrf },
      payload: { provider: "google", model: "test" }
    });
    expect(response.statusCode).toBe(200);
    expect(createVoiceRealtimeCall).toHaveBeenCalledTimes(1);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace(/^http/, "ws")}${response.json().websocketUrl}`, {
      headers: { host: "127.0.0.1:4910", origin: "http://127.0.0.1:4911", cookie: `space_session=${session}` }
    });
    clients.push(socket);
    await once(socket, "open");
    socket.close();
  });
  it("binds relay tickets to owner and origin, hides credentials and permits exactly one connection", async () => {
    const { app, server } = await fixture();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await app.inject({ method: "POST", url: "/api/voice/realtime/calls", headers: headers(), payload: { provider: "google", model: "test" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("token");
    const path = response.json().websocketUrl;
    const connected = vi.fn(); server.on("connection", connected);
    const connect = (requestHeaders: ReturnType<typeof headers>) => {
      const socket = new WebSocket(`${address.replace(/^http/, "ws")}${path}`, { headers: requestHeaders });
      clients.push(socket); return socket;
    };
    const reject = async (requestHeaders: ReturnType<typeof headers>) => {
      const socket = connect(requestHeaders);
      const [code] = await once(socket, "close") as [number]; expect(code).toBe(4404);
    };
    await reject(headers("user:owner:b"));
    // Another site's handshake is refused before the upgrade by the same-site Origin check (2026-10-16).
    const foreign = connect({ ...headers(), origin: "https://foreign.test" });
    foreign.on("error", () => {});
    const [, refused] = await once(foreign, "unexpected-response") as [unknown, { statusCode: number }];
    expect(refused.statusCode).toBe(403);
    expect(connected).not.toHaveBeenCalled();
    const connection = once(server, "connection");
    const socket = connect(headers()); await once(socket, "open");
    const [upstream] = await connection as [WebSocket];
    const received = once(upstream, "message");
    const payload = JSON.stringify({ type: "session.instructions.append", content: "Full context ".repeat(1000) });
    socket.send(payload);
    const [message] = await received as [Buffer]; expect(message.toString()).toBe(payload);
    await reject(headers());
    expect(connected).toHaveBeenCalledTimes(1);
    const upstreamClosed = once(upstream, "close"); socket.close(); await upstreamClosed;
  });
});
