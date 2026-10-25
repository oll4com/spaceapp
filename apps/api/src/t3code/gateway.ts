import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Transform, type Readable } from "node:stream";
import { WebSocket } from "ws";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { cookieName, createCsrfToken } from "../auth.js";
import { isAllowedT3Http, parseT3GatewayPath, t3RedirectLocation, T3AssetHandles, T3GatewayError, T3_APP_CSP,
  T3_GATEWAY_SOCKET, T3_IMMUTABLE_CACHE, T3_MAX_BODY_BYTES, T3_MAX_FRAME_BYTES, T3_SHARED_ASSETS_PATH } from "./gateway-policy.js";
import { authorizeT3Pane } from "./access.js";
import { T3RpcBoundary } from "./gateway-rpc.js";

interface GatewayStore {
  getPane(id: string): unknown | Promise<unknown>;
  getRoom(id: string): unknown | Promise<unknown>;
}
export interface T3GatewayOptions {
  enabled: boolean; sessionSecret: string; store: GatewayStore;
  // Server configuration only; no browser input can select a destination.
  socketPath?: string; timeoutMs?: number; revalidateMs?: number;
  publicOrigins?: readonly string[];
  // One-round-trip pane open: the document carries its binding, CSRF token
  // and fixed upstream reads (requires the runtime revision that reads them).
  documentBootstrap?: (request: FastifyRequest, paneId: string) => Promise<{ binding: unknown; bindingError: string | null }>;
  inlineBootstrapEnabled?: () => boolean | Promise<boolean>;
  startupAssets?: () => Promise<{ app: string[]; styles: string[] }>;
}
interface InlineRead { status: 200; contentType: "application/json"; body: string }
const INLINE_READS = ["/api/auth/session", "/.well-known/t3/environment"] as const;
const INLINE_READ_LIMIT = 256 * 1024;
// JSON inside a data block: nothing may close the element or start markup.
const inlineJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
interface Scope { userId: string; paneId: string; sessionId: string; basePath: string; upstreamPath: string }
const requestHeaders = ["accept", "content-type", "content-length", "range", "if-range", "if-none-match", "if-modified-since"];
const responseHeaders = ["content-type", "content-length", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified", "vary"];

export async function registerT3Gateway(app: FastifyInstance, options: T3GatewayOptions) {
  const handles = new T3AssetHandles({ secret: options.sessionSecret }), active = new Set<() => void>();
  const socketPath = options.socketPath ?? T3_GATEWAY_SOCKET;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const validate = async (request: FastifyRequest): Promise<Scope> => {
    const parsed = parseT3GatewayPath(request.raw.url ?? request.url);
    const access = await authorizeT3Pane(request, options, parsed.paneId);
    return { ...parsed, userId: access.userId, sessionId: access.sessionId };
  };
  const identityHeaders = (scope: Scope) => ({ "x-space-user-id": scope.userId, "x-space-pane-id": scope.paneId, "x-space-session-id": scope.sessionId });
  const guard = (request: FastifyRequest, scope: Scope, stop: () => void) => {
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void validate(request).catch(stop).finally(() => { checking = false; });
    }, options.revalidateMs ?? 5_000);
    timer.unref(); active.add(stop);
    return () => { clearInterval(timer); active.delete(stop); };
  };
  const readUpstream = (scope: Scope, path: string) => new Promise<InlineRead | null>(resolve => {
    const upstream = httpRequest({ socketPath, path, method: "GET", headers: { ...identityHeaders(scope), accept: "application/json", "accept-encoding": "identity" } }, incoming => {
      const chunks: Buffer[] = []; let size = 0;
      incoming.on("data", (chunk: Buffer) => { size += chunk.length; if (size > INLINE_READ_LIMIT) { upstream.destroy(); resolve(null); } else chunks.push(chunk); });
      incoming.once("end", () => resolve(incoming.statusCode === 200 && !incoming.headers["content-encoding"] &&
        String(incoming.headers["content-type"] ?? "").startsWith("application/json") ? { status: 200, contentType: "application/json", body: Buffer.concat(chunks).toString("utf8") } : null));
      incoming.once("error", () => resolve(null));
    });
    upstream.setTimeout(Math.min(timeoutMs, 5_000), () => { upstream.destroy(); resolve(null); });
    upstream.once("error", () => resolve(null)); upstream.end();
  });
  // Only a same-origin iframe navigation of the pane document is bootstrapped
  // inline: browsers set these headers themselves, so another site cannot
  // trigger the binding open that a script would otherwise POST with CSRF.
  const documentHead = async (request: FastifyRequest, scope: Scope): Promise<string> => {
    const assets = await options.startupAssets?.().catch(() => null);
    const links = [...(assets?.app ?? []).map(file => `<link rel="modulepreload" crossorigin href="${T3_SHARED_ASSETS_PATH}${file}">`),
      ...(assets?.styles ?? []).map(file => `<link rel="preload" as="style" crossorigin href="${T3_SHARED_ASSETS_PATH}${file}">`)].join("");
    const headers = request.headers;
    if (!options.documentBootstrap || headers["sec-fetch-dest"] !== "iframe" || headers["sec-fetch-mode"] !== "navigate" ||
        headers["sec-fetch-site"] !== "same-origin" || !await Promise.resolve(options.inlineBootstrapEnabled?.() ?? false).catch(() => false)) return links;
    const csrfToken = createCsrfToken(request.cookies[cookieName], options.sessionSecret);
    if (!csrfToken) return links;
    const [opened, ...reads] = await Promise.all([options.documentBootstrap(request, scope.paneId).catch(() => ({ binding: null, bindingError: null })),
      ...INLINE_READS.map(path => readUpstream(scope, path))]);
    const responses = Object.fromEntries(INLINE_READS.flatMap((path, index) => reads[index] ? [[path.slice(1), reads[index]]] : []));
    return links + `<script type="application/json" id="space-t3-bootstrap">${inlineJson({ version: 1, csrfToken, ...opened, responses })}</script>`;
  };
  const error = (reply: FastifyReply, cause: unknown) => {
    const e = cause instanceof T3GatewayError ? cause : new T3GatewayError(502, "T3_UPSTREAM_UNAVAILABLE");
    return reply.code(e.status).header("cache-control", "no-store").send({ error: { code: e.code, message: "T3 Code request could not be completed." } });
  };

  await app.register(async child => {
    // Raw payloads retain multipart boundaries and binary bytes. This parser is
    // encapsulated to this namespace; JSON on other Space routes is unchanged.
    child.removeAllContentTypeParsers();
    child.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
    child.setErrorHandler((cause, _request, reply) => error(reply, cause));
    const scopes = new WeakMap<FastifyRequest, Scope>();
    child.addHook("onRequest", async request => { scopes.set(request, await validate(request)); });
    child.addHook("onClose", async () => { for (const stop of active) stop(); });

    child.get("/api/t3code/panes/:paneId/app/ws", { websocket: true }, (client, request) => {
      const scope = scopes.get(request)!;
      const upstream = new WebSocket(`ws+unix://${socketPath}:/ws${scope.upstreamPath.slice(3)}`, {
        headers: identityHeaders(scope), maxPayload: T3_MAX_FRAME_BYTES, perMessageDeflate: false, handshakeTimeout: timeoutMs,
      });
      const rpc = new T3RpcBoundary(handles, scope);
      let stopped = false;
      const stop = () => { if (stopped) return; stopped = true; unguard(); upstream.terminate(); client.terminate(); };
      const unguard = guard(request, scope, stop);
      // Pause receive processing until the private upgrade completes. ws still
      // enforces the shared Space 64 KiB client-frame limit.
      client.pause(); upstream.once("open", () => client.resume());
      const send = (peer: WebSocket, data: string, binary: boolean) => {
        if (peer.readyState !== WebSocket.OPEN || peer.bufferedAmount + Buffer.byteLength(data) > T3_MAX_FRAME_BYTES) { stop(); return; }
        peer.send(data, { binary }, cause => { if (cause) stop(); });
      };
      client.on("message", (data, binary) => { try {
        const forwarded = rpc.client(data.toString(), response => send(client, response, false));
        if (forwarded !== null) send(upstream, forwarded, binary);
      } catch { stop(); } });
      upstream.on("message", (data, binary) => { try { send(client, rpc.server(data.toString()), binary); } catch { stop(); } });
      for (const ws of [client, upstream]) { ws.on("error", stop); ws.once("close", stop); }
    });

    child.route({ method: ["GET", "HEAD", "POST"], url: "/api/t3code/panes/:paneId/app/*", bodyLimit: T3_MAX_BODY_BYTES,
      handler: async (request, reply) => {
        const scope = scopes.get(request)!;
        if (scope.upstreamPath === "/__space/csrf" && request.method === "GET") return reply.header("cache-control", "no-store").send({ csrfToken: createCsrfToken(request.cookies[cookieName], options.sessionSecret) });
        const handle = scope.upstreamPath.startsWith("/__space/") ? handles.resolve(scope, scope.upstreamPath, request.method) : null;
        // The in-app fetch transport scopes every request under the pane base,
        // including files resolved from the shared bundle (wasm via
        // import.meta.url); they are the upstream's own /assets files.
        const shared = /^\/api\/t3code\/assets\/([A-Za-z0-9_-][A-Za-z0-9_.-]{0,199})$/.exec(scope.upstreamPath);
        const upstreamPath = shared ? `/assets/${shared[1]}` : scope.upstreamPath;
        if (!handle && !isAllowedT3Http(request.method, upstreamPath)) throw new T3GatewayError(404, "T3_NOT_FOUND");
        // Start the document bootstrap with the upstream request, not after it.
        const head = request.method === "GET" && !handle && !/^\/(?:api|assets|__space)\//.test(scope.upstreamPath) && request.headers["sec-fetch-dest"] === "iframe"
          ? documentHead(request, scope).catch(() => "") : null;
        const headers: Record<string, string> = { ...identityHeaders(scope), "accept-encoding": "identity" };
        for (const name of requestHeaders) if (typeof request.headers[name] === "string") headers[name] = request.headers[name];
        // T3 0.1.0's orchestration reads require their protocol version; only a small number passes.
        const protocol = request.headers["x-t3-orchestration-protocol"];
        if (typeof protocol === "string" && /^[1-9][0-9]?$/.test(protocol)) headers["x-t3-orchestration-protocol"] = protocol;
        const upstream = httpRequest({ socketPath, path: handle ?? upstreamPath, method: request.method, headers });
        let finished = false, responseStarted = false;
        let response: Readable | undefined;
        const stop = () => { upstream.destroy(); response?.destroy(); if (responseStarted) reply.raw.destroy(); else if (!finished) fail(new T3GatewayError(401, "T3_SESSION_ENDED")); };
        const unguard = guard(request, scope, stop);
        const cleanup = () => { finished = true; unguard(); clearTimeout(deadline); request.raw.off("aborted", stop); reply.raw.off("close", stop); };
        const fail = (cause: unknown) => {
          if (finished) return;
          cleanup(); upstream.destroy(); response?.destroy();
          if (responseStarted) reply.raw.destroy(); else void error(reply, cause);
        };
        const deadline = setTimeout(() => fail(new T3GatewayError(504, "T3_UPSTREAM_TIMEOUT")), timeoutMs); deadline.unref();
        request.raw.once("aborted", stop); reply.raw.once("close", stop);
        upstream.once("error", () => fail(new T3GatewayError(502, "T3_UPSTREAM_UNAVAILABLE")));
        upstream.once("response", incoming => {
          response = incoming;
          void (async () => {
            await validate(request);
            const status = incoming.statusCode ?? 502;
            if (status === 101 || status >= 500 || (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity")) throw new T3GatewayError(502, "T3_UPSTREAM_INVALID");
            // Hashed client files never change; everything else is per session.
            const immutable = !handle && status === 200 && upstreamPath.startsWith("/assets/") && !incoming.headers["content-type"]?.startsWith("text/html");
            reply.code(status).header("cache-control", immutable ? T3_IMMUTABLE_CACHE : "private, no-store").header("x-content-type-options", "nosniff");
            reply.header("content-security-policy", T3_APP_CSP);
            for (const name of responseHeaders) if (incoming.headers[name] !== undefined) reply.header(name, incoming.headers[name]);
            if (incoming.headers.location) reply.header("location", t3RedirectLocation(incoming.headers.location, scope.basePath, scope.upstreamPath));
            if (handle) reply.header("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:");
            const html = !handle && incoming.headers["content-type"]?.startsWith("text/html") && request.method !== "HEAD";
            if (html) {
              const chunks: Buffer[] = []; let size = 0;
              for await (const chunk of incoming) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new T3GatewayError(502, "T3_HTML_LIMIT"); chunks.push(chunk); }
              // The entry module loads from the shared bundle path; its relative
              // imports, workers and styles follow import.meta.url there, while
              // the document, router and API calls keep this pane's base path.
              const body = Buffer.concat(chunks).toString("utf8").replace(/(\s(?:src|href)=["'])\.\/assets\//g, `$1${T3_SHARED_ASSETS_PATH}`);
              if (!body.includes("<head>")) throw new T3GatewayError(502, "T3_HTML_INVALID");
              const hashes = [...body.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
                .filter(match => match[1]?.trim()).map(match => `'sha256-${createHash("sha256").update(match[1]!).digest("base64")}'`);
              if (hashes.length) reply.header("content-security-policy", String(reply.getHeader("content-security-policy")).replace("script-src 'self'", `script-src 'self' ${hashes.join(" ")}`));
              const extra = head ? await head : "";
              reply.removeHeader("content-length"); cleanup(); void reply.send(body.replace("<head>", () => `<head><base href="${scope.basePath}">${extra}`)); return;
            }
            clearTimeout(deadline);
            // After headers, enforce an idle timeout rather than truncating a
            // healthy long download. pipe propagates socket backpressure.
            incoming.setTimeout(timeoutMs, () => fail(new T3GatewayError(504, "T3_UPSTREAM_TIMEOUT")));
            incoming.once("error", () => fail(new T3GatewayError(502, "T3_UPSTREAM_UNAVAILABLE")));
            reply.raw.once("finish", cleanup); responseStarted = true;
            reply.hijack();
            for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
            reply.raw.writeHead(status); incoming.pipe(reply.raw);
          })().catch(fail);
        });
        if (request.method === "POST") {
          let bytes = 0;
          const limit = new Transform({ transform(chunk, _encoding, done) {
            bytes += chunk.length; done(bytes > T3_MAX_BODY_BYTES ? new T3GatewayError(413, "T3_BODY_LIMIT") : null, chunk);
          } });
          limit.once("error", fail);
          const body = (request.body ?? request.raw) as Readable;
          body.once("error", fail); body.pipe(limit).pipe(upstream);
        } else upstream.end();
        return reply;
      },
    });
  });
}
