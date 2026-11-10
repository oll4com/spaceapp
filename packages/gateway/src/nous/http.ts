import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { GatewayApiKeyRecord, GatewayRequestLogInsert } from "@space/db";
import type { AccountPool } from "../accounts/account-pool.js";
import { readPresentedApiKey } from "../api-keys.js";
import { gatewayError, gatewayErrors, type GatewayErrorEnvelope } from "../errors.js";
import { geminiCostUsd, inputPrices } from "../pricing/pricing.js";
import { poolReserves, selectAccount } from "../router/balancer.js";
import { continuesAt, LAB_COST_RESERVE_MICROS, poolPressure, tenantPool, type PoolAccount } from "./lab-gateway.js";
import { admit, MICROS_PER_CREDIT, settle, type TrafficClass } from "./ledger.js";
import type { GaugeFamily, NgwMetrics } from "./metrics.js";
import type { SwitchReader, SwitchState } from "./switches.js";
import { modelProvider, nextRoute, readTaskRoutes, taskOf, type NousTask } from "./routing.js";
import type { TenantKey, TenantKeyResolver } from "./tenant-keys.js";

/**
 * NGW_MODE=nous request path (plan clipboard:_0qBSFCftZuD step 4, K5-http): an `sk-ngw-` tenant key instead of a Space Gateway key,
 * admission on the shared ledger before the proxy picks an account, and settlement from the proxy's own request-log row. The proxies
 * keep their streaming and 3-account failover; they see a per-request key scoped to the tenant's pool, with compression and the
 * output policy off. Only the routes the LBs pass are served; anything else answers 404.
 * K5-profile: Gemini goes through the tenant key too (the Antigravity pool's balanced path; the gateway adds the account token), every
 * other path of the Space Gateway (Antigravity pass-through, codex weekly-remaining, embeddings, stats ...) answers 404 before any
 * handler runs, and an error the proxies wrote never names accounts: 429 reads "Your AI continues at HH:MM UTC.", an account or
 * upstream failure 503. Admitted requests carry the tenant's own credits left (usage headers).
 */
export type TenantProvider = "CLAUDE" | "CODEX" | "GEMINI";

const ROUTES: Record<string, { provider: TenantProvider; metered: boolean }> = {
  "POST /v1/messages": { provider: "CLAUDE", metered: true },
  // Token counting costs no quota upstream; it still needs the key and stays inside the tenant's pool.
  "POST /v1/messages/count_tokens": { provider: "CLAUDE", metered: false },
  "POST /v1/responses": { provider: "CODEX", metered: true },
  "POST /v1/responses/compact": { provider: "CODEX", metered: true },
  "POST /backend-api/codex/responses": { provider: "CODEX", metered: true },
  "POST /backend-api/codex/responses/compact": { provider: "CODEX", metered: true },
  // Code Assist's model calls on the Antigravity pool; the pool's own `/antigravity/*` path stays closed (§5).
  "POST /v1internal:generateContent": { provider: "GEMINI", metered: true },
  "POST /v1internal:streamGenerateContent": { provider: "GEMINI", metered: true }
};
export const tenantRoute = (method: string, url: string) => ROUTES[`${method} ${url.split("?")[0]}`] ?? null;

/** Ledger request ids carry the tenant, so a tenant's request-log rows are found without a tenant column (deletion, §3.7). */
export const LEDGER_ID_PREFIX = "ngwreq:";
export const ledgerRequestId = (tenantId: string) => `${LEDGER_ID_PREFIX}${tenantId}:${randomUUID()}`;
export const SETTLE_GRACE_MS = 5_000;
const ROOM_FLOOR_PERCENT = 3; // selectAccount's exhaustion floor, kept only while the pool runs short before a reset (poolReserves)

