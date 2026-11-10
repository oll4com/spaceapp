import { captureSentryException, createSentryTrace, type SentryTrace } from "@space/contracts/sentry-node";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { GatewayRepository, GatewayApiKeyRecord } from "@space/db";
import { hashGatewayApiKey, readPresentedApiKey } from "./api-keys.js";
import { gatewayErrors } from "./errors.js";
import { lanDecision, type LanAccess } from "./lan-access.js";
import { trackKeyRequest } from "./policy.js";
import { clientRequestId } from "./proxy-util.js";

export interface GatewayRuntimeStatus {
  version: string;
  startedAt: string;
  inFlightRequests: number;
  draining: boolean;
  listen: string | null;
  /** The LAN listener, when other internal machines may connect. */
  lanListen: string | null;
  credentialKey: "PRESENT" | "MISSING";
  /** Requests in flight per account (ids only). */
  inFlightByAccount: Record<string, number>;
  /** Headroom live activity: open client WebSockets, upstream relay tasks and queued compression jobs. */
  activeWebSockets: number;
  relayTasks: number;
  compressionQueue: number;
}

export interface GatewayLiveActivity {
  inFlightByAccount(): Record<string, number>;
  activeWebSockets?(): number;
  relayTasks?(): number;
  compressionQueue?(): number;
}

export interface GatewayRouteHelpers {
  /** Validates the presented gateway key; on failure it has already replied and returns false. */
  authenticate(request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  isDraining(): boolean;
  /** Safe per-model correlation, distinct from the HTTP/upgrade transport event. */
  logModelRequest(request: FastifyRequest, trace: { requestId: string; nativeTurnId: string }): void;
}

export interface GatewayServerOptions {
  repository: GatewayRepository;
  /** Provider routes (Codex, Claude, ...) registered ahead of the codex-lb-compatible catch-all. */
  routes?: (app: FastifyInstance, helpers: GatewayRouteHelpers) => void;
  version: string;
  credentialKeyPresent: () => boolean;
  /** Connections that do not arrive on loopback need this: an allowed source, and a proxy route. */
  lan?: LanAccess | null;
  live?: GatewayLiveActivity;
  now?: () => Date;
  logger?: boolean;
  /** Safe API correlation line; no URL, query, headers, credentials or body (OBS-006). */
  requestLog?: (record: { event: "gateway.request"; reqId: string; method: string }
    | { event: "gateway.model_request"; reqId: string; transportRequestId: string; nativeTurnId: string }) => void;
  /** Requests one API key may start per minute (default 1200). */
  keyRequestsPerMinute?: number;
  /** NGW_MODE=nous: tenant keys and the shared ledger replace the Space Gateway key check (nous/http.ts). */
  tenancy?: { authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** onRequest: the paths NGW_MODE=nous answers at all. */
    surface?(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** onSend: rewrites what a proxy answered a tenant (errors that would name accounts). */
    onSend?(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> };
}

export interface GatewayServer {
  app: FastifyInstance;
  status(): GatewayRuntimeStatus;
  /** Stops admitting proxy requests; in-flight requests finish. */
  startDraining(): void;
  inFlight(): number;
  setListen(address: string): void;
  setLanListen(address: string | null): void;
}

/** Proxy route prefixes served by codex-lb today; Space Gateway answers on the same paths. */
export const gatewayProxyPrefixes = ["/v1", "/backend-api/codex", "/backend-api/transcribe"] as const;

declare module "fastify" {
  interface FastifyRequest {
    gatewayApiKey?: GatewayApiKeyRecord;
    /** NGW_MODE=nous: the tenant the request's key belongs to; sticky bindings are scoped by it. */
    ngwTenantId?: string;
  }
}

export function createGatewayServer(options: GatewayServerOptions): GatewayServer {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  // 32 MiB, Anthropic's own request cap; the images route sets its own limit.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 32 * 1024 * 1024, trustProxy: false,
    requestIdHeader: false, genReqId: (request) => clientRequestId(request) ?? `req_${randomUUID().replace(/-/g, "")}` });
  const sentryTraces = new WeakMap<object, SentryTrace>();
  app.addHook("onRequest", async (request, reply) => {
    const trace = createSentryTrace(request.headers.traceparent);
    sentryTraces.set(request, trace);
    reply.header("traceparent", `00-${trace.trace_id}-${trace.span_id}-00`);
  });
  app.addHook("onError", async (request, _reply, error) => {
    if (!error.statusCode || error.statusCode >= 500) captureSentryException(error, sentryTraces.get(request));
  });
  const keyRequestsPerMinute = options.keyRequestsPerMinute ?? 1200;
  const keyWindows = new Map<string, { startedAt: number; count: number }>();
  let inFlight = 0;
  let draining = false;
  let listen: string | null = null;
  let lanListen: string | null = null;

