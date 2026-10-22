import http from "node:http";
import zlib from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createCanonicalSpaceMemoryBridge, InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig, type SpaceApiConfig } from "../src/config.js";
import vm from "node:vm";
import {
  harnessDebugBootstrap,
  harnessStaticCacheControl,
  harnessUpstreamPath,
  isHarnessRootHttpPath,
  isHarnessUpgradePath
} from "../src/harness-proxy.js";

const temporaryRoots: string[] = [];

function testConfig(override: Partial<SpaceApiConfig> = {}): SpaceApiConfig {
  return getApiConfig({
    SPACE_INTERNAL_API_TOKEN: "harness-proxy-test-internal-token",
    SPACE_HARNESS_ENABLED: "true",
    SPACE_HARNESS_ORIGIN: "http://127.0.0.1:1"
  });
}

async function createTestApp(override: Partial<SpaceApiConfig> = {}) {
  const memoryRoot = await mkdtemp(join(tmpdir(), "space-harness-proxy-memory-"));
  temporaryRoots.push(memoryRoot);
  const indexPath = join(memoryRoot, "gemini_history.md");
  const monthlyPath = join(memoryRoot, "gemini_history_2026-07.md");
  await writeFile(indexPath, "# Test memory\n");
  await writeFile(monthlyPath, "# Test monthly memory\n");
  const config = {
    ...testConfig(),
    ...override,
    spaceMemoryIndexPath: indexPath,
    spaceMemoryMonthlyPath: monthlyPath,
    spaceMemoryLockPath: join(memoryRoot, "memory.lock")
  };
  const app = await createApp({
    store: new InMemorySpaceStore(),
    config,
    canonicalMemory: createCanonicalSpaceMemoryBridge({ indexPath, monthlyPath }),
    auth: {
      sessionSecret: "harness-proxy-test-session-secret",
      devLogin: true,
      secureCookies: false
    },
    systemAnalyticsService: {
      sample: async () => {},
      rollupAndSweep: async () => {},
      backfill: async () => {},
      dispose: async () => {}
    } as any
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const sessionCookie = login.cookies.find((c) => c.name === "space_session")?.value;
  const cookie = `space_session=${sessionCookie}`;
  return { app, config, cookie };
}

function startUpstream(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve((address as { port: number }).port);
    });
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface FakeElement {
  id: string;
  innerHTML: string;
  style: Record<string, string>;
  onclick: unknown;
  remove: () => void;
}

// Runs the injected diagnostics script against a minimal window/document.
function runHarnessDebugBootstrap() {
  const elements = new Map<string, FakeElement>();
  const listeners = new Map<string, Array<(evt: unknown) => void>>();
  let intervalTick: (() => void) | undefined;
  const root = { children: [{}] };
  const document = {
    body: { appendChild: (el: FakeElement) => { elements.set(el.id, el); } },
    documentElement: {},
    getElementById: (id: string) => (id === "root" ? root : elements.get(id) ?? null),
    querySelector: () => null,
    createElement: (): FakeElement => {
      const el: FakeElement = {
        id: "",
        innerHTML: "",
        style: {},
        onclick: null,
        remove: () => { elements.delete(el.id); }
      };
      return el;
    }
  };
  const sandbox: Record<string, unknown> = {
    document,
    Date,
    String,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ enabled: false }) }),
    setInterval: (callback: () => void) => { intervalTick = callback; return 1; },
    clearInterval: () => {},
    addEventListener: (type: string, listener: (evt: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    }
  };
  sandbox.window = sandbox;
  const script = harnessDebugBootstrap("space-pane-test")
    .replace(/^<script[^>]*>/, "")
    .replace(/<\/script>$/, "");
  vm.runInNewContext(script, sandbox);
  return {
    state: sandbox.__SPACE_HARNESS_DEBUG__ as { errors: unknown[]; isRendered: boolean },
    overlay: () => elements.get("space-harness-debug-overlay"),
    dispatchError: (evt: Record<string, unknown>) => {
      for (const listener of listeners.get("error") ?? []) listener({ target: sandbox, ...evt });
    },
    markRendered: () => intervalTick?.()
  };
}

