import type { FastifyRequest } from "fastify";

// Session cookies are SameSite=Lax, so a page on another port of the same host still
// sends them: refuse browser requests that fetch metadata or Origin mark as another site.
// Behind the web proxy the API sees the internal hop, so the configured public origin also counts.
export function isOtherSiteBrowserRequest(request: FastifyRequest, publicOrigins: string[]): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return true;
  const origin = request.headers.origin;
  return site === undefined && typeof origin === "string" &&
    origin !== `${request.protocol}://${request.host}` && !publicOrigins.includes(origin);
}

export function requiresSameSiteBrowser(request: FastifyRequest, routePath: string): boolean {
  const method = request.method.toUpperCase();
  // A WebSocket handshake is a GET: without this, another local port could open the VNC stream or the
  // shared-chat socket with the owner's cookie (1.1.5 internal review, 2026-10-16).
  const websocket = String(request.headers.upgrade ?? "").toLowerCase() === "websocket";
  return routePath === "/api/auth/csrf" ||
    (routePath.startsWith("/api/") && (websocket || (method !== "GET" && method !== "HEAD" && method !== "OPTIONS")));
}
