import { tmpdir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it } from "vitest";
import { createCsrfToken, defaultSessionRevocationStore, signSessionWithTtl } from "../src/auth.js";

const secret = "synthetic-stage04-session-secret-only";
const base = "/api/t3code/panes/pane:owned123/app/";
const token = (id = "user:operator") => signSessionWithTtl({ id, role: "ADMIN", email: `${randomUUID()}@space.test` }, secret, 600);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(extra: Record<string, unknown> = {}) {
  const module = await import("../src/t3code/gateway.js").catch(() => ({} as Record<string, any>));
  expect(typeof module.registerT3Gateway, "Authenticated T3 transport is missing").toBe("function");
  const dir = await mkdtemp(join(tmpdir(), "t3-gateway-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const requests: { url: string; headers: object; body: Buffer }[] = [];
  let releaseStream = () => {};
  let streamClosed = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks); requests.push({ url: req.url!, headers: req.headers, body });
    if (req.url === "/api/orchestration/shell?hang=1") return;
    if (req.url === "/api/orchestration/shell?fail=1") { res.destroy(); return; }
    if (req.url === "/api/orchestration/shell?stream=1") { res.once("close", () => { streamClosed = true; }); res.write("first"); releaseStream = () => res.end("last"); return; }
    if (req.url === "/api/assets/private-token/file.html") { res.setHeader("content-type", "text/html"); res.end('<script>parent.location="/danger"</script>'); return; }
    if (req.url === "/welcome") { res.writeHead(302, { location: "/settings/providers", "set-cookie": "upstream-secret=hidden", "x-private": "hidden" }); res.end(); return; }
    if (req.url === "/settings/providers" || req.url === "/") { res.setHeader("content-type", "text/html"); res.end('<html><head></head><body><script src="./assets/main.js"></script></body></html>'); return; }
    if (req.url === "/api/auth/session") { res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify({ authenticated: true, note: "</script><script>alert(1)</script>\u2028" })); return; }
    if (req.url === "/.well-known/t3/environment") { res.setHeader("content-type", "text/plain"); res.end("not json"); return; }
    res.setHeader("content-type", "application/octet-stream"); res.end(body.length ? body : Buffer.from([0, 255, 128, 13, 10]));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    ws.on("message", (data, binary) => {
      const msg = JSON.parse(data.toString());
      if (msg.tag === "assets.createUrl") ws.send(JSON.stringify({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: { relativeUrl: `/api/assets/private-token/file.${msg.payload.html ? "html" : "png"}`, expiresAt: Date.now() + 60_000 } } }));
      else ws.send(data, { binary });
    });
  }));
  const socketPath = join(dir, "transport.sock"); server.listen(socketPath); await once(server, "listening");
  cleanup.push(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  let paneExists = true, owner = "user:operator";
  const app = Fastify(); await app.register(cookie); await app.register(websocket, { options: { maxPayload: 65536 } });
  await module.registerT3Gateway(app, { enabled: true, sessionSecret: secret, socketPath, timeoutMs: 80, revalidateMs: 25,
    publicOrigins: ["https://space.public.test:4911"], ...extra,
    store: { getPane: () => paneExists ? { id: "pane:owned123", roomId: "room:owned", mode: "T3CODE" } : null,
      getRoom: () => ({ id: "room:owned", ownerUserId: owner }) } });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 }); cleanup.push(() => app.close());
  const session = token();
  const headers = { cookie: `space_session=${session}`, host: new URL(origin).host, origin, "x-space-csrf-token": createCsrfToken(session, secret)! };
  return { app, origin, headers, requests, session, streamClosed: () => streamClosed, releaseStream: () => releaseStream(), deletePane: () => { paneExists = false; }, foreignRoom: () => { owner = "user:foreign"; } };
}

it("closes the upstream stream when its client disconnects", async () => {
  const f = await fixture();
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpRequest(f.origin + base + "api/orchestration/shell?stream=1", { headers: f.headers }, resolve);
    request.on("error", reject); request.end();
  });
  await once(response, "data"); response.destroy();
  await expect.poll(f.streamClosed).toBe(true);
});

it("returns a generic upstream failure without exposing the private transport", async () => {
  const f = await fixture();
  const response = await f.app.inject({ url: base + "api/orchestration/shell?fail=1", headers: f.headers });
  expect(response.statusCode).toBe(502);
  expect(response.json().error.code).toBe("T3_UPSTREAM_UNAVAILABLE");
  expect(response.body).not.toMatch(/socket|127\.0\.0\.1|private-token/);
});