describe("harness diagnostics overlay", () => {
  it("ignores the benign ResizeObserver loop notification", () => {
    const harness = runHarnessDebugBootstrap();
    harness.markRendered();
    harness.dispatchError({ message: "ResizeObserver loop completed with undelivered notifications.", error: null });
    harness.dispatchError({ message: "ResizeObserver loop limit exceeded", error: null });
    expect(harness.state.errors).toHaveLength(0);
    expect(harness.overlay()).toBeUndefined();
  });

  it("still reports real errors, escapes their text and lets the operator minimize the card", () => {
    const harness = runHarnessDebugBootstrap();
    harness.dispatchError({
      message: "Uncaught Error: <img src=x onerror=alert(1)>",
      error: { stack: "Error: <b>bad</b>\n    at client.js:1:1" }
    });
    harness.markRendered();
    expect(harness.state.errors).toHaveLength(1);
    expect(harness.state.isRendered).toBe(true);
    const html = harness.overlay()?.innerHTML ?? "";
    expect(html).toContain("Uncaught JavaScript Errors (1)");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("space-harness-debug-collapse-btn");
  });

  it("does not hide a thrown error that mentions ResizeObserver", () => {
    const harness = runHarnessDebugBootstrap();
    harness.dispatchError({
      message: "ResizeObserver loop completed with undelivered notifications.",
      error: { stack: "Error: thrown by app code" }
    });
    expect(harness.state.errors).toHaveLength(1);
  });
});

