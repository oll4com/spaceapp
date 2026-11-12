import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";

/** The GETs the web polls every few seconds (desktop lag brief 11/11: 40-1400 KB a call even when nothing changed). */
export const POLLED_ROUTES = new Set(["/api/nous", "/api/nous/messages", "/api/nous/decisions", "/api/notifications", "/api/notifications/pending"]);

/**
 * A polled answer carries a weak ETag of its JSON; a poll whose If-None-Match names it gets 304 and no body. Root onSend: it runs after the
 * history-period filter (preSerialization) and before compression (a per-route onSend), so the tag is the body the user may see.
 */
export function installPollEtag(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.method !== "GET" || reply.statusCode !== 200 || typeof payload !== "string" || !POLLED_ROUTES.has(request.routeOptions.url ?? "")) return payload;
    const etag = `W/"${createHash("sha1").update(payload).digest("base64url")}"`;
    reply.header("etag", etag).header("cache-control", "private, no-cache");
    if (request.headers["if-none-match"] !== etag) return payload;
    reply.code(304);
    return "";
  });
}
