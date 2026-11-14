import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { LINK_ROUTE_SCOPES, nousLoadRangeSchema, vaultBase64url as b64, type MobileRouteRule, type NousLoad } from "@space/contracts";
import { InMemoryInstanceLinkRepository, PostgresInstanceLinkRepository, type InstanceLinkAccessKeys, type InstanceLinkRecord } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { ConnectorError, connectorSealContext, type ConnectorCrypto } from "../dot-connectors.js";
import { sendApiError } from "../http-errors.js";
import { recordAudit } from "../request-audit.js";
import { connectInstanceLink, InstanceLinkError, pairInstanceLink, type InstanceLinkSession } from "./client.js";

// Space Link (ADR-014, docs/agents/instance-links.md): the SpaceApps this one's Nous manages. A person only (Settings), never a phone, a
// proof, automation or broker session; USER accounts never reach /api/instance-links (owned-resource-access.ts denies by default).

const vaultKeyId = z.string().regex(/^vault_key:[A-Za-z0-9_-]{8,64}$/);
// `access`: the Vault key ids of a Cloudflare Access service token in front of that SpaceApp's channel (a Service Auth policy, never a bypass).
const pairSchema = z.object({ code: z.string().trim().min(1).max(4000), access: z.object({ clientId: vaultKeyId, clientSecret: vaultKeyId }).strict().optional() }).strict();
const view = (link: InstanceLinkRecord, live: boolean) => ({ id: link.id, label: link.label, origins: link.origins, deviceId: link.deviceId, scopes: link.scopes,
  access: link.accessKeys, createdAt: link.createdAt, lastSeenAt: link.lastSeenAt, connected: live });
export type InstanceLinkView = ReturnType<typeof view>;
/** A linked SpaceApp's last overview (its own GET /api/nous/overview), as this side read it. */
export type PeerReading = { link: InstanceLinkView; overview: unknown; at: string | null; error: string | null };
export type InstanceLinkAnswer = { link: InstanceLinkView; scopes: string[]; status: number; body: unknown; rttMs: number };

/**
 * The other side's rule for `method path` (LINK_ROUTE_SCOPES), or null: this side sends nothing else. A path parameter is an id
 * (letters, digits, _ : -), so no dot segment or encoded byte reaches the other side; it checks the same table again.
 */
export function linkRoute(method: string, path: string): MobileRouteRule | null {
  const [pathname] = path.split("?");
  const key = Object.keys(LINK_ROUTE_SCOPES).find((entry) => {
    const [verb, pattern] = entry.split(" ");
    return verb === method && new RegExp(`^${pattern!.replace(/:[A-Za-z]+/g, "[A-Za-z0-9_:-]+")}$`).test(pathname!);
  });
  return key ? LINK_ROUTE_SCOPES[key]! : null;
}

/** What Nous reaches (space_instances, space_remote): the owner's links, and one request into one of them. */
export interface InstanceLinks {
  list(owner: string): Promise<InstanceLinkView[]>;
  /** `ref` is the link's id or its label when no other link has it. Throws InstanceLinkError when it is not linked or the route is not a link's. */
  request(owner: string, ref: string, method: "GET" | "POST", path: string, body?: unknown): Promise<InstanceLinkAnswer>;
  /** Each link's last overview for Nous's world (Λ6). Never waits for a link: an older reading is read again in the background. */
  peers(owner: string): Promise<PeerReading[]>;
}
// Technical bound (the other side's load): its overview builds its whole world, so a link is read at most once a minute however many turns run.
const PEER_READ_MS = 60_000;
const services = new WeakMap<object, InstanceLinks>();
/** The store's linked SpaceApps (Nous's tools find them through the store they share, as appointmentsFor does). */
export const instanceLinksFor = (store: object) => services.get(store);