/** Admission estimate: the body's size at ~4 bytes a token, priced as input, plus the Space Gateway's reserve. Null when unpriced. */
export function admissionEstimateMicros(model: string, provider: TenantProvider, bodyBytes: number): number | null {
  const tokens = Math.ceil(bodyBytes / 4);
  if (provider === "GEMINI") {
    const usd = geminiCostUsd({ promptTokens: tokens, cachedTokens: 0, outputTokens: 0, thoughtsTokens: 0 }, model);
    return usd === null ? null : Math.ceil(usd * 1e6) + LAB_COST_RESERVE_MICROS;
  }
  const prices = inputPrices(model, provider);
  return prices ? Math.ceil(tokens * prices.input) + LAB_COST_RESERVE_MICROS : null;
}

/** The paths a replica answers in NGW_MODE=nous (K5-listener): the tenant routes, the model list, health, and the admin listener's forward. */
export function onNousSurface(method: string, url: string, upgrade: boolean): boolean {
  const path = url.split("?")[0]!;
  if (tenantRoute(method, url) || (upgrade && tenantRoute("POST", url))) return true;
  if (method === "GET" && (path === "/v1/models" || path === "/health" || path === "/readyz")) return true;
  // Space's own admin routes, which accept only the per-process token the mTLS admin listener sends.
  return path.startsWith("/__space-gateway/");
}

const OWNER: Record<TenantProvider, string> = { CLAUDE: "anthropic", CODEX: "openai", GEMINI: "google" };
const GOOGLE_STATUS: Record<number, string> = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND",
  409: "ABORTED", 426: "FAILED_PRECONDITION", 429: "RESOURCE_EXHAUSTED", 503: "UNAVAILABLE" };
/** The error in the shape the route's clients parse: Anthropic's, Google's, else OpenAI's. */
const errorBody = (provider: TenantProvider | null, envelope: GatewayErrorEnvelope, status: number) =>
  provider === "CLAUDE" ? { type: "error", error: { type: envelope.error.type, message: envelope.error.message, code: envelope.error.code } }
    : provider === "GEMINI" ? { error: { code: status, message: envelope.error.message, status: GOOGLE_STATUS[status] ?? "UNKNOWN", reason: envelope.error.code } }
      : envelope;
const AI_UNAVAILABLE = gatewayError("ai_unavailable", "Your AI is not available right now. Try again in a minute.", "server_error");

export interface NousTenancyOptions {
  db: pg.Pool;
  resolver: TenantKeyResolver;
  /** This installation's region; a key of another region is refused. */
  region: string;
  pools: Record<TenantProvider, Pick<AccountPool, "accounts" | "toBalancerState">>;
  now?: () => Date;
  onError?: (error: unknown) => void;
  metrics?: NgwMetrics;
  /** Kill switches (K5-switches); without them none is on. */
  switches?: Pick<SwitchReader, "state">;
}

interface OpenRequest { key: TenantKey; pool: string; provider: TenantProvider; trafficClass: TrafficClass; estimateMicros: number }