  app.addHook("onRequest", async (request, reply) => {
    // Normalize once, before authentication or a proxy reads/forwards the header. Fastify's logger owns this same id.
    request.headers["x-request-id"] = request.id;
    reply.raw.setHeader("x-request-id", request.id); // Includes hijacked streams and early errors.
    try { options.requestLog?.({ event: "gateway.request", reqId: request.id, method: request.method }); }
    catch { /* Logging must not change a model request's outcome. */ }
  });

  // Counted until the response closes: onResponse never runs for a stream the client aborted. WebSocket upgrades
  // are counted as live activity instead.
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.upgrade?.toLowerCase() === "websocket") return;
    inFlight += 1;
    reply.raw.once("close", () => { inFlight = Math.max(0, inFlight - 1); });
  });
  if (options.tenancy?.surface) app.addHook("onRequest", options.tenancy.surface);
  if (options.tenancy?.onSend) app.addHook("onSend", options.tenancy.onSend);
  app.addHook("onRequest", async (request, reply) => {
    const decision = lanDecision(request.socket.localAddress, request.socket.remoteAddress, request.url, options.lan);
    if (decision === "forbidden") return reply.code(403).header("connection", "close").send(gatewayErrors.sourceNotAllowed());
    if (decision === "not_found") return reply.code(404).send(gatewayErrors.lanRouteNotFound());
  });

  app.get("/health", async () => ({ status: draining ? "draining" : "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await options.repository.getSettings();
      return { status: draining ? "draining" : "ready" };
    } catch {
      return reply.code(503).send({ status: "storage_unavailable" });
    }
  });

  const status = (): GatewayRuntimeStatus => ({
    version: options.version,
    startedAt,
    inFlightRequests: inFlight,
    draining,
    listen,
    lanListen,
    credentialKey: options.credentialKeyPresent() ? "PRESENT" : "MISSING",
    inFlightByAccount: options.live?.inFlightByAccount() ?? {},
    activeWebSockets: options.live?.activeWebSockets?.() ?? 0,
    relayTasks: options.live?.relayTasks?.() ?? 0,
    compressionQueue: options.live?.compressionQueue?.() ?? 0
  });

  /** Non-sensitive runtime state for the Space API; it never includes keys, tokens or account data. */
  // Left open on loopback (security addendum step 8 review): it carries no keys, tokens, emails or labels, and dev's API
  // reads the shared gateway with a different internal token.
  // NGW_MODE=nous serves it only on the mTLS admin listener (nous/admin.ts).
  if (!options.tenancy) app.get("/__space-gateway/status", async () => status());

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    if (draining) return reply.code(503).header("connection", "close").header("retry-after", "1").send(gatewayErrors.draining());
    if (options.tenancy) return options.tenancy.authenticate(request, reply);
    const presented = readPresentedApiKey(request.headers);
    if (!presented) return reply.code(401).send(gatewayErrors.missingApiKey());
    let key: GatewayApiKeyRecord | null;
    try {
      key = await options.repository.findApiKeyByHash(hashGatewayApiKey(presented));
    } catch {
      return reply.code(503).send(gatewayErrors.unavailable());
    }
    if (!key) return reply.code(401).send(gatewayErrors.invalidApiKey());
    if (!key.isActive) return reply.code(401).send(gatewayErrors.inactiveApiKey());
    if (key.expiresAt && Date.parse(key.expiresAt) <= now().getTime()) return reply.code(401).send(gatewayErrors.expiredApiKey());
    const at = now().getTime();
    let window = keyWindows.get(key.id);
    if (!window || at - window.startedAt >= 60_000) keyWindows.set(key.id, window = { startedAt: at, count: 0 });
    if (++window.count > keyRequestsPerMinute) {
      return reply.code(429).header("retry-after", String(Math.max(1, Math.ceil((window.startedAt + 60_000 - at) / 1000))))
        .send(gatewayErrors.keyRateLimited());
    }
    request.gatewayApiKey = key;
    // Running requests hold a cost-cap reserve until they close; a long-lived WebSocket session holds none.
    if (request.headers.upgrade?.toLowerCase() !== "websocket") reply.raw.once("close", trackKeyRequest(key.id));
  }

  options.routes?.(app, {
    async authenticate(request, reply) {
      await authenticate(request, reply);
      return !reply.sent;
    },
    isDraining: () => draining,
    logModelRequest(request, trace) {
      try { options.requestLog?.({ event: "gateway.model_request", reqId: trace.requestId, transportRequestId: request.id, nativeTurnId: trace.nativeTurnId }); }
      catch { /* Observability never changes a model request outcome. */ }
    }
  });

  for (const prefix of gatewayProxyPrefixes) {
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      await authenticate(request, reply);
      if (reply.sent) return reply;
      // Provider adapters attach here; until an account pool serves the route, answer like codex-lb with no accounts.
      return reply.code(503).send(gatewayErrors.noAccounts());
    };
    app.all(prefix, handler);
    app.all(`${prefix}/*`, handler);
  }

  return {
    app,
    status,
    startDraining() { draining = true; },
    inFlight: () => inFlight,
    setListen(address) { listen = address; },
    setLanListen(address) { lanListen = address; }
  };
}