export function registerInstanceLinks(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "recordAuditEvent" | "upsertUser" | "listAuditEventsSince">; crypto: ConnectorCrypto; databaseUrl: string | null | undefined;
  routeOptions: Pick<RouteShorthandOptions, "config">; assertPerson: (request: FastifyRequest) => void; version: string;
  /** A kept Vault key's value of the owner (null when it is not a kept key with a value): a link's Access service token. */
  vaultKey?: (owner: string, id: string) => Promise<string | null>;
}) {
  const repository = options.databaseUrl ? PostgresInstanceLinkRepository.fromConnectionString(options.databaseUrl) : new InMemoryInstanceLinkRepository();
  const sealContext = (link: Pick<InstanceLinkRecord, "id" | "ownerUserId">) => connectorSealContext("instance-link", link.ownerUserId, link.id);
  // One open session per link, reused while it stays open; the other side ends it after 24 h and the next request connects again.
  const sessions = new Map<string, Promise<InstanceLinkSession>>();
  const live = (id: string) => sessions.has(id);
  app.addHook("onClose", async () => {
    for (const pending of sessions.values()) void pending.then((session) => session.close(), () => undefined);
    await repository.dispose();
  });

  // The values are read from the Vault for each connect and go only into the WebSocket's headers: never stored, logged or answered.
  async function accessHeaders(owner: string, keys: InstanceLinkAccessKeys | null): Promise<Record<string, string>> {
    if (!keys) return {};
    const ids = [keys.clientId, keys.clientSecret];
    const values = await Promise.all(ids.map(async (key) => (await options.vaultKey?.(owner, key)) ?? null));
    const missing = ids.filter((_, index) => !values[index]);
    if (missing.length) throw new ConnectorError(409, "VAULT_KEY_UNAVAILABLE", `The Vault has no kept value for ${missing.join(" and ")}; keep it in Vault > Keys.`);
    return { "CF-Access-Client-Id": values[0]!, "CF-Access-Client-Secret": values[1]! };
  }

  async function session(link: InstanceLinkRecord): Promise<InstanceLinkSession> {
    const cached = sessions.get(link.id);
    if (cached) {
      const open = await cached.catch(() => null);
      if (open && !open.closed()) return open;
      if (sessions.get(link.id) === cached) sessions.delete(link.id);
    }
    const pending = (async () => {
      const devicePrivate = b64.decode(options.crypto.open(link.sealedDevicePrivate, sealContext(link)));
      const opened = await connectInstanceLink({ ...link, devicePrivate }, options.version, await accessHeaders(link.ownerUserId, link.accessKeys));
      await repository.seen(link.id, { atIso: new Date().toISOString(), scopes: opened.scopes, ...opened.rotated });
      return opened;
    })();
    sessions.set(link.id, pending);
    pending.catch(() => { if (sessions.get(link.id) === pending) sessions.delete(link.id); });
    return pending;
  }

  async function call(link: InstanceLinkRecord, method: "GET" | "POST", path: string, body?: unknown): Promise<InstanceLinkAnswer> {
    // An act is audited here and on the other side under one trace id (Λ4); reads are not (Load reads every 30 s).
    const requestId = linkRoute(method, path)?.scope === "read" ? undefined : `lnk:${b64.encode(randomBytes(12))}`;
    let status: number | null = null;
    try {
      const open = await session(link);
      const started = Date.now();
      const answer = await open.request(method, path, body, requestId);
      status = answer.status;
      return { link: view((await repository.get(link.ownerUserId, link.id)) ?? link, true), scopes: open.scopes, rttMs: Date.now() - started, ...answer };
    } finally {
      if (requestId) await Promise.resolve(options.store.recordAuditEvent({ actorUserId: link.ownerUserId, traceId: requestId, action: "instance_link.request",
        targetType: "instance_link", targetId: link.id, metadata: { via: "link-out", method, path: path.split("?")[0], status, label: link.label } })).catch(() => undefined);
    }
  }
  const readings = new Map<string, Omit<PeerReading, "link"> & { tried: number }>();
  function reading(link: InstanceLinkRecord) {
    const kept = readings.get(link.id) ?? { overview: null, at: null, error: null, tried: 0 };
    if (Date.now() - kept.tried < PEER_READ_MS) return kept;
    const next = { ...kept, tried: Date.now() };
    readings.set(link.id, next);
    const keep = (value: Partial<PeerReading>) => { if (readings.get(link.id) === next) readings.set(link.id, { ...next, ...value }); };
    void call(link, "GET", "/api/nous/overview").then((answer) => keep(answer.status === 200
      ? { overview: (answer.body as { overview?: unknown } | null)?.overview ?? null, at: new Date().toISOString(), error: null } : { error: `it answered ${answer.status}` }),
    (error) => keep({ error: error instanceof Error ? error.message : String(error) }));
    return next;
  }
  services.set(options.store, {
    peers: async (owner) => (await repository.list(owner)).map((link) => {
      const { overview, at, error } = reading(link);
      return { link: view(link, live(link.id)), overview, at, error };
    }),
    list: async (owner) => (await repository.list(owner)).map((link) => view(link, live(link.id))),
    async request(owner, ref, method, path, body) {
      if (!linkRoute(method, path)) throw new InstanceLinkError(`A linked SpaceApp answers only ${Object.keys(LINK_ROUTE_SCOPES).join(", ")}.`);
      const links = await repository.list(owner);
      const named = links.filter((link) => link.label.toLowerCase() === ref.trim().toLowerCase());
      const link = links.find((entry) => entry.id === ref) ?? (named.length === 1 ? named[0] : null);
      if (!link) throw new InstanceLinkError(named.length ? `${named.length} linked SpaceApps are named ${ref}; give its id.` : `No linked SpaceApp is ${ref}.`);
      return call(link, method, path, body);
    }
  });

  const person = (request: FastifyRequest) => {
    options.assertPerson(request);
    if (request.appSession) throw Object.assign(new Error("Link other SpaceApps from SpaceApp on a computer (Settings > Linked SpaceApps)."), { statusCode: 403 });
    return request.user!.id;
  };
  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ConnectorError) return sendApiError(reply, error.status, error.code, error.message);
    if (error instanceof InstanceLinkError) return sendApiError(reply, 502, "INSTANCE_LINK", error.message);
    throw error;
  };

  app.get("/api/instance-links", options.routeOptions, async (request) => {
    const owner = person(request);
    return { links: (await repository.list(owner)).map((link) => view(link, live(link.id))) };
  });

  // The code goes only into the pairing, never into the audit, logs or the answer.
  app.post("/api/instance-links", options.routeOptions, async (request, reply) => {
    const owner = person(request);
    const input = pairSchema.safeParse(request.body ?? {});
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "The body takes code (the SPACEAPP-PAIR code that SpaceApp shows in Settings > Mobile app) and, behind Cloudflare Access, access {clientId, clientSecret} as Vault key ids.");
    const accessKeys = input.data.access ?? null;
    let paired;
    try { paired = await pairInstanceLink(input.data.code, `SpaceApp ${hostname()}`, options.version, await accessHeaders(owner, accessKeys)); } catch (error) {
      if (error instanceof InstanceLinkError || error instanceof ConnectorError) return failed(reply, error);
      return sendApiError(reply, 400, "INVALID_INPUT", error instanceof Error && error.message.includes("expired") ? error.message : "That is not a valid SpaceApp pairing code.");
    }
    const id = `link:${randomBytes(12).toString("base64url")}`;
    let link;
    try {
      link = await repository.create({ id, ownerUserId: owner, label: paired.label, origins: paired.origins, noisePublic: paired.noisePublic, identityPublic: paired.identityPublic,
        deviceId: paired.deviceId, scopes: paired.scopes, accessKeys, sealedDevicePrivate: options.crypto.seal(b64.encode(paired.devicePrivate), sealContext({ id, ownerUserId: owner })) });
    } catch (error) { return failed(reply, error); }
    await recordAudit(options.store, request, { action: "instance_link.paired", targetType: "instance_link", targetId: id,
      metadata: { label: paired.label, origins: paired.origins, deviceId: paired.deviceId, pending: paired.pending, access: accessKeys } });
    return { link: view(link, false), pending: paired.pending };
  });

  // Connects (or reuses the open session) and asks the other side who this link is: its scopes, and the round trip.
  app.post<{ Params: { id: string } }>("/api/instance-links/:id/check", options.routeOptions, async (request, reply) => {
    const link = await repository.get(person(request), request.params.id);
    if (!link) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    try {
      const { link: seen, scopes, status, rttMs } = await call(link, "GET", "/api/auth/me");
      return { link: seen, scopes, status, rttMs };
    } catch (error) { return failed(reply, error); }
  });

  // Λ4: what this SpaceApp did through one link (its acts and pairing), inside the History period (HISTORY_FLOORS sets `since`).
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>("/api/instance-links/:id/history", options.routeOptions, async (request, reply) => {
    const owner = person(request);
    if (!(await repository.get(owner, request.params.id))) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    const since = Number.isNaN(Date.parse(request.query.since ?? "")) ? new Date(0).toISOString() : request.query.since!;
    const rows = await options.store.listAuditEventsSince?.({ actions: ["instance_link.paired", "instance_link.request"], since }) ?? [];
    return { events: rows.filter((row) => row.targetType === "instance_link" && row.targetId === request.params.id && row.actorUserId === owner)
      .map((row) => ({ id: row.id, action: row.action, requestId: row.traceId, metadata: row.metadata, createdAt: row.createdAt })) };
  });

  // Λ7: each linked SpaceApp's own load, read in parallel; one that does not answer gives its error, and the web keeps its last reading.
  app.get("/api/instance-links/load", options.routeOptions, async (request, reply) => {
    const owner = person(request);
    const range = nousLoadRangeSchema.default("1h").safeParse((request.query as { range?: unknown }).range);
    if (!range.success) return sendApiError(reply, 400, "INVALID_INPUT", "range is 1h, 24h, 7d or 30d.");
    const links = await repository.list(owner);
    return { instances: await Promise.all(links.map(async (link) => {
      try {
        const answer = await call(link, "GET", `/api/nous/load?range=${range.data}`);
        if (answer.status === 200) return { link: answer.link, load: answer.body as NousLoad, error: null };
        const said = (answer.body as { error?: { message?: unknown } } | null)?.error?.message;
        return { link: answer.link, load: null, error: typeof said === "string" ? said : `It answered ${answer.status}.` };
      } catch (error) {
        return { link: view(link, live(link.id)), load: null, error: error instanceof Error ? error.message : "It did not answer." };
      }
    })) };
  });

  // Removing forgets this side's key: the link can never connect again. Its device stays listed there until its person revokes it.
  app.delete<{ Params: { id: string } }>("/api/instance-links/:id", options.routeOptions, async (request, reply) => {
    const owner = person(request);
    const pending = sessions.get(request.params.id);
    if (!(await repository.remove(owner, request.params.id))) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    sessions.delete(request.params.id);
    readings.delete(request.params.id);
    void pending?.then((open) => open.close(), () => undefined);
    await recordAudit(options.store, request, { action: "instance_link.removed", targetType: "instance_link", targetId: request.params.id });
    return { ok: true };
  });

  return { repository, session };
}
