import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Pane, Room } from "@space/contracts";
import { cookieName, csrfHeaderName, verifyCsrfToken, verifySession } from "../auth.js";
import { T3_GATEWAY_OWNER, T3GatewayError } from "./gateway-policy.js";

export interface T3PaneAccessOptions {
  enabled: boolean; sessionSecret: string;
  // Configured public UI origins (server configuration, never request input).
  // Behind the TLS/web proxy the API derives an internal origin such as
  // http://127.0.0.1:4910 while the browser sends https://<public host>.
  publicOrigins?: readonly string[];
  store: { getPane(id: string): unknown | Promise<unknown>; getRoom(id: string): unknown | Promise<unknown> };
}
export interface T3PaneScope { userId: string; paneId: string; sessionId: string; pane: Pane; room: Room }

// The session part of every T3 check: the feature is on and the caller is the
// Space owner account (or its ADMIN proof identity).
export function authorizeT3Owner(request: FastifyRequest, options: { enabled: boolean; sessionSecret: string }): { owner: string; token: string } {
  if (!options.enabled) throw new T3GatewayError(404, "T3CODE_DISABLED");
  const token = request.cookies[cookieName], user = verifySession(token, options.sessionSecret);
  if (!user) throw new T3GatewayError(401, "UNAUTHENTICATED");
  const owner = user.id === "user:operator-proof" && user.role === "ADMIN" ? T3_GATEWAY_OWNER : user.id;
  if (owner !== T3_GATEWAY_OWNER || user.automationScope === "APP_DIAGNOSTICS") throw new T3GatewayError(403, "T3_OWNER_REQUIRED");
  return { owner, token: token! };
}

export async function authorizeT3Pane(request: FastifyRequest, options: T3PaneAccessOptions, paneId: string): Promise<T3PaneScope> {
  const { owner, token } = authorizeT3Owner(request, options);
  let pane: Pane, room: Room;
  try {
    pane = await options.store.getPane(paneId) as Pane;
    if (!pane || pane.id !== paneId || pane.mode !== "T3CODE" || pane.isClosed) throw new Error();
    room = await options.store.getRoom(pane.roomId) as Room;
    if (!room) throw new Error();
  } catch { throw new T3GatewayError(404, "T3_PANE_NOT_FOUND"); }
  if (room.ownerUserId && room.ownerUserId !== owner) throw new T3GatewayError(403, "T3_ROOM_FORBIDDEN");
  if (request.headers["sec-fetch-site"] === "cross-site") throw new T3GatewayError(403, "T3_ORIGIN_INVALID");
  if (request.ws || !["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin !== `${request.protocol}://${request.host}` && !(origin && options.publicOrigins?.includes(origin))) throw new T3GatewayError(403, "T3_ORIGIN_INVALID");
  }
  if (!["GET", "HEAD"].includes(request.method) && !verifyCsrfToken(token, request.headers[csrfHeaderName], options.sessionSecret)) throw new T3GatewayError(403, "CSRF_INVALID");
  return { userId: owner, paneId, sessionId: createHash("sha256").update(token).digest("hex"), pane, room };
}

// Exact origins (scheme://host[:port]) from server configuration only.
export function t3PublicOrigins(...values: (string | null | undefined)[]): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    try { if (value) { const url = new URL(value); if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin); } } catch { /* ignored */ }
  }
  return [...origins];
}
