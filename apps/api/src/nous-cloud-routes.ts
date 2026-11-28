import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { SPACE_INSTALL_ROOT, type NousCloudDay, type NousCloudInstall, type NousCloudModel, type NousCloudReport } from "@space/contracts";
import { hashGatewayApiKey, readPresentedApiKey } from "@space/gateway";
import { sendApiError } from "./http-errors.js";
import type { GatewayAdminService } from "./gateway/gateway-service.js";

/**
 * Nous Cloud telemetry (docs/agents/nous-cloud-telemetry.md): oll4.com keeps each install's events, daily usage and the provisioner's
 * latest sandbox snapshot; this reads them with the shared read key and shapes one row per install. Never returns the invite or a key.
 */
const STATS_URL = "https://oll4.com/beta/api/cloud-stats";
const KEY_FILE = join(SPACE_INSTALL_ROOT, "secrets", "space-nous-cloud-stats.key");
// The provisioner snapshots a running sandbox and posts usage every 5 minutes; two missed ticks means it sleeps.
const RUNNING_WITHIN_MS = 11 * 60_000;

type Raw = Record<string, unknown>;
const obj = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {});
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.map(obj) : []);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
/** oll4.com sends epoch seconds; the sandbox's Postgres sends ISO text. */
const iso = (value: unknown): string | null => {
  const ms = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const pair = (value: unknown) => (Array.isArray(value) && value.length === 2 && value.every((item) => num(item) != null) ? value.map(Number) as [number, number] : null);
const latest = (...values: Array<string | null>) => values.filter((value): value is string => !!value).sort().at(-1) ?? null;

/** Pure: oll4.com's cloud-stats answer → the admin view. `days` bounds the per-day rows (the sandbox reports 90 days). */
export function nousCloudView(raw: unknown, days: number, nowMs = Date.now()): NousCloudReport {
  const since = new Date(nowMs - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const installs = list(obj(raw).installs).map((row): NousCloudInstall => {
    const box = obj(row.box);
    const db = obj(box.db);
    const boxAt = iso(box.at);
    const usdPerHour = num(box.usdPerHour);
    const byDay = new Map<string, NousCloudDay>();
    const day = (d: string) => byDay.get(d) ?? byDay.set(d, { d, sandboxSeconds: 0, sandboxCostUsd: null, requests: 0, errors: 0, tokens: 0, modelCostUsd: 0, events: {} }).get(d)!;
    for (const entry of list(row.days)) {
      const d = str(entry.d);
      if (!d || d < since) continue;
      const target = day(d);
      target.sandboxSeconds = num(entry.seconds) ?? 0;
      target.events = Object.fromEntries(Object.entries(obj(entry.events)).map(([name, n]) => [name, num(n) ?? 0]));
    }
    const models = new Map<string, NousCloudModel>();
    for (const [source, rows] of [["nous", list(db.turns)], ["cli", list(db.clis)]] as const) {
      for (const entry of rows) {
        const d = str(entry.d);
        const model = str(entry.m) ?? "unknown";
        const requests = num(entry.n) ?? 0, errors = num(entry.e) ?? 0, tokens = num(entry.tk) ?? 0, cost = num(entry.c) ?? 0;
        if (!d || d < since) continue;
        const target = day(d);
        target.requests += requests; target.errors += errors; target.tokens += tokens; target.modelCostUsd += cost;
        const key = `${source}:${model}`;
        const sum = models.get(key) ?? models.set(key, { model, source, requests: 0, errors: 0, tokens: 0, costUsd: 0, free: true }).get(key)!;
        sum.requests += requests; sum.errors += errors; sum.tokens += tokens; sum.costUsd += cost;
        // shortcut: "free" means no API value was charged (free model or a connected subscription); upgrade when the sandbox reports the account kind.
        sum.free = sum.costUsd === 0;
      }
    }
    const dayRows = [...byDay.values()].sort((left, right) => right.d.localeCompare(left.d));
    for (const entry of dayRows) entry.sandboxCostUsd = usdPerHour == null ? null : entry.sandboxSeconds / 3600 * usdPerHour;
    const total = (pick: (entry: NousCloudDay) => number) => dayRows.reduce((sum, entry) => sum + pick(entry), 0);
    const lastEvent = obj(row.lastEvent), lastApp = obj(row.lastAppEvent), appError = obj(row.lastError), boxError = obj(db.lastError);
    const usageAt = lastEvent.event === "usage" ? iso(lastEvent.at) : null;
    const activeAt = latest(boxAt, usageAt);
    const revokedAt = iso(row.revoked);
    const appErrorAt = iso(appError.at), boxErrorAt = iso(boxError.at);
    const lastError = boxErrorAt && (!appErrorAt || boxErrorAt >= appErrorAt)
      ? { at: boxErrorAt, text: str(boxError.text) ?? "", source: "sandbox" as const }
      : appErrorAt ? { at: appErrorAt, text: [str(appError.reason) ?? "error", str(appError.version) && `app ${str(appError.version)}`].filter(Boolean).join(" · "), source: "app" as const } : null;
    return {
      person: num(row.person) ?? 0,
      name: str(row.name) ?? "",
      email: str(row.email) ?? "",
      status: revokedAt ? "revoked" : activeAt && nowMs - Date.parse(activeAt) <= RUNNING_WITHIN_MS ? "running" : "asleep",
      revokedAt,
      lastSeen: latest(iso(lastEvent.at), boxAt),
      app: { version: str(lastApp.version), device: str(lastApp.device), at: iso(lastApp.at), build: num(row.appVersion) },
      sandbox: boxAt ? {
        at: boxAt,
        uptimeSeconds: num(box.uptime),
        version: str(box.version),
        usdPerHour,
        dbBytes: num(db.dbBytes),
        disk: pair(box.disk) && { size: pair(box.disk)![0], used: pair(box.disk)![1] },
        memory: pair(box.mem) && { total: pair(box.mem)![0], used: pair(box.mem)![1] }
      } : null,
      lastTurn: iso(db.lastTurn),
      lastError,
      logins: num(db.logins),
      lastLogin: iso(db.lastLogin),
      models: [...models.values()].sort((left, right) => right.requests - left.requests),
      days: dayRows,
      totals: {
        sandboxSeconds: total((entry) => entry.sandboxSeconds),
        sandboxCostUsd: usdPerHour == null ? null : total((entry) => entry.sandboxCostUsd ?? 0),
        requests: total((entry) => entry.requests),
        errors: total((entry) => entry.errors),
        tokens: total((entry) => entry.tokens),
        modelCostUsd: total((entry) => entry.modelCostUsd)
      }
    };
  });
  return { at: new Date(nowMs).toISOString(), days, installs };
}

export class NousCloudUnavailableError extends Error {}

/** Reads oll4.com with the shared key; the key file missing means this instance is not set up for it. */
export async function readNousCloud(days: number, fetchImpl: typeof fetch = fetch, keyFile = KEY_FILE): Promise<NousCloudReport> {
  const key = (await readFile(keyFile, "utf8").catch(() => "")).trim();
  if (!key) throw new NousCloudUnavailableError("Nous Cloud stats key is not configured on this instance.");
  const response = await fetchImpl(`${STATS_URL}?days=${days}`, { headers: { "X-Oll4-Key": key }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new NousCloudUnavailableError(`oll4.com cloud-stats answered ${response.status}.`);
  return nousCloudView(await response.json(), days);
}

/**
 * Nous Cloud boxes reach this SpaceApp's Space Gateway here (plan clipboard:yw_pvUb_616N step 2): only /pools/space's model routes, which
 * pick the model and route (auto) within the key's own lists. The Gateway itself stays on loopback; only keys named "Nous Cloud ..." with a
 * provider list pass, so no other key of this install answers from the internet.
 */
const GATEWAY_PREFIX = "/api/nous-cloud/gateway/v1";
const PROVISION_PREFIX = "/api/nous-cloud/accounts";
const GATEWAY_ROUTES = [["POST", "messages"], ["POST", "chat/completions"], ["POST", "responses"], ["GET", "models"]] as const;
// The account-key route checks the provisioner's key itself.
export const NOUS_CLOUD_GATEWAY_PATHS = [...GATEWAY_ROUTES.map(([, path]) => `${GATEWAY_PREFIX}/${path}`), "/api/nous-cloud/accounts/:account/gateway-key"];
const FORWARD_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta", "user-agent"];
export const NOUS_CLOUD_KEY_PREFIX = "Nous Cloud ";
export type NousCloudGateway = {
  url: string;
  keyByHash: (keyHash: string) => Promise<{ name: string; isActive: boolean; expiresAt: string | null; allowedProviders?: string[] } | null>;
  service?: () => Pick<GatewayAdminService, "listApiKeys" | "createApiKey" | "regenerateApiKey" | "updateApiKey">;
};
/** The oll4-cloud provisioner's key (step 3): it alone creates, rotates and revokes an account's Gateway key. */
const PROVISION_KEY_FILE = join(SPACE_INSTALL_ROOT, "secrets", "space-nous-cloud-provision.key");
/**
 * A new account key's defaults; the admin changes each in Space Gateway > Keys. Codex: the one Space route OpenCode's chat API reaches
 * through /pools/space, never the paid Claude API key. The daily cost is a safety budget per account (micro-dollars, US$5).
 */
const NEW_KEY = { trafficClass: "BACKGROUND", allowedProviders: ["codex"], limits: [{ limitType: "COST_USD", limitWindow: "DAILY", maxValue: 5_000_000, modelFilter: null }] } as const;
const sameSecret = (given: string, expected: string) => {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return expected.length > 0 && timingSafeEqual(digest(given), digest(expected));
};

export function registerNousCloudRoutes(app: FastifyInstance, options: { routeOptions: Pick<RouteShorthandOptions, "config">; read?: typeof readNousCloud; gateway?: NousCloudGateway; fetchImpl?: typeof fetch; provisionKeyFile?: string }) {
  const read = options.read ?? readNousCloud;
  const gateway = options.gateway;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (gateway) for (const [method, path] of GATEWAY_ROUTES) {
    // The Gateway's own body limit; SSE must not be buffered by compression.
    app.route({ method, url: `${GATEWAY_PREFIX}/${path}`, ...options.routeOptions, bodyLimit: 32 * 1024 * 1024, compress: false, handler: async (request, reply) => {
      const presented = readPresentedApiKey(request.headers);
      const key = presented ? await gateway.keyByHash(hashGatewayApiKey(presented)) : null;
      if (!key?.isActive || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) || !key.name.startsWith(NOUS_CLOUD_KEY_PREFIX) || !key.allowedProviders?.length) {
        return reply.code(401).send({ type: "error", error: { type: "authentication_error", message: "Not an active Nous Cloud key of this SpaceApp." } });
      }
      const abort = new AbortController();
      reply.raw.on("close", () => { if (!reply.raw.writableFinished) abort.abort(); });
      const headers = Object.fromEntries(FORWARD_HEADERS.flatMap((name) => typeof request.headers[name] === "string" ? [[name, request.headers[name] as string]] : []));
      const answer = await fetchImpl(`${gateway.url.replace(/\/$/, "")}/pools/space/v1/${path}`, {
        method, headers: { ...headers, authorization: `Bearer ${presented}` }, signal: abort.signal,
        body: method === "GET" ? undefined : JSON.stringify(request.body ?? {})
      }).catch(() => null);
      if (!answer) return reply.code(502).send({ type: "error", error: { type: "api_error", message: "The Space Gateway is not reachable now." } });
      for (const name of ["content-type", "retry-after"]) { const value = answer.headers.get(name); if (value) reply.header(name, value); }
      reply.code(answer.status);
      return reply.send(answer.body ? Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream) : "");
    } });
  }
  const service = gateway?.service;
  if (service) {
    const keyRoute = `${PROVISION_PREFIX}/:account/gateway-key`;
    const provisioner = async (request: FastifyRequest) => {
      const expected = (await readFile(options.provisionKeyFile ?? PROVISION_KEY_FILE, "utf8").catch(() => "")).trim();
      return sameSecret(String(request.headers["x-space-provision-key"] ?? ""), expected);
    };
    const accountKey = async (account: string) => (await service().listApiKeys()).data.find((key) => key.name === `${NOUS_CLOUD_KEY_PREFIX}${account}`) ?? null;
    const accountOf = (params: unknown) => z.object({ account: z.string().regex(/^[a-z0-9]{8,64}$/) }).strict().parse(params).account;
    // Create, or rotate an existing key (its lists and limits stay as the admin set them); the plain key is in this answer only.
    app.post(keyRoute, options.routeOptions, async (request, reply) => {
      if (!await provisioner(request)) return sendApiError(reply, 401, "PROVISIONER_REQUIRED", "Only the Nous Cloud provisioner may manage account keys.");
      const account = accountOf(request.params);
      const current = await accountKey(account);
      if (current && !current.isActive) await service().updateApiKey(current.id, { isActive: true });
      const created = current ? await service().regenerateApiKey(current.id)
        : await service().createApiKey({ name: `${NOUS_CLOUD_KEY_PREFIX}${account}`, ...NEW_KEY, allowedProviders: [...NEW_KEY.allowedProviders], limits: [...NEW_KEY.limits],
          allowedModels: [], enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, outputPolicyOverride: null, expiresAt: null }, null);
      if (!created) return sendApiError(reply, 404, "KEY_NOT_FOUND", "The account's key could not be rotated.");
      return { keyId: created.key.id, plainKey: created.plainKey, path: GATEWAY_PREFIX, rotated: Boolean(current) };
    });
    // Revoke: the key stops at once and stays listed (never deleted) so its usage history remains.
    app.delete(keyRoute, options.routeOptions, async (request, reply) => {
      if (!await provisioner(request)) return sendApiError(reply, 401, "PROVISIONER_REQUIRED", "Only the Nous Cloud provisioner may manage account keys.");
      const current = await accountKey(accountOf(request.params));
      if (current?.isActive) await service().updateApiKey(current.id, { isActive: false });
      return { revoked: Boolean(current) };
    });
  }
  app.get("/api/admin/nous-cloud", options.routeOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Administrator permissions are required.");
    // Technical: the history period's maximum (history.periodDays, at most 90); the history floor lowers it to the owner's period.
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).strict().parse(request.query);
    try {
      return await read(days);
    } catch (error) {
      return sendApiError(reply, 502, "NOUS_CLOUD_UNAVAILABLE", error instanceof NousCloudUnavailableError ? error.message : "oll4.com cloud-stats could not be read now.");
    }
  });
}