it("requires real sessions, fixed operator, existing pane and owned room before contacting upstream", async () => {
  const f = await fixture();
  expect((await f.app.inject({ url: base })).statusCode).toBe(401);
  expect((await f.app.inject({ url: base, headers: { cookie: `space_session=${token("user:foreign")}` } })).statusCode).toBe(403);
  f.foreignRoom(); expect((await f.app.inject({ url: base, headers: f.headers })).statusCode).toBe(403);
  f.deletePane(); expect((await f.app.inject({ url: base, headers: f.headers })).statusCode).toBe(404);
  expect(f.requests).toHaveLength(0);
});
it("streams the first bytes before upstream completes", async () => {
  const f = await fixture();
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpRequest(f.origin + base + "api/orchestration/shell?stream=1", { headers: f.headers }, resolve);
    request.on("error", reject); request.end();
  });
  const first = await once(response, "data"); expect(first[0].toString()).toBe("first");
  const last = once(response, "data"); f.releaseStream(); expect((await last)[0].toString()).toBe("last");
});
it("keeps uploaded HTML bytes unchanged and sandboxes them instead of treating them as the app", async () => {
  const f = await fixture(); const ws = new WebSocket(f.origin.replace("http:", "ws:") + base + "ws", { headers: f.headers });
  cleanup.push(async () => { ws.terminate(); }); await once(ws, "open");
  ws.send(JSON.stringify({ _tag: "Request", id: "asset", tag: "assets.createUrl", payload: { html: true }, headers: [] }));
  const path = JSON.parse((await once(ws, "message"))[0].toString()).exit.value.relativeUrl;
  const result = await f.app.inject({ url: base + path, headers: f.headers });
  expect(result.statusCode).toBe(200);
  expect(result.body).toBe('<script>parent.location="/danger"</script>');
  expect(result.headers["content-security-policy"]).toContain("sandbox");
});
it("closes active WebSockets on session revocation and rejects a foreign Origin upgrade", async () => {
  const f = await fixture();
  const rejected = new WebSocket(f.origin.replace("http:", "ws:") + base + "ws", { headers: { ...f.headers, origin: "https://evil.test" } });
  rejected.on("error", () => {}); cleanup.push(async () => { rejected.terminate(); });
  const [, response] = await once(rejected, "unexpected-response"); expect(response.statusCode).toBe(403); response.resume(); rejected.terminate();
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + base + "ws", { headers: f.headers });
  cleanup.push(async () => { ws.terminate(); }); await once(ws, "open");
  const closed = once(ws, "close"); defaultSessionRevocationStore.revokeToken(f.session); await closed;
  expect((await f.app.inject({ url: base, headers: f.headers })).statusCode).toBe(401);
});
it("enforces Origin and CSRF on writes while preserving binary multipart data and stripping credentials", async () => {
  const f = await fixture(); const url = base + "api/orchestration/dispatch";
  const body = Buffer.from([45, 45, 65, 13, 10, 0, 255, 128]);
  const headers = { ...f.headers, "content-type": "multipart/form-data; boundary=A", authorization: "Bearer never-forward", "x-space-user-id": "user:evil" };
  expect((await f.app.inject({ method: "POST", url, headers: { ...headers, origin: "https://evil.test" }, payload: body })).statusCode).toBe(403);
  expect((await f.app.inject({ method: "POST", url, headers: { ...headers, "x-space-csrf-token": "wrong" }, payload: body })).statusCode).toBe(403);
  const result = await f.app.inject({ method: "POST", url, headers, payload: body });
  expect(result.statusCode).toBe(200); expect(result.rawPayload).toEqual(body);
  expect(f.requests[0]?.body).toEqual(body);
  expect(f.requests[0]?.headers).toMatchObject({ "x-space-user-id": "user:operator", "x-space-pane-id": "pane:owned123" });
  expect(f.requests[0]?.headers).not.toHaveProperty("cookie"); expect(f.requests[0]?.headers).not.toHaveProperty("authorization");
});
it("isolates redirects and HTML base paths and does not pass upstream cookies", async () => {
  const f = await fixture();
  const redir = await f.app.inject({ url: base + "welcome", headers: f.headers });
  expect(redir.statusCode).toBe(302); expect(redir.headers.location).toBe(base + "settings/providers");
  expect(redir.headers["set-cookie"]).toBeUndefined(); expect(redir.headers["x-private"]).toBeUndefined();
  const html = await f.app.inject({ url: base + "settings/providers", headers: f.headers });
  expect(html.body).toContain(`<base href="${base}">`);
});
it("points the app entry at the shared client bundle and caches hashed pane assets", async () => {
  // Hundreds of hashed modules must not be refetched for every pane open.
  const f = await fixture();
  const html = await f.app.inject({ url: base + "settings/providers", headers: f.headers });
  expect(html.headers["cache-control"]).toBe("private, no-store");
  expect(html.body).toContain('<script src="/api/t3code/assets/main.js"></script>');
  expect(html.body).not.toContain("./assets/");
  const asset = await f.app.inject({ url: base + "assets/main-AbC123.js", headers: f.headers });
  expect(asset.statusCode).toBe(200);
  expect(asset.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  const api = await f.app.inject({ url: base + "api/orchestration/shell", headers: f.headers });
  expect(api.headers["cache-control"]).toBe("private, no-store");
});
it("returns bounded timeout errors and rejects traversal and unknown routes", async () => {
  const f = await fixture();
  const result = await f.app.inject({ url: base + "api/orchestration/shell?hang=1", headers: f.headers });
  expect(result.statusCode).toBe(504); expect(result.body).not.toContain("transport.sock");
  expect((await f.app.inject({ url: base + "%252e%252e/private", headers: f.headers })).statusCode).toBe(400);
  expect((await f.app.inject({ url: base + "oauth/token", headers: f.headers })).statusCode).toBe(404);
});
it("relays bidirectional WebSockets and replaces only typed signed URL results with session-bound handles", async () => {
  const f = await fixture(); const ws = new WebSocket(f.origin.replace("http:", "ws:") + base + "ws", { headers: f.headers });
  cleanup.push(async () => { ws.terminate(); }); await once(ws, "open");
  const request = { _tag: "Request", id: "1", tag: "server.getConfig", payload: {}, headers: [] };
  ws.send(JSON.stringify(request)); expect(JSON.parse((await once(ws, "message"))[0].toString())).toEqual(request);
  ws.send(JSON.stringify({ ...request, id: "2", tag: "assets.createUrl" }));
  const response = JSON.parse((await once(ws, "message"))[0].toString());
  const path = response.exit.value.relativeUrl;
  expect(path).toMatch(/^__space\/assets\/[A-Za-z0-9_-]{40,}$/); expect(JSON.stringify(response)).not.toContain("private-token");
  expect((await f.app.inject({ url: base + path, headers: f.headers })).statusCode).toBe(200);
  expect((await f.app.inject({ url: base.replace("owned123", "other123") + path, headers: f.headers })).statusCode).toBe(404);
  const closed = once(ws, "close"); f.deletePane(); await closed;
});

it("accepts the configured public Space origin behind the TLS proxy and still rejects foreign origins", async () => {
  // The proxy hop makes the API see http://127.0.0.1:<port> while the browser
  // sends the public https Origin (the live "T3 Code could not load" failure).
  const f = await fixture();
  const url = base + "api/orchestration/dispatch";
  const publicHeaders = { ...f.headers, origin: "https://space.public.test:4911" };
  expect((await f.app.inject({ method: "POST", url, headers: publicHeaders, payload: "{}" })).statusCode).toBe(200);
  for (const origin of ["https://evil.test", "http://space.public.test:4911", "https://space.public.test:4912", "null"]) {
    expect((await f.app.inject({ method: "POST", url, headers: { ...f.headers, origin }, payload: "{}" })).statusCode, origin).toBe(403);
  }
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + base + "ws", { headers: publicHeaders });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  ws.close();
});

