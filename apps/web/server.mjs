#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.SPACE_WEB_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.SPACE_WEB_PORT ?? "4911", 10);
const distDir = path.resolve(process.env.SPACE_WEB_DIST ?? path.join(__dirname, "dist"));
const apiOrigin = new URL(process.env.SPACE_API_ORIGIN ?? "http://127.0.0.1:4910");
const proxyPrefixes = ["/api", "/healthz", "/readyz", "/version"];
const retryableProxyMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const configuredRecoveryWindowMs = Number.parseInt(process.env.SPACE_API_RECOVERY_WINDOW_MS ?? "10000", 10);
const apiRecoveryWindowMs = process.env.NODE_ENV === "test" && Number.isFinite(configuredRecoveryWindowMs) && configuredRecoveryWindowMs > 0
  ? configuredRecoveryWindowMs
  : 10_000;
let apiReadinessFlight = null;

function safeDiscordInvite(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const isShortInvite = url.hostname === "discord.gg" && pathSegments.length === 1;
    const isCanonicalInvite = url.hostname === "discord.com" && pathSegments.length === 2 && pathSegments[0] === "invite";
    return isShortInvite || isCanonicalInvite ? url.toString() : null;
  } catch {
    return null;
  }
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"]
]);

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  response.end(JSON.stringify(payload));
}

function sendHomepageConfig(request, response) {
  const body = `window.__SPACE_PUBLIC_CONFIG__=${JSON.stringify({
    discordUrl: safeDiscordInvite(process.env.SPACE_PUBLIC_DISCORD_URL)
  })};\n`;
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "text/javascript; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff"
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function shouldProxy(pathname) {
  return proxyPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function appendForwardedFor(existing, remoteAddress) {
  const chain = Array.isArray(existing) ? existing.join(", ") : (existing ?? "");
  const next = remoteAddress ?? "";
  if (!chain) return next;
  if (!next) return chain;
  return `${chain}, ${next}`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function probeApiReadiness(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const probe = http.request(
      {
        protocol: apiOrigin.protocol,
        hostname: apiOrigin.hostname,
        port: apiOrigin.port,
        method: "GET",
        path: "/readyz",
        headers: { host: apiOrigin.host },
        timeout: timeoutMs
      },
      (probeResponse) => {
        const ready = (probeResponse.statusCode ?? 500) >= 200 && (probeResponse.statusCode ?? 500) < 300;
        probeResponse.resume();
        probeResponse.once("end", () => finish(ready));
        probeResponse.once("error", () => finish(false));
      }
    );
    probe.once("timeout", () => probe.destroy());
    probe.once("error", () => finish(false));
    probe.end();
  });
}

async function runApiReadinessFlight(deadlineAt) {
  let backoffMs = 50;
  while (Date.now() < deadlineAt) {
    const remainingMs = deadlineAt - Date.now();
    if (await probeApiReadiness(Math.max(1, Math.min(500, remainingMs)))) return true;
    const delayMs = Math.min(backoffMs, Math.max(0, deadlineAt - Date.now()));
    if (delayMs > 0) await sleep(delayMs);
    backoffMs = Math.min(backoffMs * 2, 1_000);
  }
  return false;
}

function waitForApiReadiness(deadlineAt) {
  if (apiReadinessFlight) return apiReadinessFlight;
  const flight = runApiReadinessFlight(deadlineAt);
  apiReadinessFlight = flight;
  void flight.finally(() => {
    if (apiReadinessFlight === flight) apiReadinessFlight = null;
  });
  return flight;
}

function sendUpstreamUnavailable(response) {
  sendJson(response, 502, {
    error: {
      code: "UPSTREAM_UNAVAILABLE",
      message: "Space API is not reachable from the web server.",
      requestId: "space-web"
    }
  });
}

function proxyRequest(request, response, requestUrl) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value;
    }
  }
  headers.host = apiOrigin.host;
  headers["x-forwarded-host"] = request.headers.host ?? "";
  headers["x-forwarded-for"] = appendForwardedFor(request.headers["x-forwarded-for"], request.socket.remoteAddress);
  headers["x-forwarded-port"] = request.headers["x-forwarded-port"] ?? "";
  headers["x-forwarded-proto"] = request.headers["x-forwarded-proto"] ?? "http";

  const retryable = retryableProxyMethods.has(request.method ?? "GET");
  const recoveryDeadline = retryable ? Date.now() + apiRecoveryWindowMs : 0;

  const attempt = (isInitialAttempt) => {
    if (response.destroyed || response.writableEnded) return;
    let upstreamResponded = false;
    const upstream = http.request(
      {
        protocol: apiOrigin.protocol,
        hostname: apiOrigin.hostname,
        port: apiOrigin.port,
        method: request.method,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        headers
      },
      (upstreamResponse) => {
        upstreamResponded = true;
        if (response.destroyed || response.writableEnded) {
          upstreamResponse.destroy();
          return;
        }
        const responseHeaders = {};
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) {
            responseHeaders[name] = value;
          }
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(response);
      }
    );

    upstream.once("error", async () => {
      if (upstreamResponded || response.headersSent) {
        response.destroy();
        return;
      }
      if (!retryable || Date.now() >= recoveryDeadline) {
        sendUpstreamUnavailable(response);
        return;
      }
      const ready = await waitForApiReadiness(recoveryDeadline);
      if (!ready || Date.now() > recoveryDeadline) {
        if (!response.destroyed && !response.writableEnded) sendUpstreamUnavailable(response);
        return;
      }
      attempt(false);
    });

    if (isInitialAttempt) {
      request.pipe(upstream);
    } else {
      upstream.end();
    }
  };

  attempt(true);
}

