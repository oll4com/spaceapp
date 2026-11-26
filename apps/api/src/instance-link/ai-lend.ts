import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { gatewayProxyPrefixes, hashGatewayApiKey, readPresentedApiKey } from "@space/gateway";
import { gatewayProviderSchema, type GatewayProvider } from "@space/contracts";
import { sendApiError } from "../http-errors.js";
import type { LinkServe } from "./client.js";

// AI lending over a Space Link (plan clipboard:zqVWdClsx_pA step 6, ADR-014 v2): the linked SpaceApp (A) keeps every AI account and key;
// this SpaceApp (B) gets a stand-in for its own Gateway's address while A's link is open, and its Claude panes' model calls go through
// the link to A's Gateway. Only prompts and answers cross; A's key for them stays on A, B's panes present B's own Gateway keys here.

/** The Gateway's own body limit (packages/gateway/src/server.ts bodyLimit). */
const BODY_MAX = 32 * 1024 * 1024;
/** What crosses with a model request: the providers' own headers, never an authorization (frame schema req.h). */
const FORWARD_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"] as const;
/** Only to a lender that named its providers (built with plan clipboard:TcX66vjNuZDv step 4): an older one's strict req.h refuses them. */
const WIDE_HEADERS = [...FORWARD_HEADERS, "user-agent", "openai-beta"] as const;
/**
 * Plan clipboard:TcX66vjNuZDv step 4: every model route the Gateway proxies (gatewayProxyPrefixes), for every provider it serves; never its
 * admin, status or pool routes. The path must be already normal (no dot segment, %2e, // or fragment) so A's fetch cannot leave the prefix.
 * shortcut: HTTP only; a Codex websocket upgrade fails at B's stand-in and Codex falls back to HTTPS; carry upgrades when that costs.
 */
export function linkAiPathAllowed(method: string, path: string) {
  if ((method !== "GET" && method !== "POST") || path.length > 2048 || !path.startsWith("/") || /%2e|\\/i.test(path)) return false;
  const url = new URL(path, "http://link.invalid");
  if (url.host !== "link.invalid" || url.pathname + url.search !== path) return false;
  return gatewayProxyPrefixes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

// Defined here, not in mobile/channel.ts, so this module does not import the channel (which imports routes, which import this).
/** Where an answer to a request this side sent over a link streams: its head once, its bytes, then end (with an error when it broke). */
export type LinkSink = { head(status: number, headers: Record<string, string>): void; data(bytes: Uint8Array): void; end(error?: Error): void };
/** Sends one request to the linked client; the function it returns cancels it. */
export type LinkForward = (header: { m: string; p: string; h?: Record<string, string> }, body: Uint8Array, sink: LinkSink) => () => void;

const lenders = new WeakMap<object, { deviceId: string; server: Server; providers: ReadonlySet<GatewayProvider>; wide: boolean }>();
/** True while a linked SpaceApp lends this one that provider's accounts (createCliSessionAccounts then offers the space-gateway profile). */
export const linkAiServes = (store: object, provider: GatewayProvider) => lenders.get(store)?.providers.has(provider) ?? false;

const anthropicError = (res: ServerResponse, status: number, type: string, message: string) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type, message } }));
};