describe("harness proxy", () => {
  it.each([
    ["/assets/vendor-D22_Mp1f.js", "GET"],
    ["/assets/index-C6eRlFa6.css", "HEAD"],
    ["/plugins/@deepseek-ai/dsh-client-ui/client.js?rev=cf4575517765", "GET"]
  ])("marks fingerprinted Harness resource %s as immutable for %s", (url, method) => {
    expect(harnessStaticCacheControl(url, method)).toBe("private, max-age=31536000, immutable");
  });

  it.each([
    ["/", "GET"],
    ["/assets/client.js", "GET"],
    ["/plugins/@deepseek-ai/dsh-client-ui/client.js", "GET"],
    ["/plugins/@deepseek-ai/dsh-client-ui/client.js?rev=unsafe", "GET"],
    ["/assets/vendor-D22_Mp1f.js", "POST"]
  ])("does not cache mutable Harness resource %s for %s", (url, method) => {
    expect(harnessStaticCacheControl(url, method)).toBeNull();
  });

  it("routes the Harness event downlinks through the upstream WebSocket proxy", () => {
    expect(isHarnessUpgradePath("/api/events.mux")).toBe(true);
    expect(isHarnessUpgradePath("/api/events.host?client=browser")).toBe(true);
    expect(isHarnessUpgradePath("/api/harness/")).toBe(true);
    expect(isHarnessUpgradePath("/api/events")).toBe(false);
    expect(isHarnessUpgradePath("/api/events.mux/other")).toBe(false);
  });

  it("keeps Harness event WebSockets bidirectional after the upgrade", async () => {
    const upstreamServer = http.createServer();
    const upstreamWebSockets = new WebSocketServer({ noServer: true });
    const upstreamReceived = new Promise<string>((resolve) => {
      upstreamWebSockets.once("connection", (socket) => {
        setTimeout(() => socket.send("upstream-event"), 100);
        socket.once("message", (message) => resolve(message.toString()));
      });
    });
    upstreamServer.on("upgrade", (request, socket, head) => {
      expect(request.url).toBe("/api/events.mux");
      expect(request.headers.host).toBe(`127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`);
      expect(request.headers.origin).toBe(`http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`);
      upstreamWebSockets.handleUpgrade(request, socket, head, (client) => {
        upstreamWebSockets.emit("connection", client, request);
      });
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    const { app, cookie } = await createTestApp({
      harnessOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      harnessProxyTimeoutMs: 25
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events.mux`, {
      headers: { cookie }
    });

    try {
      const received = await new Promise<string>((resolve, reject) => {
        socket.once("message", (message) => resolve(message.toString()));
        socket.once("error", reject);
      });
      expect(received).toBe("upstream-event");
      socket.send("browser-frame");
      await expect(upstreamReceived).resolves.toBe("browser-frame");
    } finally {
      socket.terminate();
      upstreamWebSockets.close();
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
      await app.close();
    }
  });

  it("recognizes only exact Harness root HTTP proxy paths", () => {
    expect(isHarnessRootHttpPath("/api/respond")).toBe(true);
    expect(isHarnessRootHttpPath("/api/commands/execute?trace=test")).toBe(true);
    expect(isHarnessRootHttpPath("/api/pluginInventory/list")).toBe(true);
    expect(isHarnessRootHttpPath("/api/respond/other")).toBe(false);
    expect(isHarnessRootHttpPath("/api/clipboard-items")).toBe(false);
  });

  it("rejects unauthenticated requests", async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/harness/healthz" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns HARNESS_DISABLED when the harness flag is off", async () => {
    const { app, cookie } = await createTestApp({ harnessEnabled: false });
    const response = await app.inject({ method: "GET", url: "/api/harness/healthz", headers: { cookie } });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("HARNESS_DISABLED");
    await app.close();
  });

  it("reports unhealthy when the upstream is unreachable", async () => {
    const { app, cookie } = await createTestApp({ harnessOrigin: "http://127.0.0.1:1" });
    const response = await app.inject({ method: "GET", url: "/api/harness/healthz", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, status: 502 });
    await app.close();
  });

  it("reports healthy when the upstream responds", async () => {
    const port = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("harness ok");
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const response = await app.inject({ method: "GET", url: "/api/harness/healthz", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, status: 200 });
    await app.close();
  });

  it("proxies a GET request and forwards the x-forwarded-prefix", async () => {
    let seenPrefix: string | undefined;
    let seenPath: string | undefined;
    let seenHost: string | undefined;
    const port = await startUpstream((request, response) => {
      seenPrefix = request.headers["x-forwarded-prefix"] as string | undefined;
      seenPath = request.url;
      seenHost = request.headers.host;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>harness</html>");
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const response = await app.inject({ method: "GET", url: "/api/harness/index.html", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(seenPrefix).toBe("/api/harness");
    expect(seenPath).toBe("/index.html");
    expect(seenHost).toBe(`127.0.0.1:${port}`);
    await app.close();
  });

  it("overrides upstream no-store only for fingerprinted Harness assets", async () => {
    const port = await startUpstream((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/javascript",
        "cache-control": "no-store"
      });
      response.end("export const ready = true;");
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });

    const fingerprinted = await app.inject({
      method: "GET",
      url: "/api/harness/assets/index-AbCdEf12.js",
      headers: { cookie }
    });
    const mutable = await app.inject({
      method: "GET",
      url: "/api/harness/assets/index.js",
      headers: { cookie }
    });

    expect(fingerprinted.statusCode).toBe(200);
    expect(fingerprinted.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(mutable.statusCode).toBe(200);
    expect(mutable.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("creates and selects an isolated Harness session for a Space pane before serving HTML", async () => {
    const seenPaths: string[] = [];
    const createEnvelopes: unknown[] = [];
    const upstreamServer = http.createServer((request, response) => {
      seenPaths.push(request.url ?? "");
      if (request.url === "/api/workspace.create" || request.url === "/api/session.create") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          createEnvelopes.push(envelope);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(request.url === "/api/workspace.create" ? {
            type: "server-response",
            result: { ok: true, value: { workspace: { workspaceId: "workspace-test" }, created: false } }
          } : {
            type: "server-response",
            result: { ok: true, value: { sessionId: "space-pane-testPane123", agentPreset: "code" } }
          }));
        });
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<html><head><script src="/assets/client.js"></script></head><body>Harness original</body></html>');
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const port = (upstreamServer.address() as AddressInfo).port;
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/harness/?spacePane=pane%3AtestPane123",
        headers: { cookie }
      });
      expect(response.statusCode).toBe(200);
      expect(seenPaths).toEqual(["/api/workspace.create", "/api/session.create", "/"]);
      expect(createEnvelopes).toEqual([
        expect.objectContaining({
          type: "client-request",
          method: "workspace.create",
          payload: { path: "/opt/spaceapp/var/deepseek-harness/workspace" }
        }),
        expect.objectContaining({
          type: "client-request",
          method: "session.create",
          payload: {
            sessionId: "space-pane-testPane123",
            workspaceId: "workspace-test"
          }
        })
      ]);
      expect(response.body).toContain("data-space-harness-transport");
      expect(response.body).toContain("__DSH_TRANSPORT__");
      expect(response.body.indexOf("data-space-harness-transport")).toBeLessThan(response.body.indexOf("client.js"));
      expect(response.body).toContain("data-space-harness-pane-session");
      expect(response.body).toContain("data-space-harness-shared-events");
      expect(response.body.indexOf("data-space-harness-shared-events")).toBeLessThan(response.body.indexOf("client.js"));
      expect(response.body).toContain("dsh.sessions.current.space-pane-testPane123");
      expect(response.body).toContain('\\\"sessionId\\\":\\\"space-pane-testPane123\\\"');
      expect(response.body).toContain('src="/api/harness/assets/client.js"');
      expect(response.body).toContain("Harness original");
      expect(response.body.indexOf("data-space-harness-pane-session")).toBeLessThan(response.body.indexOf("client.js"));
      expect(response.body).not.toContain("pane%3AtestPane123");
    } finally {
      await app.close();
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it("creates and selects a Harness session using modern Typert Gateway format", async () => {
    const seenPaths: string[] = [];
    const createEnvelopes: unknown[] = [];
    const upstreamServer = http.createServer((request, response) => {
      seenPaths.push(request.url ?? "");
      if (request.url === "/api/workspace.create" || request.url === "/api/session.create") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      if (request.url === "/api/workspace/create" || request.url === "/api/session/create") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const envelope = JSON.parse(body);
          createEnvelopes.push(envelope);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(request.url === "/api/workspace/create" ? {
            type: "server-response",
            rpcId: envelope.rpcId,
            result: { ok: true, value: { workspace: { workspaceId: "workspace-typert" }, created: false } }
          } : {
            type: "server-response",
            rpcId: envelope.rpcId,
            result: { ok: true, value: { sessionId: "space-pane-typert456", agentPreset: "standard" } }
          }));
        });
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head><script src=\"/assets/client.js\"></script></head><body>Harness typert</body></html>");
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const port = (upstreamServer.address() as AddressInfo).port;
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/harness/?spacePane=pane%3Atypert456",
        headers: { cookie }
      });
      expect(response.statusCode).toBe(200);
      expect(seenPaths).toEqual(["/api/workspace.create", "/api/workspace/create", "/api/session/create", "/"]);
      expect(createEnvelopes).toEqual([
        expect.objectContaining({
          type: "client-request",
          method: "workspace/create",
          payload: { args: { request: { path: "/opt/spaceapp/var/deepseek-harness/workspace" } } }
        }),
        expect.objectContaining({
          type: "client-request",
          method: "session/create",
          payload: {
            args: {
              request: {
                sessionId: "space-pane-typert456",
                workspaceId: "workspace-typert"
              }
            }
          }
        })
      ]);
      expect(response.body).toContain("data-space-harness-pane-session");
      expect(response.body).toContain("dsh.sessions.current.space-pane-typert456");
      expect(response.body).toContain("Harness typert");
    } finally {
      await app.close();
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it("keeps the legacy HTML proxy flow when spacePane is invalid", async () => {
    const seenPaths: string[] = [];
    const upstreamServer = http.createServer((request, response) => {
      seenPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head></head><body>Harness legacy</body></html>");
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const port = (upstreamServer.address() as AddressInfo).port;
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/harness/?spacePane=%3Cscript%3Eunsafe%3C%2Fscript%3E",
        headers: { cookie }
      });
      expect(response.statusCode).toBe(200);
      expect(seenPaths).toEqual(["/"]);
      expect(response.body).toContain("Harness legacy");
      expect(response.body).toContain("data-space-harness-transport");
      expect(response.body).toContain("__DSH_TRANSPORT__");
      expect(response.body).not.toContain("data-space-harness-pane-session");
      expect(response.body).not.toContain("unsafe");
    } finally {
      await app.close();
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it("proxies a same-origin dotted RPC method without a CSRF token", async () => {
    let seenPath: string | undefined;
    let seenPrefix: string | undefined;
    let seenBody = "";
    const port = await startUpstream((request, response) => {
      seenPath = request.url;
      seenPrefix = request.headers["x-forwarded-prefix"] as string | undefined;
      request.on("data", (chunk) => (seenBody += chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const payload = { type: "client-request", rpcId: "r1", method: "host.listDirectory", payload: {} };
    const response = await app.inject({
      method: "POST",
      url: "/api/host.listDirectory",
      headers: { cookie, "sec-fetch-site": "same-origin" },
      payload
    });
    expect(response.statusCode).toBe(200);
    expect(seenPath).toBe("/api/host.listDirectory");
    expect(seenPrefix).toBe("/api");
    expect(JSON.parse(seenBody)).toEqual(payload);
    await app.close();
  });

  it("preserves the query string when proxying a dotted RPC method", async () => {
    let seenPath: string | undefined;
    const port = await startUpstream((request, response) => {
      seenPath = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const response = await app.inject({
      method: "GET",
      url: "/api/session.export?sessionId=session%3Atest&format=json",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(seenPath).toBe("/api/session.export?sessionId=session%3Atest&format=json");
    await app.close();
  });

  it.each([
    "/plugins/events",
    "/api/respond",
    "/api/commands/list",
    "/api/commands/execute",
    "/api/pluginInventory/list",
    "/api/dynamicCordisRunner/inventory",
    "/api/dynamicCordisRunner/syncInspectManifest"
  ])("proxies the Harness root path %s instead of routing it into Space", async (pathname) => {
    let seenPath: string | undefined;
    const port = await startUpstream((request, response) => {
      seenPath = request.url;
      response.writeHead(200, {
        "content-type": pathname === "/plugins/events" ? "text/event-stream" : "application/json"
      });
      response.end(pathname === "/plugins/events" ? "event: ready\ndata: {}\n\n" : '{"ok":true}');
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const response = await app.inject({ method: "GET", url: pathname, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(seenPath).toBe(pathname);
    await app.close();
  });

  it("forwards a same-origin approval response body without requiring a Space CSRF token", async () => {
    let seenBody = "";
    const port = await startUpstream((request, response) => {
      request.on("data", (chunk) => (seenBody += chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"accepted":true}');
      });
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const payload = {
      type: "client-response",
      rpcId: "approval-rpc",
      result: { ok: true, value: { sessionId: "session:test", approvalId: "approval:test", outcome: "allowed-once" } }
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/respond",
      headers: { cookie, "sec-fetch-site": "same-origin" },
      payload
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(seenBody)).toEqual(payload);
    await app.close();
  });

  it("strips browser-trust headers when forwarding to the upstream", async () => {
    let seenOrigin: string | undefined;
    let seenSecFetchSite: string | undefined;
    const port = await startUpstream((request, response) => {
      seenOrigin = request.headers.origin as string | undefined;
      seenSecFetchSite = request.headers["sec-fetch-site"] as string | undefined;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const payload = { type: "client-request", rpcId: "r1", method: "host.describe", payload: {} };
    const response = await app.inject({
      method: "POST",
      url: "/api/host.describe",
      headers: { cookie, origin: "http://127.0.0.1:4911", "sec-fetch-site": "same-origin" },
      payload
    });
    expect(response.statusCode).toBe(200);
    expect(seenOrigin).toBeUndefined();
    expect(seenSecFetchSite).toBeUndefined();
    await app.close();
  });

  it("does not proxy non-dotted single-segment api paths", async () => {
    const { app, cookie } = await createTestApp();
    const response = await app.inject({ method: "POST", url: "/api/unknown", headers: { cookie, "sec-fetch-site": "same-origin" }, payload: {} });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("still enforces CSRF on other api routes", async () => {
    const { app, cookie } = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/clipboard-items",
      headers: { cookie },
      payload: { content: "x" }
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("preserves exact combo batch query strings without URL-encoding in harnessUpstreamPath", () => {
    const combo = "/api/harness/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=753b58ed8f96";
    expect(harnessUpstreamPath(combo)).toBe("/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=753b58ed8f96");

    const multi = "/api/harness/plugins/??@deepseek-ai/dsh-a/client.js,@deepseek-ai/dsh-b/client.js&rev=12345678";
    expect(harnessUpstreamPath(multi)).toBe("/plugins/??@deepseek-ai/dsh-a/client.js,@deepseek-ai/dsh-b/client.js&rev=12345678");

    const rootDoc = "/api/harness/?spacePane=pane:5HyxFHXOis7s&frame=0";
    expect(harnessUpstreamPath(rootDoc)).toBe("/?frame=0");

    const trailingNoParam = "/api/harness/";
    expect(harnessUpstreamPath(trailingNoParam)).toBe("/");

    const bare = "/api/harness";
    expect(harnessUpstreamPath(bare)).toBe("/");
  });

  it("proxies combo batch requests to upstream with unencoded query strings", async () => {
    let seenPath: string | undefined;
    const port = await startUpstream((request, response) => {
      seenPath = request.url;
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end('window.__ModuleLoader__.load({ id: "test" });');
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const comboUrl = "/api/harness/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=753b58ed8f96";
    const response = await app.inject({
      method: "GET",
      url: comboUrl,
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(seenPath).toBe("/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=753b58ed8f96");
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    await app.close();
  });

  it("waits out a Harness restart instead of failing an open pane's plugin load", async () => {
    let dropped = 0;
    const upstreamServer = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end("export default {};");
    });
    // The namespace relay accepts and then drops connections while the Harness restarts.
    upstreamServer.on("connection", (socket) => {
      if (dropped < 3) {
        dropped += 1;
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const { port } = upstreamServer.address() as AddressInfo;
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/harness/plugins/??@deepseek-ai/dsh-api-gateway/client.js&rev=d835594a6c1b",
        headers: { cookie }
      });
      expect(dropped).toBe(3);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("export default {};");
    } finally {
      await app.close();
      upstreamServer.close();
    }
  });

  it("redirects bare /api/harness to /api/harness/", async () => {
    const { app, cookie } = await createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/harness?spacePane=pane:5HyxFHXOis7s",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(307);
    expect(response.headers.location).toBe("/api/harness/?spacePane=pane:5HyxFHXOis7s");
    await app.close();
  });

  it("proxies /plugins/* routes to upstream without 404", async () => {
    let seenPath: string | undefined;
    const port = await startUpstream((request, response) => {
      seenPath = request.url;
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end("export default {};");
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const response = await app.inject({
      method: "GET",
      url: "/plugins/custom/feature.js?rev=12345678",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(seenPath).toBe("/plugins/custom/feature.js?rev=12345678");
    await app.close();
  });

  it("forces identity encoding upstream and decompresses gzipped HTML transparently", async () => {
    let upstreamAcceptEncoding: string | undefined;
    const rawHtml = "<!doctype html><html><head><title>Harness</title></head><body><div id=\"root\"></div></body></html>";
    const compressed = zlib.gzipSync(Buffer.from(rawHtml, "utf8"));

    const port = await startUpstream((request, response) => {
      if (request.url === "/api/workspace.create" || request.url === "/api/session.create") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(request.url === "/api/workspace.create" ? {
          type: "server-response",
          result: { ok: true, value: { workspace: { workspaceId: "workspace-test" }, created: false } }
        } : {
          type: "server-response",
          result: { ok: true, value: { sessionId: "space-pane-5HyxFHXOis7s", agentPreset: "code" } }
        }));
        return;
      }
      upstreamAcceptEncoding = request.headers["accept-encoding"];
      // Simulate upstream responding with gzip even if identity was requested or if upstream compresses unconditionally
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip"
      });
      response.end(compressed);
    });

    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const response = await app.inject({
      method: "GET",
      url: "/api/harness/?spacePane=pane:5HyxFHXOis7s",
      headers: {
        cookie,
        "accept-encoding": "gzip, deflate, br"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(upstreamAcceptEncoding).toBe("identity");
    // Response body is cleanly decompressed and rewritten (Fastify compress may re-compress according to client accept-encoding)
    const decompressedBody = response.headers["content-encoding"] === "br"
      ? zlib.brotliDecompressSync(response.rawPayload).toString("utf8")
      : response.headers["content-encoding"] === "gzip"
      ? zlib.gunzipSync(response.rawPayload).toString("utf8")
      : response.body;

    expect(decompressedBody).toContain("<!doctype html>");
    expect(decompressedBody).toContain("data-space-harness-debug");
    expect(decompressedBody).toContain("Space Harness Diagnostics");
    expect(decompressedBody).toContain("data-space-harness-pane-session");
    expect(decompressedBody).not.toContain("Harness Ready");
    await app.close();
  });

  it("recovers when session.create reports session/conflict and renders workspace auto-select watchdog", async () => {
    const port = await startUpstream((request, response) => {
      if (request.url === "/api/workspace.create") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          type: "server-response",
          result: { ok: true, value: { workspace: { workspaceId: "workspace-existing" }, created: false } }
        }));
        return;
      }
      if (request.url === "/api/session.create") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          type: "server-response",
          result: {
            ok: false,
            error: {
              code: "session/conflict",
              message: 'session "space-pane-conflictPane123" belongs to "/opt/spaceapp", not "/opt/spaceapp/var/deepseek-harness/workspace"'
            }
          }
        }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html><head></head><body>Harness ready</body></html>");
    });

    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const response = await app.inject({
      method: "GET",
      url: "/api/harness/?spacePane=pane:conflictPane123",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("data-space-harness-pane-session");
    expect(response.body).toContain("autoSelectWorkspace");
    expect(response.body).toContain("isComposerInert");
    expect(response.body).toContain("MutationObserver");
    expect(response.body).toContain("clickElement");
    expect(response.body).toContain("dsh.sessions.current.space-pane-conflictPane123");
    expect(response.body).toContain('"dsh.sessions.current",');
    await app.close();
  });

  it("forwards POST body correctly on /api/harness/* routes", async () => {
    let receivedBody = "";
    const port = await startUpstream((request, response) => {
      if (request.url === "/api/session/create" && request.method === "POST") {
        let data = "";
        request.on("data", (chunk) => { data += chunk; });
        request.on("end", () => {
          receivedBody = data;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            type: "server-response",
            result: { ok: true, value: { sessionId: "session-new-123" } }
          }));
        });
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });

    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const payload = {
      type: "client-request",
      rpcId: "rpc-test-1",
      method: "session/create",
      payload: { args: { request: { workspaceId: "ws-456" } } }
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/harness/api/session/create",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      payload
    });

    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.result.value.sessionId).toBe("session-new-123");
    expect(JSON.parse(receivedBody)).toEqual(payload);
    await app.close();
  });

  it("refuses Harness writes without a CSRF token or a same-origin browser request, and from other roles", async () => {
    let upstreamCalls = 0;
    const port = await startUpstream((request, response) => {
      upstreamCalls += 1;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const { app, cookie } = await createTestApp({ harnessOrigin: `http://127.0.0.1:${port}` });
    const secret = "harness-proxy-test-session-secret";
    try {
      for (const url of ["/api/host.runCommand", "/api/respond", "/api/harness/api/session/create", "/plugins/events", "/plugins/x/run"]) {
        for (const site of [undefined, "same-site", "cross-site", "none"]) {
          const response = await app.inject({ method: "POST", url, headers: { cookie, ...(site ? { "sec-fetch-site": site } : {}) }, payload: {} });
          expect(response.statusCode, `${url} ${site}`).toBe(403);
        }
      }
      expect(upstreamCalls).toBe(0);
      const sessionToken = cookie.slice("space_session=".length);
      const withToken = await app.inject({ method: "POST", url: "/plugins/x/run",
        headers: { cookie, "x-space-csrf-token": createCsrfToken(sessionToken, secret)! }, payload: {} });
      expect(withToken.statusCode).toBe(200);

      const userToken = signSession({ id: "user:member", email: "member@example.test", role: "USER" }, secret);
      const userHeaders = { cookie: `space_session=${userToken}`, "x-space-csrf-token": createCsrfToken(userToken, secret)!, "sec-fetch-site": "same-origin" };
      for (const [method, url] of [["GET", "/api/harness/"], ["POST", "/api/host.runCommand"], ["POST", "/plugins/x/run"]] as const) {
        const response = await app.inject({ method, url, headers: userHeaders, ...(method === "POST" ? { payload: {} } : {}) });
        expect([403, 404], `${method} ${url} ${response.body}`).toContain(response.statusCode);
      }

      const diagnosticsToken = signSession({ id: "user:operator", email: "space@space.local", role: "ADMIN", automationScope: "APP_DIAGNOSTICS" }, secret);
      const diagnostics = await app.inject({ method: "POST", url: "/api/host.runCommand", payload: {},
        headers: { cookie: `space_session=${diagnosticsToken}`, "x-space-csrf-token": createCsrfToken(diagnosticsToken, secret)!, "sec-fetch-site": "same-origin" } });
      expect(diagnostics.statusCode).toBe(403);
      expect(upstreamCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("refuses the Harness WebSocket to a USER session", async () => {
    const { app } = await createTestApp({ harnessOrigin: "http://127.0.0.1:9" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const userToken = signSession({ id: "user:member", email: "member@example.test", role: "USER" }, "harness-proxy-test-session-secret");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events.mux`, { headers: { cookie: `space_session=${userToken}` } });
    try {
      const status = await new Promise<number>((resolve) => {
        socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
        socket.once("open", () => resolve(101));
        socket.once("error", () => resolve(0));
      });
      expect(status).toBe(401);
    } finally {
      socket.terminate();
      await app.close();
    }
  });
});