it("renders a pane document with its binding, CSRF token and fixed reads in one response", async () => {
  const opened: string[] = [];
  const f = await fixture({
    inlineBootstrapEnabled: () => true,
    documentBootstrap: async (_request: unknown, paneId: string) => { opened.push(paneId); return { binding: { version: 1, paneId }, bindingError: null }; },
    startupAssets: async () => ({ app: ["app-Abc123.js", "icons-Def456.js"], styles: ["app-Ghi789.css"] }),
  });
  const navigation = { ...f.headers, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" };
  const html = await f.app.inject({ url: base, headers: navigation });
  expect(html.statusCode).toBe(200);
  expect(html.headers["cache-control"]).toBe("private, no-store");
  expect(html.body).toContain('<link rel="modulepreload" crossorigin href="/api/t3code/assets/app-Abc123.js">');
  expect(html.body).toContain('<link rel="preload" as="style" crossorigin href="/api/t3code/assets/app-Ghi789.css">');
  const block = /<script type="application\/json" id="space-t3-bootstrap">([\s\S]*?)<\/script>/.exec(html.body);
  expect(block, "inline bootstrap block").not.toBeNull();
  expect(block![1]).not.toMatch(/<|\u2028/);
  const payload = JSON.parse(block![1]!);
  expect(payload).toMatchObject({ version: 1, binding: { version: 1, paneId: "pane:owned123" }, bindingError: null });
  expect(payload.csrfToken).toBe(f.headers["x-space-csrf-token"]);
  expect(JSON.parse(payload.responses["api/auth/session"].body)).toMatchObject({ authenticated: true });
  expect(payload.responses["api/auth/session"]).toMatchObject({ status: 200, contentType: "application/json" });
  // A non-JSON upstream read is left to the browser instead of being inlined.
  expect(payload.responses[".well-known/t3/environment"]).toBeUndefined();
  expect(opened).toEqual(["pane:owned123"]);
  // The inline script is a data block; the page policy is unchanged.
  expect(String(html.headers["content-security-policy"])).toContain("script-src 'self' 'wasm-unsafe-eval';");
});

it("never opens a binding inline for other sites, other destinations or older runtimes", async () => {
  let opened = 0, enabled = true;
  const f = await fixture({
    inlineBootstrapEnabled: () => enabled,
    documentBootstrap: async () => { opened++; return { binding: { version: 1 }, bindingError: null }; },
  });
  const navigation = { ...f.headers, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" };
  for (const headers of [{ ...navigation, "sec-fetch-site": "same-site" }, { ...navigation, "sec-fetch-dest": "document" }, { ...navigation, "sec-fetch-mode": "no-cors" }, f.headers]) {
    const html = await f.app.inject({ url: base, headers });
    expect(html.statusCode).toBe(200); expect(html.body).not.toContain("space-t3-bootstrap");
  }
  enabled = false;
  expect((await f.app.inject({ url: base, headers: navigation })).body).not.toContain("space-t3-bootstrap");
  expect((await f.app.inject({ url: base, headers: { ...navigation, "sec-fetch-site": "cross-site" } })).statusCode).toBe(403);
  expect(opened).toBe(0);
});

it("passes a refused pane folder to the document so the browser makes no failing open request", async () => {
  const f = await fixture({ inlineBootstrapEnabled: () => true, documentBootstrap: async () => ({ binding: null, bindingError: "T3_WORKSPACE_FORBIDDEN" }) });
  const html = await f.app.inject({ url: base, headers: { ...f.headers, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" } });
  const payload = JSON.parse(/id="space-t3-bootstrap">([\s\S]*?)<\/script>/.exec(html.body)![1]!);
  expect(payload).toMatchObject({ binding: null, bindingError: "T3_WORKSPACE_FORBIDDEN" });
});

it("serves app files that the pane's fetch transport scoped under the pane", async () => {
  // Files resolved from the shared bundle (import.meta.url) and fetched through
  // the in-app transport arrive under the pane base; they are the same files.
  const f = await fixture();
  const result = await f.app.inject({ url: base + "api/t3code/assets/ghostty-vt-Ab1.wasm", headers: f.headers });
  expect(result.statusCode).toBe(200);
  expect(f.requests.at(-1)?.url).toBe("/assets/ghostty-vt-Ab1.wasm");
  expect(result.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  expect((await f.app.inject({ url: base + "api/t3code/assets/sub%2Fx.wasm", headers: f.headers })).statusCode).toBe(400);
  expect((await f.app.inject({ url: base + "api/t3code/assets/x.exe", headers: f.headers })).statusCode).toBe(404);
});

it("forwards a valid T3 orchestration protocol header to the v0.1.0 thread reads and refuses MCP OAuth and hook routes", async () => {
  const f = await fixture();
  for (const [protocol, expected] of [["2", "2"], ["x", undefined], ["2, 3", undefined]] as const) {
    const before = f.requests.length;
    const result = await f.app.inject({ url: base + "api/orchestration/threads/thread_1/history?limit=50", headers: { ...f.headers, "x-t3-orchestration-protocol": protocol } });
    expect(result.statusCode).toBe(200);
    expect((f.requests[before]!.headers as Record<string, string | undefined>)["x-t3-orchestration-protocol"]).toBe(expected);
  }
  for (const path of ["oauth/mcp/token", "oauth/mcp/register", ".well-known/oauth-protected-resource/mcp", "v1/environments/env-real/hooks/wake", "api/projects"]) {
    const before = f.requests.length;
    for (const method of ["GET", "POST"] as const) {
      expect((await f.app.inject({ method, url: base + path, headers: f.headers, ...(method === "POST" ? { payload: {} } : {}) })).statusCode, `${method} ${path}`).toBe(404);
    }
    expect(f.requests.length, path).toBe(before);
  }
});
