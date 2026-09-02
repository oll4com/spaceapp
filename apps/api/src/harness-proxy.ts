import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SpaceApiConfig } from "./config.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const BROWSER_TRUST_HEADERS = new Set([
  "origin",
  "referer",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user"
]);

const HARNESS_WEBSOCKET_PATHS = new Set([
  "/api/events.mux",
  "/api/events.host"
]);

const HARNESS_ROOT_HTTP_PATHS = new Set([
  "/plugins/events",
  "/api/respond",
  "/api/commands/list",
  "/api/commands/execute",
  "/api/pluginInventory/list",
  "/api/dynamicCordisRunner/inventory",
  "/api/dynamicCordisRunner/syncInspectManifest"
]);

const SPACE_PANE_ID_PATTERN = /^pane:[A-Za-z0-9_-]{6,80}$/;
const HARNESS_CURRENT_SESSION_KEY = "dsh.sessions.current";
const HARNESS_DEFAULT_WORKSPACE = "/opt/spaceapp/var/deepseek-harness/workspace";

export function isHarnessRootHttpPath(rawUrl: string | undefined): boolean {
  const pathname = (rawUrl ?? "").split("?", 1)[0] ?? "";
  return HARNESS_ROOT_HTTP_PATHS.has(pathname);
}

const HTML_REWRITE_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /src="\/assets\//g, replacement: 'src="/api/harness/assets/' },
  { pattern: /href="\/assets\//g, replacement: 'href="/api/harness/assets/' },
  { pattern: /href="\/plugins\//g, replacement: 'href="/api/harness/plugins/' },
  { pattern: /"url":"\/plugins\//g, replacement: '"url":"/api/harness/plugins/' },
  { pattern: /src="\/plugins\//g, replacement: 'src="/api/harness/plugins/' },
  { pattern: /href="\/manifest\.webmanifest"/g, replacement: 'href="/api/harness/manifest.webmanifest"' },
  { pattern: /href="\/favicon\.svg"/g, replacement: 'href="/api/harness/favicon.svg"' }
];

function harnessPaneSessionId(rawUrl: string): string | null {
  const url = new URL(rawUrl, "http://space.local");
  const paneId = url.searchParams.get("spacePane");
  if (!paneId || !SPACE_PANE_ID_PATTERN.test(paneId)) return null;
  return `space-pane-${paneId.slice("pane:".length)}`;
}

function harnessUpstreamPath(rawUrl: string): string {
  const relative = rawUrl.replace(/^\/api\/harness/, "") || "/";
  const url = new URL(relative, "http://space.local");
  url.searchParams.delete("spacePane");
  return `${url.pathname}${url.search}`;
}

function harnessPaneStorageBootstrap(sessionId: string): string {
  const currentKey = JSON.stringify(HARNESS_CURRENT_SESSION_KEY);
  const scopedKey = JSON.stringify(`${HARNESS_CURRENT_SESSION_KEY}.${sessionId}`);
  const initialValue = JSON.stringify(JSON.stringify({ sessionId }));
  return `<script data-space-harness-pane-session>(function(){const currentKey=${currentKey};const scopedKey=${scopedKey};const realStorage=window.localStorage;realStorage.setItem(scopedKey,${initialValue});const scopedStorage=new Proxy(realStorage,{get:function(target,property){if(property==="getItem")return function(key){return target.getItem(key===currentKey?scopedKey:key);};if(property==="setItem")return function(key,value){return target.setItem(key===currentKey?scopedKey:key,value);};if(property==="removeItem")return function(key){return target.removeItem(key===currentKey?scopedKey:key);};const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;},set:function(target,property,value){return Reflect.set(target,property,value,target);}});Object.defineProperty(window,"localStorage",{configurable:true,enumerable:true,value:scopedStorage});})();</script>`;
}

function rewriteHarnessHtml(body: string, paneSessionId?: string): string {
  let out = body;
  for (const rule of HTML_REWRITE_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  if (paneSessionId) {
    const bootstrap = harnessPaneStorageBootstrap(paneSessionId);
    out = /<head(?:\s[^>]*)?>/i.test(out)
      ? out.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bootstrap}`)
      : `${bootstrap}${out}`;
  }
  return out;
}

function callHarnessRpc(target: URL, method: string, rpcPayload: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      type: "client-request",
      rpcId: `space-pane-${randomUUID()}`,
      method,
      payload: rpcPayload
    });
    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: `/api/${method}`,
        headers: {
          host: harnessLoopbackAuthority(target),
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result?: { ok?: boolean; value?: unknown } };
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300 || body.result?.ok !== true) {
              reject(new Error("Harness RPC failed."));
              return;
            }
            resolve(body.result.value);
          } catch {
            reject(new Error("Harness pane session response was invalid."));
          }
        });
      }
    );
    upstream.once("timeout", () => upstream.destroy(new Error("Harness pane session request timed out.")));
    upstream.once("error", reject);
    upstream.end(payload);
  });
}

async function ensureHarnessPaneSession(target: URL, sessionId: string, timeoutMs: number): Promise<void> {
  const workspaceResult = await callHarnessRpc(
    target,
    "workspace.create",
    { path: HARNESS_DEFAULT_WORKSPACE },
    timeoutMs
  ) as { workspace?: { workspaceId?: string } };
  const workspaceId = workspaceResult.workspace?.workspaceId;
  if (!workspaceId) throw new Error("Harness workspace creation failed.");
  const sessionResult = await callHarnessRpc(
    target,
    "session.create",
    { sessionId, workspaceId },
    timeoutMs
  ) as { sessionId?: string };
  if (sessionResult.sessionId !== sessionId) throw new Error("Harness pane session creation failed.");
}

export function isHarnessUpgradePath(rawUrl: string | undefined): boolean {
  const pathname = (rawUrl ?? "").split("?", 1)[0] ?? "";
  return (
    pathname === "/api/harness" ||
    pathname.startsWith("/api/harness/") ||
    HARNESS_WEBSOCKET_PATHS.has(pathname)
  );
}

function stripHopByHop(headerName: string): boolean {
  return !HOP_BY_HOP_HEADERS.has(headerName.toLowerCase());
}

function appendForwardedFor(existing: string | string[] | undefined, remoteAddress: string | undefined): string {
  const chain = Array.isArray(existing) ? existing.join(", ") : (existing ?? "");
  const next = remoteAddress ?? "";
  if (!chain) return next;
  if (!next) return chain;
  return `${chain}, ${next}`;
}

function harnessLoopbackAuthority(target: URL): string {
  return target.port ? `127.0.0.1:${target.port}` : "127.0.0.1";
}

function sendProxyError(reply: FastifyReply, statusCode: number, code: string, message: string): void {
  void reply.code(statusCode).send({
    error: {
      code,
      message,
      requestId: "space-api"
    }
  });
}

function buildUpstreamHeaders(
  request: FastifyRequest,
  target: URL,
  extra?: Record<string, string | string[] | number | undefined>
): http.OutgoingHttpHeaders {
  return {
    ...Object.fromEntries(
      Object.entries(request.headers)
        .filter(([name, value]) => stripHopByHop(name) && !BROWSER_TRUST_HEADERS.has(name.toLowerCase()) && value !== undefined)
    ),
    host: harnessLoopbackAuthority(target),
    "x-forwarded-host": request.headers.host ?? "",
    "x-forwarded-for": appendForwardedFor(request.headers["x-forwarded-for"], request.socket.remoteAddress),
    "x-forwarded-port": request.headers["x-forwarded-port"] ?? String(target.port),
    "x-forwarded-proto": request.headers["x-forwarded-proto"] ?? "http",
    "x-forwarded-prefix": "/api/harness",
    ...extra
  };
}

function proxyToHarness(
  request: FastifyRequest,
  reply: FastifyReply,
  target: URL,
  pathname: string,
  timeoutMs: number,
  extraHeaders?: Record<string, string | string[] | number | undefined>,
  body?: unknown,
  paneSessionId?: string
): void {
  const serializedBody =
    body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: pathname,
      headers: buildUpstreamHeaders(request, target, {
        ...(serializedBody !== undefined ? { "content-length": Buffer.byteLength(serializedBody) } : {}),
        ...extraHeaders
      }),
      timeout: timeoutMs
    },
    (upstreamResponse) => {
      const contentType = upstreamResponse.headers["content-type"];
      const isHtml =
        typeof contentType === "string" &&
        (contentType.includes("text/html") || contentType.includes("application/xhtml+xml"));

      const responseHeaders: Record<string, string | string[] | number | undefined> = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (stripHopByHop(name) && value !== undefined) {
          responseHeaders[name] = value;
        }
      }
      responseHeaders["x-frame-options"] = "SAMEORIGIN";

      if (isHtml && (request.method === "GET" || request.method === "HEAD")) {
        responseHeaders["cache-control"] = "no-store";
        const chunks: Buffer[] = [];
        upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamResponse.on("end", () => {
          if (reply.sent) return;
          const raw = Buffer.concat(chunks).toString("utf8");
          const rewritten = request.method === "HEAD" ? raw : rewriteHarnessHtml(raw, paneSessionId);
          const length = Buffer.byteLength(rewritten);
          responseHeaders["content-length"] = length;
          void reply.code(upstreamResponse.statusCode ?? 200).headers(responseHeaders).send(rewritten);
        });
        upstreamResponse.on("error", () => {
          if (!reply.sent) {
            sendProxyError(reply, 502, "HARNESS_UNAVAILABLE", "The Harness upstream is unavailable.");
          }
        });
        return;
      }

      void reply.code(upstreamResponse.statusCode ?? 502).headers(responseHeaders).send(upstreamResponse);
    }
  );

  upstream.once("timeout", () => upstream.destroy());
  upstream.once("error", () => {
    if (!reply.sent) {
      sendProxyError(reply, 502, "HARNESS_UNAVAILABLE", "The Harness upstream is unavailable.");
    }
  });

  if (serializedBody !== undefined) {
    upstream.write(serializedBody);
    upstream.end();
  } else {
    request.raw.pipe(upstream);
  }
}

function proxyHarnessUpgrade(
  app: FastifyInstance,
  config: SpaceApiConfig,
  request: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer
): void {
  if (!config.harnessEnabled) {
    clientSocket.destroy();
    return;
  }
  const target = new URL(config.harnessOrigin);
  const pathname = (request.url ?? "/").replace(/^\/api\/harness/, "");
  const upstreamHeaders = {
    ...Object.fromEntries(
      Object.entries(request.headers)
        .filter(([name, value]) => stripHopByHop(name) && value !== undefined)
    ),
    host: harnessLoopbackAuthority(target),
    origin: `${target.protocol}//${harnessLoopbackAuthority(target)}`,
    connection: "Upgrade",
    upgrade: "websocket",
    "x-forwarded-host": request.headers.host ?? "",
    "x-forwarded-for": appendForwardedFor(request.headers["x-forwarded-for"], request.socket.remoteAddress),
    "x-forwarded-port": request.headers["x-forwarded-port"] ?? String(target.port),
    "x-forwarded-proto": request.headers["x-forwarded-proto"] ?? "http",
    "x-forwarded-prefix": "/api/harness"
  };
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: "GET",
    path: pathname || "/",
    headers: upstreamHeaders,
  });

  upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    upstream.setTimeout(0);
    const responseHeaders: Record<string, string | string[] | number | undefined> = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (stripHopByHop(name) && value !== undefined) {
        responseHeaders[name] = value;
      }
    }
    clientSocket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        Object.entries(responseHeaders)
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : String(value)}\r\n`)
          .join("") +
        `\r\n`
    );
    if (Buffer.isBuffer(upstreamHead) && upstreamHead.length > 0) {
      upstreamSocket.unshift(upstreamHead);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }
  });

  upstream.once("error", (err) => {
    app.log.error({ err, path: request.url }, "harness ws upstream error");
    clientSocket.destroy();
  });
  upstream.once("timeout", () => {
    upstream.destroy();
    clientSocket.destroy();
  });
  upstream.setTimeout(config.harnessProxyTimeoutMs);

  upstream.end();
}

export function registerHarnessRoutes(app: FastifyInstance, config: SpaceApiConfig): void {
  const harnessUpgradeHandler: (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void = (
    request,
    socket,
    head
  ) => {
    proxyHarnessUpgrade(app, config, request, socket, head);
  };

  const originalUpgradeHandlers = app.server.listeners("upgrade");
  app.server.removeAllListeners("upgrade");
  app.server.on("upgrade", (request, socket, head) => {
    if (isHarnessUpgradePath(request.url)) {
      harnessUpgradeHandler(request, socket, head);
      return;
    }
    for (const handler of originalUpgradeHandlers) {
      (handler as (req: http.IncomingMessage, s: Duplex, h: Buffer) => void)(request, socket, head);
    }
  });

  app.get("/api/harness/healthz", async (_request, reply) => {
    if (!config.harnessEnabled) {
      return sendProxyError(reply, 404, "HARNESS_DISABLED", "The Harness pane is disabled.");
    }
    const target = new URL(config.harnessOrigin);
    const started = Date.now();
    const result = await new Promise<{ ok: boolean; status: number }>((resolve) => {
      const probe = http.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          method: "GET",
          path: "/",
          timeout: config.harnessHealthTimeoutMs
        },
        (probeResponse) => {
          probeResponse.resume();
          const ok = (probeResponse.statusCode ?? 500) >= 200 && (probeResponse.statusCode ?? 500) < 500;
          resolve({ ok, status: probeResponse.statusCode ?? 502 });
        }
      );
      probe.once("timeout", () => probe.destroy());
      probe.once("error", () => resolve({ ok: false, status: 502 }));
      probe.end();
    });
    return {
      ok: result.ok,
      status: result.status,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started
    };
  });

  app.all("/api/harness/*", (request, reply) => {
    if (!config.harnessEnabled) {
      return sendProxyError(reply, 404, "HARNESS_DISABLED", "The Harness pane is disabled.");
    }
    const target = new URL(config.harnessOrigin);
    const pathname = harnessUpstreamPath(request.url);
    const paneSessionId = request.method === "GET" && (new URL(pathname, target).pathname === "/" || new URL(pathname, target).pathname === "/index.html")
      ? harnessPaneSessionId(request.url)
      : null;
    if (!paneSessionId) {
      proxyToHarness(request, reply, target, pathname, config.harnessProxyTimeoutMs);
      return;
    }
    void ensureHarnessPaneSession(target, paneSessionId, config.harnessProxyTimeoutMs)
      .then(() => {
        if (!reply.sent) {
          proxyToHarness(request, reply, target, pathname, config.harnessProxyTimeoutMs, undefined, undefined, paneSessionId);
        }
      })
      .catch(() => {
        if (!reply.sent) {
          sendProxyError(reply, 502, "HARNESS_PANE_SESSION_UNAVAILABLE", "The Harness pane session is unavailable.");
        }
      });
  });

  for (const pathname of HARNESS_ROOT_HTTP_PATHS) {
    app.all(pathname, (request, reply) => {
      if (!config.harnessEnabled) {
        return sendProxyError(reply, 404, "HARNESS_DISABLED", "The Harness pane is disabled.");
      }
      const target = new URL(config.harnessOrigin);
      proxyToHarness(request, reply, target, request.url, config.harnessProxyTimeoutMs, {
        "x-forwarded-prefix": "/"
      }, request.body);
    });
  }

  app.all("/api/:method", (request, reply) => {
    if (!config.harnessEnabled) {
      return sendProxyError(reply, 404, "HARNESS_DISABLED", "The Harness pane is disabled.");
    }
    const { method } = request.params as { method: string };
    if (!method.includes(".") || method.startsWith("/") || method.includes("/")) {
      return sendProxyError(reply, 404, "NOT_FOUND", "Unknown route.");
    }
    const target = new URL(config.harnessOrigin);
    const queryIndex = request.url.indexOf("?");
    const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    proxyToHarness(request, reply, target, `/api/${method}${query}`, config.harnessProxyTimeoutMs, {
      "x-forwarded-prefix": "/api"
    }, request.body);
  });
}