/** B's side: the link registers as the lender (scope ai), and a server on this SpaceApp's Gateway address forwards to it until the link closes. */
export function registerLinkAiBorrow(app: FastifyInstance, options: {
  store: object; routeOptions: Pick<RouteShorthandOptions, "config">; gatewayUrl: string;
  channelFor: (deviceId: string) => { forward: LinkForward; closed: (listener: () => void) => void } | null;
  keyByHash: (keyHash: string) => Promise<{ isActive: boolean; expiresAt: string | null } | null>;
}) {
  app.addHook("onClose", async () => { lenders.get(options.store)?.server.close(); lenders.delete(options.store); });
  app.post("/api/instance-link/ai", options.routeOptions, async (request, reply) => {
    const device = request.mobileDevice;
    if (!device?.scopes.includes("ai")) return sendApiError(reply, 403, "LINK_AI_NOT_GRANTED", "Only a linked SpaceApp this SpaceApp's person let lend AI accounts.");
    const channel = options.channelFor(device.id);
    if (!channel) return sendApiError(reply, 409, "LINK_CLOSED", "This link's session is not open.");
    const current = lenders.get(options.store);
    if (current && current.deviceId !== device.id) return sendApiError(reply, 409, "LINK_AI_LENT", "Another linked SpaceApp lends its AI accounts here already.");
    current?.server.close();
    // A lender built before step 4 sends no providers: it lends Claude only, with Claude's headers.
    const named = (request.body as { providers?: unknown } | null)?.providers;
    const wide = Array.isArray(named);
    const providers = new Set(wide ? named.flatMap((value) => gatewayProviderSchema.safeParse(value).data ?? []) : ["CLAUDE" as const]);
    const server = createServer((req, res) => void borrow(channel.forward, wide, req, res).catch(() => res.headersSent ? res.destroy() : anthropicError(res, 502, "api_error", "The link to the lending SpaceApp failed.")));
    const { hostname, port } = new URL(options.gatewayUrl);
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(port) || 80, hostname.replace(/^\[|\]$/g, ""), resolve); });
    } catch (error) {
      if (lenders.get(options.store)?.server === current?.server) lenders.delete(options.store);
      const busy = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      return sendApiError(reply, 409, busy ? "GATEWAY_RUNNING_HERE" : "LINK_AI_LISTEN", busy ? "This SpaceApp's own Gateway runs at its address; its panes use it." : "Its Gateway address could not be opened.");
    }
    const entry = { deviceId: device.id, server, providers, wide };
    lenders.set(options.store, entry);
    channel.closed(() => { server.close(); if (lenders.get(options.store) === entry) lenders.delete(options.store); });
    return { lending: true, gatewayUrl: options.gatewayUrl, providers: [...providers] };
  });

  async function borrow(forward: LinkForward, wide: boolean, req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? "";
    if (!linkAiPathAllowed(req.method ?? "", path)) return anthropicError(res, 404, "not_found_error", `Through a Space Link only the Gateway's model routes (${gatewayProxyPrefixes.join(", ")}).`);
    const presented = readPresentedApiKey(req.headers);
    const key = presented ? await options.keyByHash(hashGatewayApiKey(presented)) : null;
    if (!key?.isActive || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())) return anthropicError(res, 401, "authentication_error", "Not an active Gateway key of this SpaceApp.");
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of req as AsyncIterable<Buffer>) {
      size += part.length;
      if (size > BODY_MAX) return anthropicError(res, 413, "request_too_large", "Over the Gateway's 32 MiB.");
      parts.push(part);
    }
    const h = Object.fromEntries((wide ? WIDE_HEADERS : FORWARD_HEADERS).flatMap((name) => typeof req.headers[name] === "string" ? [[name, req.headers[name]]] : []));
    const cancel = forward({ m: req.method!, p: path, h }, Buffer.concat(parts), {
      head: (status, headers) => void res.writeHead(status, headers),
      data: (bytes) => void res.write(bytes),
      end: (error) => error ? (res.headersSent ? res.destroy() : anthropicError(res, 502, "api_error", error.message)) : void res.end()
    });
    res.on("close", () => { if (!res.writableFinished) cancel(); });
  }
}

/**
 * A's side: answers the link's model requests with this SpaceApp's Gateway under the link's own key (`plainKey`, null when lending is
 * off). No x-space-project crosses, so Tokens groups the link's use under its key's name.
 */
export function linkAiServe(gatewayUrl: string, plainKey: () => Promise<string | null>, lending: () => boolean = () => true): LinkServe {
  const serve: LinkServe = async (request, body, reply, signal) => {
    if (!linkAiPathAllowed(request.m, request.p)) return refuse(reply, 404, "This SpaceApp lends only its Gateway's model routes.");
    const key = await plainKey();
    if (!key) return refuse(reply, 403, "This SpaceApp no longer lends its AI accounts over this link.");
    const h = Object.fromEntries(WIDE_HEADERS.flatMap((name) => request.h[name] ? [[name, request.h[name]!]] : []));
    const answer = await fetch(`${gatewayUrl}${request.p}`, { method: request.m, headers: { ...h, authorization: `Bearer ${key}` },
      body: request.m === "GET" ? undefined : new Uint8Array(body), signal });
    reply.head(answer.status, Object.fromEntries(["content-type", "retry-after"].flatMap((name) => answer.headers.get(name) ? [[name, answer.headers.get(name)!]] : [])));
    if (answer.body) for await (const piece of answer.body) reply.data(piece);
  };
  return Object.assign(serve, { accepts: (request: { m: string; p: string }) => lending() && linkAiPathAllowed(request.m, request.p) });
}

function refuse(reply: Parameters<LinkServe>[2], status: number, message: string) {
  reply.head(status, { "content-type": "application/json" });
  reply.data(new TextEncoder().encode(JSON.stringify({ type: "error", error: { type: status === 404 ? "not_found_error" : "permission_error", message } })));
}