function rejectUpgrade(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function proxyUpgrade(request, socket, head, requestUrl) {
  const port = Number.parseInt(apiOrigin.port || "80", 10);
  const upstreamSocket = net.connect({ host: apiOrigin.hostname, port }, () => {
    const headers = {
      ...request.headers,
      host: apiOrigin.host,
      "x-forwarded-host": request.headers.host ?? "",
      "x-forwarded-for": appendForwardedFor(request.headers["x-forwarded-for"], request.socket.remoteAddress),
      "x-forwarded-port": request.headers["x-forwarded-port"] ?? "",
      "x-forwarded-proto": request.headers["x-forwarded-proto"] ?? "http"
    };
    const headerLines = Object.entries(headers)
      .filter(([, value]) => value !== undefined)
      .flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`]);
    upstreamSocket.write([
      `${request.method} ${requestUrl.pathname}${requestUrl.search} HTTP/${request.httpVersion}`,
      ...headerLines,
      "",
      ""
    ].join("\r\n"));
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstreamSocket.on("error", () => {
    rejectUpgrade(socket, 502, "Bad Gateway");
  });
  socket.on("error", () => {
    upstreamSocket.destroy();
  });
}

function resolveStaticPath(pathname) {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    return null;
  }
  const resolved = path.resolve(distDir, `.${decoded}`);
  if (resolved !== distDir && !resolved.startsWith(`${distDir}${path.sep}`)) {
    return null;
  }
  return resolved;
}

function isAssetPath(pathname) {
  return pathname === "/assets" || pathname.startsWith("/assets/");
}

function isResolvedAssetPath(filePath) {
  const assetsDir = path.join(distDir, "assets");
  return filePath === assetsDir || filePath.startsWith(`${assetsDir}${path.sep}`);
}

function acceptedEncodingQuality(headerValue, encoding) {
  const values = String(headerValue ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  let wildcardQuality = 0;
  for (const value of values) {
    const [name, ...parameters] = value.split(";").map((part) => part.trim());
    const qualityParameter = parameters.find((parameter) => parameter.startsWith("q="));
    const parsedQuality = qualityParameter ? Number.parseFloat(qualityParameter.slice(2)) : 1;
    const quality = Number.isFinite(parsedQuality) ? Math.max(0, Math.min(1, parsedQuality)) : 0;
    if (name === encoding) return quality;
    if (name === "*") wildcardQuality = quality;
  }
  return wildcardQuality;
}

function selectStaticVariant(request, filePath) {
  const candidates = [
    { encoding: "br", path: `${filePath}.br`, priority: 2 },
    { encoding: "gzip", path: `${filePath}.gz`, priority: 1 }
  ]
    .map((candidate) => ({
      ...candidate,
      quality: acceptedEncodingQuality(request.headers["accept-encoding"], candidate.encoding)
    }))
    .filter((candidate) => candidate.quality > 0 && existsSync(candidate.path))
    .sort((left, right) => right.quality - left.quality || right.priority - left.priority);
  return candidates[0] ?? { encoding: null, path: filePath };
}

const publicHomepageContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'self' https://www.youtube.com",
  "form-action 'self'",
  "script-src 'self' https://www.youtube.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src https://coderadio-admin-v2.freecodecamp.org",
  "connect-src 'self' https://coderadio-admin-v2.freecodecamp.org",
  "worker-src 'self' blob:",
  "manifest-src 'self'"
].join("; ");

const demoWorkspaceContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "frame-src 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'none'",
  "connect-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'"
].join("; ");

function publicHomepageSecurityHeaders(request, filePath) {
  if (path.extname(filePath) !== ".html") return {};
  const pathname = new URL(request.url ?? "/", "http://space.local").pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/demo-workspace") {
    return {
      "content-security-policy": demoWorkspaceContentSecurityPolicy,
      "cross-origin-opener-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-frame-options": "SAMEORIGIN"
    };
  }
  if (pathname !== "/homepage") return {};
  return {
    "content-security-policy": publicHomepageContentSecurityPolicy,
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-frame-options": "DENY"
  };
}

function serveFile(request, response, filePath) {
  const variant = selectStaticVariant(request, filePath);
  const stats = statSync(variant.path);
  const contentType = contentTypes.get(path.extname(filePath)) ?? "application/octet-stream";
  const cacheControl = filePath.includes(`${path.sep}assets${path.sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  const headers = {
    "cache-control": cacheControl,
    "content-length": stats.size,
    "content-type": contentType,
    "vary": "Accept-Encoding",
    "x-content-type-options": "nosniff",
    ...publicHomepageSecurityHeaders(request, filePath)
  };
  if (variant.encoding) headers["content-encoding"] = variant.encoding;
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(variant.path).pipe(response);
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://space.local");
  if (
    (requestUrl.pathname === "/app" || requestUrl.pathname === "/app/") &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    response.writeHead(308, {
      "cache-control": "no-store",
      location: `/${requestUrl.search}`
    });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/homepage-config.js" && (request.method === "GET" || request.method === "HEAD")) {
    sendHomepageConfig(request, response);
    return;
  }
  if (shouldProxy(requestUrl.pathname)) {
    proxyRequest(request, response, requestUrl);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 404, {
      error: {
        code: "NOT_FOUND",
        message: "The requested route does not exist.",
        requestId: "space-web"
      }
    });
    return;
  }

  const staticPath = resolveStaticPath(requestUrl.pathname);
  const staticFileExists = staticPath && existsSync(staticPath) && statSync(staticPath).isFile();
  if (isAssetPath(requestUrl.pathname) && (!staticFileExists || !isResolvedAssetPath(staticPath))) {
    sendJson(
      response,
      404,
      {
        error: {
          code: "ASSET_NOT_FOUND",
          message: "The requested Space asset does not exist.",
          requestId: "space-web"
        }
      },
      {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    );
    return;
  }

  const filePath = staticFileExists ? staticPath : path.join(distDir, "index.html");

  if (!existsSync(filePath)) {
    sendJson(response, 503, {
      error: {
        code: "WEB_BUILD_MISSING",
        message: "Run npm run build -w @space/web before starting the web server.",
        requestId: "space-web"
      }
    });
    return;
  }

  serveFile(request, response, filePath);
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      service: "space-web",
      host,
      port,
      distDir,
      apiOrigin: apiOrigin.origin
    })
  );
});

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", "http://space.local");
  if (!shouldProxy(requestUrl.pathname)) {
    rejectUpgrade(socket, 404, "Not Found");
    return;
  }
  proxyUpgrade(request, socket, head, requestUrl);
});
