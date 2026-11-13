import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { LINK_ROUTE_SCOPES, vaultBase64url as b64, type MobileRouteRule } from "@space/contracts";
import { InMemoryInstanceLinkRepository, PostgresInstanceLinkRepository, type InstanceLinkRecord } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { ConnectorError, connectorSealContext, type ConnectorCrypto } from "../dot-connectors.js";
import { sendApiError } from "../http-errors.js";
import { recordAudit } from "../request-audit.js";
import { connectInstanceLink, InstanceLinkError, pairInstanceLink, type InstanceLinkSession } from "./client.js";

// Space Link (ADR-014, docs/agents/instance-links.md): the SpaceApps this one's Nous manages. A person only (Settings), never a phone, a
// proof, automation or broker session; USER accounts never reach /api/instance-links (owned-resource-access.ts denies by default).

const pairSchema = z.object({ code: z.string().trim().min(1).max(4000) }).strict();
const view = (link: InstanceLinkRecord, live: boolean) => ({ id: link.id, label: link.label, origins: link.origins, deviceId: link.deviceId, scopes: link.scopes,
  createdAt: link.createdAt, lastSeenAt: link.lastSeenAt, connected: live });
export type InstanceLinkView = ReturnType<typeof view>;
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
}
const services = new WeakMap<object, InstanceLinks>();
/** The store's linked SpaceApps (Nous's tools find them through the store they share, as appointmentsFor does). */
export const instanceLinksFor = (store: object) => services.get(store);

export function registerInstanceLinks(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "recordAuditEvent" | "upsertUser">; crypto: ConnectorCrypto; databaseUrl: string | null | undefined;
  routeOptions: Pick<RouteShorthandOptions, "config">; assertPerson: (request: FastifyRequest) => void; version: string;
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

  async function session(link: InstanceLinkRecord): Promise<InstanceLinkSession> {
    const cached = sessions.get(link.id);
    if (cached) {
      const open = await cached.catch(() => null);
      if (open && !open.closed()) return open;
      if (sessions.get(link.id) === cached) sessions.delete(link.id);
    }
    const pending = (async () => {
      const devicePrivate = b64.decode(options.crypto.open(link.sealedDevicePrivate, sealContext(link)));
      const opened = await connectInstanceLink({ ...link, devicePrivate }, options.version);
      await repository.seen(link.id, { atIso: new Date().toISOString(), scopes: opened.scopes, ...opened.rotated });
      return opened;
    })();
    sessions.set(link.id, pending);
    pending.catch(() => { if (sessions.get(link.id) === pending) sessions.delete(link.id); });
    return pending;
  }

  async function call(link: InstanceLinkRecord, method: "GET" | "POST", path: string, body?: unknown): Promise<InstanceLinkAnswer> {
    const open = await session(link);
    const started = Date.now();
    const answer = await open.request(method, path, body);
    return { link: view((await repository.get(link.ownerUserId, link.id)) ?? link, true), scopes: open.scopes, rttMs: Date.now() - started, ...answer };
  }
  services.set(options.store, {
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
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "The body takes only code: the SPACEAPP-PAIR code that SpaceApp shows in Settings > Mobile app.");
    let paired;
    try { paired = await pairInstanceLink(input.data.code, `SpaceApp ${hostname()}`, options.version); } catch (error) {
      if (error instanceof InstanceLinkError) return failed(reply, error);
      return sendApiError(reply, 400, "INVALID_INPUT", error instanceof Error && error.message.includes("expired") ? error.message : "That is not a valid SpaceApp pairing code.");
    }
    const id = `link:${randomBytes(12).toString("base64url")}`;
    let link;
    try {
      link = await repository.create({ id, ownerUserId: owner, label: paired.label, origins: paired.origins, noisePublic: paired.noisePublic, identityPublic: paired.identityPublic,
        deviceId: paired.deviceId, scopes: paired.scopes, sealedDevicePrivate: options.crypto.seal(b64.encode(paired.devicePrivate), sealContext({ id, ownerUserId: owner })) });
    } catch (error) { return failed(reply, error); }
    await recordAudit(options.store, request, { action: "instance_link.paired", targetType: "instance_link", targetId: id,
      metadata: { label: paired.label, origins: paired.origins, deviceId: paired.deviceId, pending: paired.pending } });
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

  // Removing forgets this side's key: the link can never connect again. Its device stays listed there until its person revokes it.
  app.delete<{ Params: { id: string } }>("/api/instance-links/:id", options.routeOptions, async (request, reply) => {
    const owner = person(request);
    const pending = sessions.get(request.params.id);
    if (!(await repository.remove(owner, request.params.id))) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    sessions.delete(request.params.id);
    void pending?.then((open) => open.close(), () => undefined);
    await recordAudit(options.store, request, { action: "instance_link.removed", targetType: "instance_link", targetId: request.params.id });
    return { ok: true };
  });

  return { repository, session };
}