export function createNousTenancy(options: NousTenancyOptions) {
  const now = options.now ?? (() => new Date());
  const open = new Map<string, OpenRequest>();
  let accountPools: { at: number; rows: Map<string, { pool: string; capacity: number }> } | null = null;
  const readAccountPools = async () => {
    if (!accountPools || Date.now() - accountPools.at > 5_000) {
      const rows = (await options.db.query("SELECT account_id, pool, five_hour_capacity_micros FROM ngw_account_pools")).rows;
      accountPools = { at: Date.now(), rows: new Map(rows.map((row) => [row.account_id as string, { pool: row.pool as string, capacity: Number(row.five_hour_capacity_micros) }])) };
    }
    return accountPools.rows;
  };

  let taskRoutes: { at: number; routes: Record<NousTask, string[]> } | null = null;
  const readRoutes = async () => {
    if (!taskRoutes || Date.now() - taskRoutes.at > 5_000) taskRoutes = { at: Date.now(), routes: await readTaskRoutes(options.db) };
    return taskRoutes.routes;
  };
  /** The provider accounts of a tenant pool, with each one's 5-hour capacity. */
  const poolMembers = async (provider: TenantProvider, pool: string) => {
    const [rows, records] = await Promise.all([readAccountPools(), options.pools[provider].accounts()]);
    return records.filter((account) => rows.get(account.id)?.pool === pool).map((account) => ({ account, capacity: rows.get(account.id)!.capacity }));
  };
  /**
   * Whether the balancer's own pick over the pool has room (both windows above its floor; the weekly pace picks an account with room
   * first, so a full pick means a full pool), else when the first account is back (both of its full windows reset).
   */
  const poolRoom = async (provider: TenantProvider, pool: string, members?: Awaited<ReturnType<typeof poolMembers>>) => {
    const at = now().getTime() / 1000;
    const states = (members ?? await poolMembers(provider, pool)).map(({ account }) => options.pools[provider].toBalancerState(account));
    const reserves = poolReserves(states, at, ROOM_FLOOR_PERCENT);
    const [weekFloor, fiveFloor] = [reserves.week(ROOM_FLOOR_PERCENT), reserves.fiveHour(ROOM_FLOOR_PERCENT)];
    const full = (floor: number, used?: number | null, resetAt?: number | null) => used != null && used >= 100 - floor && !(resetAt != null && resetAt <= at);
    const back = (state: (typeof states)[number]) => Math.max(full(fiveFloor, state.usedPercent, state.primaryResetAt) ? state.primaryResetAt ?? 0 : 0,
      full(weekFloor, state.secondaryUsedPercent, state.secondaryResetAt) ? state.secondaryResetAt ?? 0 : 0, state.resetAt ?? 0);
    const pick = selectAccount(states.map((state) => ({ ...state })), { now: at, weeklyPace: true, exhaustionFloorPercent: ROOM_FLOOR_PERCENT });
    const open = pick.account !== null && !full(fiveFloor, pick.account.usedPercent, pick.account.primaryResetAt) && !full(weekFloor, pick.account.secondaryUsedPercent, pick.account.secondaryResetAt);
    const returns = states.map(back).filter((value) => value > at);
    return { open, resetsAt: open ? null : pick.resetsAt ?? (returns.length ? Math.min(...returns) : null) };
  };

  const count = (provider: TenantProvider, outcome: string) =>
    options.metrics?.inc("ngw_requests_total", "Tenant requests by outcome (admitted, answered, failed, waits, route_moved, refused, unavailable).", { provider, outcome });

  /** Requests the tenancy answered itself (its texts are already the tenant's), and each admitted request's provider and pool. */
  const answered = new WeakSet<FastifyRequest>();
  const admittedTo = new WeakMap<FastifyRequest, { provider: TenantProvider; pool: string }>();

  const settleOnce = (id: string, fields: { accountId: string | null; model: string; ok: boolean; costMicros: number | null;
    tokens?: { input: number; cached: number; cacheWrite: number; output: number } }) => {
    const request = open.get(id);
    if (!request) return;
    open.delete(id);
    count(request.provider, fields.ok ? "answered" : "failed");
    // Usage the provider did not report is charged at the reservation on success, so the hard cap never misses a request.
    const costMicros = fields.costMicros ?? (fields.ok ? request.estimateMicros : 0);
    options.metrics?.inc("ngw_settled_micros_total", "List value settled on the ledger, micro-USD.", { plan: request.key.plan, provider: request.provider }, costMicros);
    void settle(options.db, { requestId: id, key: request.key, pool: request.pool, accountId: fields.accountId, provider: request.provider.toLowerCase(),
      model: fields.model, trafficClass: request.trafficClass, status: fields.ok ? "OK" : "ERROR", costMicros, now: now(),
      inputTokens: fields.tokens?.input, cachedInputTokens: fields.tokens?.cached, cacheWriteTokens: fields.tokens?.cacheWrite, outputTokens: fields.tokens?.output
    }).catch((error: unknown) => options.onError?.(error));
  };

  return {
    /** Replaces the Space Gateway key check: the key, its region, the route, then admission. Replies itself when it refuses. */
    async authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const listing = request.method === "GET" && request.url.split("?")[0] === "/v1/models";
      const route = tenantRoute(request.method, request.url);
      if (!route && !listing) return void reply.code(404).send(gatewayError("not_found", "This path is not available.", "invalid_request_error"));
      const provider = route?.provider ?? null;
      const refuse = (status: number, envelope: GatewayErrorEnvelope) => {
        if (provider) count(provider, status === 429 ? "waits" : status === 503 ? "unavailable" : "refused");
        answered.add(request);
        return void reply.code(status).send(errorBody(provider, envelope, status));
      };
      // codex-lb's answer while WebSocket is off; the Codex CLI then uses HTTP, where every turn is admitted on its own.
      if (request.headers.upgrade?.toLowerCase() === "websocket") {
        return refuse(426, gatewayError("websocket_upstream_transport_unavailable", "Upstream websocket transport is unavailable; retry over HTTP."));
      }
      const presented = readPresentedApiKey(request.headers);
      if (!presented) return refuse(401, gatewayErrors.missingApiKey());
      let key: TenantKey | null;
      try { key = await options.resolver.resolve(presented); } catch { return refuse(503, gatewayErrors.unavailable()); }
      if (!key) return refuse(401, gatewayErrors.invalidApiKey());
      if (key.region !== options.region) return refuse(403, gatewayError("wrong_region", "This key belongs to another region.", "permission_error"));
      const pool = tenantPool(key);
      let switches: SwitchState | null;
      try { switches = await options.switches?.state() ?? null; } catch { return refuse(503, gatewayErrors.unavailable()); }
      if (!route) {
        // The models the tenant's task lists name and no switch closes; room changes by the minute, so it is not a filter.
        const ids = [...new Set(Object.values(await readRoutes()).flat())].filter((id) => {
          const served = modelProvider(id);
          return served && !switches?.modelOff(id) && !switches?.providerOff(served, pool);
        });
        answered.add(request);
        return void reply.send(request.headers["anthropic-version"]
          ? { data: ids.map((id) => ({ type: "model", id, display_name: id, created_at: "1970-01-01T00:00:00Z" })), has_more: false, first_id: ids[0] ?? null, last_id: ids.at(-1) ?? null }
          : { object: "list", data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: OWNER[modelProvider(id)!] })) });
      }
      // The Antigravity path parses no JSON (its bodies go upstream byte for byte).
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = Buffer.isBuffer(request.body) ? JSON.parse(request.body.toString("utf8")) : request.body;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch { /* refused below: no model */ }
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!model) return refuse(400, gatewayError("invalid_request", "The request needs a model.", "invalid_request_error"));

      if (modelProvider(model) !== route.provider) return refuse(400, gatewayError("model_not_available", `Model '${model}' is not served on this path.`, "invalid_request_error"));
      const task = taskOf(request.headers["x-nous-task"]);
      if (!task) return refuse(400, gatewayError("invalid_request", "x-nous-task must be classify, extract, browse, reason, code or hard.", "invalid_request_error"));
      const trafficClass: TrafficClass = String(request.headers["x-nous-traffic-class"] ?? "").toUpperCase() === "BACKGROUND" ? "BACKGROUND" : "FOREGROUND";
      // Nothing of the tenant's own reaches a provider: its key and its routing hints.
      for (const name of ["authorization", "x-api-key", "x-nous-task", "x-nous-traffic-class"]) delete request.headers[name];

      let members: Awaited<ReturnType<typeof poolMembers>>;
      try { members = await poolMembers(route.provider, pool); } catch { return refuse(503, gatewayErrors.unavailable()); }
      if (route.metered) {
        if (switches?.allIncludedAiOff) {
          return refuse(503, gatewayError("included_ai_off", "Your included AI is paused. Continue on your own AI, or try again later.", "server_error"));
        }
        if (switches?.userTrafficOnly && trafficClass === "BACKGROUND") {
          reply.header("retry-after", "300");
          return refuse(429, gatewayError("background_waits", "Background work waits; your own requests continue.", "rate_limit_error"));
        }
        const switchedOff = (next: string) => Boolean(switches?.modelOff(next) || switches?.providerOff(modelProvider(next)!, pool));
        // The model's pool is closed: the worker's next turn goes to the first model of the task's list with room (409), or waits (429).
        let room: Awaited<ReturnType<typeof poolRoom>>, moved: string | null = null;
        try {
          room = switchedOff(model) ? { open: false, resetsAt: null } : await poolRoom(route.provider, pool, members);
          if (!room.open) moved = await nextRoute((await readRoutes())[task], model, async (next) => !switchedOff(next) && (await poolRoom(modelProvider(next)!, pool)).open);
        } catch {
          return refuse(503, gatewayErrors.unavailable());
        }
        if (moved) {
          const envelope = gatewayError("route_moved", `Model '${model}' has no room now; start the next turn on '${moved}'.`, "invalid_request_error");
          count(route.provider, "route_moved");
          answered.add(request);
          return void reply.code(409).send({ ...errorBody(route.provider, envelope, 409), model: moved });
        }
        if (!room.open) {
          const at = new Date(room.resetsAt !== null ? room.resetsAt * 1000 : now().getTime() + 300_000);
          reply.header("retry-after", String(Math.max(1, Math.ceil((at.getTime() - now().getTime()) / 1000))));
          return refuse(429, gatewayError("usage_limit_reached", continuesAt(at), "rate_limit_error"));
        }
      }
      const id = ledgerRequestId(key.tenantId);
      request.ngwTenantId = key.tenantId;
      admittedTo.set(request, { provider: route.provider, pool });
      request.gatewayApiKey = {
        id, name: key.tenantId, keyPrefix: key.keyPrefix, keyHash: key.keyHash, isActive: true, trafficClass: "INTERACTIVE", allowedModels: [], enforcedModel: null,
        allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountScopeEnabled: true, accountIds: members.map(({ account }) => account.id),
        compressionOverride: "OFF", outputPolicyOverride: "OFF", limits: [], expiresAt: null, lastUsedAt: null, createdAt: key.createdAt.toISOString()
      } satisfies GatewayApiKeyRecord;
      if (!route.metered) return;

      const estimateMicros = admissionEstimateMicros(model, route.provider, Number(request.headers["content-length"]) || JSON.stringify(body).length);
      if (estimateMicros === null) return refuse(400, gatewayError("model_not_available", `Model '${model}' is not available.`, "invalid_request_error"));
      const ledgerPool = `${pool}:${route.provider.toLowerCase()}`;
      const pressure = poolPressure(members.map(({ account, capacity }): PoolAccount => ({ ...options.pools[route.provider].toBalancerState(account), pool,
        provider: route.provider, fiveHourCapacityMicros: capacity })));
      let admission;
      try {
        admission = await admit(options.db, { requestId: id, key, pool: ledgerPool, trafficClass, estimateMicros, pressure, now: now() });
      } catch {
        return refuse(503, gatewayErrors.unavailable());
      }
      if (!admission.admitted) {
        if (admission.retryAt) reply.header("retry-after", String(Math.max(1, Math.ceil((admission.retryAt.getTime() - now().getTime()) / 1000))));
        return refuse(429, gatewayError("usage_limit_reached", admission.retryAt ? continuesAt(admission.retryAt) : "Your included AI is not active.", "rate_limit_error"));
      }
      open.set(id, { key, pool: ledgerPool, provider: route.provider, trafficClass, estimateMicros });
      count(route.provider, "admitted");
      // Usage headers: the tenant's own credits left after this request's reservation (raw headers reach hijacked streams too).
      const credits = (micros: number) => String(Math.max(0, Math.floor(micros / MICROS_PER_CREDIT)));
      reply.raw.setHeader("x-nous-credits-left-today", credits(admission.leftTodayMicros));
      reply.raw.setHeader("x-nous-credits-left-period", credits(admission.leftPeriodMicros));
      reply.raw.setHeader("x-nous-credits-day-resets", new Date(Math.floor(now().getTime() / 86_400_000 + 1) * 86_400_000).toISOString());
      // A request the proxy never logged (aborted before an account answered) still gives its reservation back.
      reply.raw.once("close", () => setTimeout(() => settleOnce(id, { accountId: null, model, ok: reply.raw.statusCode < 400, costMicros: null }), SETTLE_GRACE_MS).unref());
    },

    /** onRequest (K5-listener): everything outside the Nous surface answers 404 before any handler or key check runs. */
    async surface(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      if (onNousSurface(request.method, request.url, Boolean(request.headers.upgrade))) return;
      return void reply.code(404).send(gatewayError("not_found", "This path is not available.", "invalid_request_error"));
    },

    /**
     * onSend (K5-profile): an error the proxies wrote for an admitted tenant request never names accounts or their count. A limit reads
     * when the pool is back; an account's or provider's failure is the tenant's 503. Other client errors (400, 404, 413) pass as they are.
     */
    async onSend(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
      const admitted = admittedTo.get(request);
      const status = reply.statusCode;
      if (!admitted || answered.has(request) || (status !== 429 && status !== 401 && status !== 403 && status < 500)) return payload;
      reply.header("content-type", "application/json; charset=utf-8");
      if (status !== 429) return JSON.stringify(errorBody(admitted.provider, AI_UNAVAILABLE, reply.code(503).statusCode));
      let at = Number(reply.getHeader("retry-after")) > 0 ? new Date(now().getTime() + Number(reply.getHeader("retry-after")) * 1000) : null;
      if (!at) {
        const resetsAt = await poolRoom(admitted.provider, admitted.pool).then((room) => room.resetsAt, () => null);
        at = new Date(resetsAt !== null && resetsAt * 1000 > now().getTime() ? resetsAt * 1000 : now().getTime() + 300_000);
        reply.header("retry-after", String(Math.max(1, Math.ceil((at.getTime() - now().getTime()) / 1000))));
      }
      return JSON.stringify(errorBody(admitted.provider, gatewayError("usage_limit_reached", continuesAt(at), "rate_limit_error"), 429));
    },

    /** The proxies' request-log row settles the request; the row keeps the ledger id and no Space Gateway key id. */
    logRow(row: GatewayRequestLogInsert): GatewayRequestLogInsert {
      if (!row.apiKeyId?.startsWith(LEDGER_ID_PREFIX)) return row;
      if (row.status === "success" && row.firstTokenMs !== null) options.metrics?.observeFirstToken(row.provider, row.firstTokenMs / 1000);
      const cached = row.cachedInputTokens ?? 0, cacheWrite = row.cacheCreationTokens ?? 0;
      settleOnce(row.apiKeyId, { accountId: row.accountId, model: row.model, ok: row.status === "success",
        costMicros: row.costUsd === null ? null : Math.round(row.costUsd * 1e6),
        tokens: { input: Math.max(0, (row.inputTokens ?? 0) - cached - cacheWrite), cached, cacheWrite, output: row.outputTokens ?? 0 } });
      return { ...row, requestId: row.apiKeyId, apiKeyId: null };
    },

    /** Requests admitted and not settled yet (for status and metrics). */
    openRequests: () => open.size,

    /** Per pool account: 5-hour and weekly use and health, read when scraped (account ids are internal; no tenant appears). */
    async gauges(): Promise<GaugeFamily[]> {
      const rows = await readAccountPools();
      const used: GaugeFamily = { name: "ngw_account_used_percent", help: "Use of a pool account's window.", samples: [] };
      const healthy: GaugeFamily = { name: "ngw_account_healthy", help: "1 while a pool account may take requests.", samples: [] };
      for (const provider of ["CLAUDE", "CODEX", "GEMINI"] as const) {
        for (const account of await options.pools[provider].accounts()) {
          const pool = rows.get(account.id)?.pool;
          if (!pool) continue;
          const state = options.pools[provider].toBalancerState(account), labels = { pool, provider, account: account.id };
          used.samples.push({ labels: { ...labels, window: "5h" }, value: state.usedPercent ?? 0 }, { labels: { ...labels, window: "week" }, value: state.secondaryUsedPercent ?? 0 });
          healthy.samples.push({ labels, value: state.status === "ACTIVE" ? 1 : 0 });
        }
      }
      return [used, healthy, { name: "ngw_open_requests", help: "Admitted requests not settled yet.", samples: [{ labels: {}, value: open.size }] }];
    }
  };
}

export type NousTenancy = ReturnType<typeof createNousTenancy>;
