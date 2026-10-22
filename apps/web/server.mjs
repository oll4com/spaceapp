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
// The dev instance must never serve on stable's port or proxy to stable's API.
if (process.env.SPACE_INSTANCE === "dev" && (port === 4911 || !process.env.SPACE_API_ORIGIN || apiOrigin.port === "4910")) {
  console.error("Refusing to start the dev web server: SPACE_WEB_PORT and SPACE_API_ORIGIN must point at the dev instance.");
  process.exit(1);
}
const proxyPrefixes = ["/api", "/plugins", "/healthz", "/livez", "/readyz", "/version"];
const proxyPaths = new Set(["/plugins/events", "/logout"]);
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
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

// Hashed /assets/* never change under the same URL. HTML documents and the
// runtime config must never be stored (stale WebView documents pin old bundles).
// Other non-hashed scripts/data are version-coupled to the documents, so they
// are stored but revalidated on every use. Everything else in the static root
// (brand images, favicon, entry-loading.css, media, fonts) is cached for a day
// and revalidated in the background with a weak validator.
const immutableAssetCacheControl = "public, max-age=31536000, immutable";
const documentCacheControl = "no-cache, no-store, must-revalidate";
const revalidatedStaticCacheControl = "no-cache";
const staticFileCacheControl = "public, max-age=86400, stale-while-revalidate=604800";
const uncachedStaticFileNames = new Set(["homepage-config.js"]);
const revalidatedStaticExtensions = new Set([".js", ".json", ".map", ".mjs"]);

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

/** The public legal pages' contact address; anything but a plain email address is dropped. */
function safeContactEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/.test(email) ? email : null;
}

function sendHomepageConfig(request, response) {
  const body = `window.__SPACE_PUBLIC_CONFIG__=${JSON.stringify({
    discordUrl: safeDiscordInvite(process.env.SPACE_PUBLIC_DISCORD_URL),
    contactEmail: safeContactEmail(process.env.SPACE_PUBLIC_CONTACT_EMAIL)
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
  return proxyPaths.has(pathname) || proxyPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
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
  "manifest-src 'self'"
].join("; ");

// The app shell has no inline script; the YouTube player loads its IFrame API from www.youtube.com.
const operatorAppScriptPolicy = "script-src 'self' https://www.youtube.com; object-src 'none'; base-uri 'self'; report-uri /csp-report";

let cspReportWindow = { startedAt: 0, count: 0 };
/** Logs CSP violation reports (directive and blocked source only, capped) so the report-only policy can be reviewed. */
function receiveCspReport(request, response) {
  let size = 0;
  const chunks = [];
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size <= 16 * 1024) chunks.push(chunk);
  });
  request.on("end", () => {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    const now = Date.now();
    if (now - cspReportWindow.startedAt > 60_000) cspReportWindow = { startedAt: now, count: 0 };
    if (size > 16 * 1024 || ++cspReportWindow.count > 60) return;
    try {
      const report = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.["csp-report"] ?? {};
      const field = (value) => String(value ?? "").replace(/[?#].*$/, "").replace(/[^\x20-\x7e]/g, "").slice(0, 200);
      console.log(JSON.stringify({ event: "CSP_REPORT", directive: field(report["violated-directive"] ?? report["effective-directive"]),
        blocked: field(report["blocked-uri"]), page: field(report["document-uri"]), source: field(report["source-file"]) }));
    } catch {}
  });
}

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
  // The operator app: no framing by other sites (1.1.5 review F12). Its script policy is report-only until the reports
  // from every pane are clean (security addendum step 7); HSTS comes from the TLS proxy (deploy/nginx/space-oll4.conf).
  if (pathname !== "/homepage") {
    return {
      "content-security-policy": "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
      "content-security-policy-report-only": operatorAppScriptPolicy,
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "SAMEORIGIN"
    };
  }
  return {
    "content-security-policy": publicHomepageContentSecurityPolicy,
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-frame-options": "DENY"
  };
}

function staticCacheControl(filePath) {
  if (filePath.includes(`${path.sep}assets${path.sep}`)) return immutableAssetCacheControl;
  const extension = path.extname(filePath);
  if (extension === ".html" || uncachedStaticFileNames.has(path.basename(filePath))) return documentCacheControl;
  if (revalidatedStaticExtensions.has(extension)) return revalidatedStaticCacheControl;
  return staticFileCacheControl;
}

function weakStaticEtag(stats, encoding) {
  const encodingSuffix = encoding ? `-${encoding}` : "";
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}${encodingSuffix}"`;
}

function matchesIfNoneMatch(headerValue, etag) {
  if (typeof headerValue !== "string" || !headerValue.trim()) return false;
  const opaqueTag = etag.replace(/^W\//, "");
  return headerValue.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || trimmed.replace(/^W\//, "") === opaqueTag;
  });
}

function serveFile(request, response, filePath) {
  const variant = selectStaticVariant(request, filePath);
  const stats = statSync(variant.path);
  const contentType = contentTypes.get(path.extname(filePath)) ?? "application/octet-stream";
  const cacheControl = staticCacheControl(filePath);
  const etag = cacheControl === immutableAssetCacheControl || cacheControl === documentCacheControl
    ? null
    : weakStaticEtag(stats, variant.encoding);
  if (etag && matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
    response.writeHead(304, {
      "cache-control": cacheControl,
      etag,
      "vary": "Accept-Encoding",
      "x-content-type-options": "nosniff"
    });
    response.end();
    return;
  }
  const headers = {
    "cache-control": cacheControl,
    "content-length": stats.size,
    "content-type": contentType,
    "vary": "Accept-Encoding",
    "x-content-type-options": "nosniff",
    ...publicHomepageSecurityHeaders(request, filePath)
  };
  if (etag) headers.etag = etag;
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
  if (requestUrl.pathname === "/csp-report" && request.method === "POST") {
    receiveCspReport(request, response);
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
