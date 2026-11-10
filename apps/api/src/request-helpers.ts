/** Request address and header helpers shared by the API composition root and route domains (moved verbatim from it). */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { NOUS_CLIENT_HEADER, nousClientContext, type AuthUser, type NousClientContext } from "@space/contracts";
import { cookieName, signedSessionPayload, verifySession } from "./auth.js";

export function requestIpForLog(request: FastifyRequest): string | undefined {
  try {
    return request.ip;
  } catch {
    return undefined;
  }
}

/** The request's signed session user; records the mobile app whose device session it is (its `app` claim, app-signin.ts) as `request.appSession`. */
export function requestSessionUser(request: FastifyRequest, secret: string): AuthUser | null {
  const token = request.cookies[cookieName];
  const user = verifySession(token, secret);
  const app = user ? signedSessionPayload(token, secret)?.app : undefined;
  if (app) request.appSession = app;
  return user;
}

/** Where an operator message comes from (plan clipboard:4TXfIZzj8ITW): the device session's app claim and the UA first, the X-Space-Client header only describes. */
export function requestNousClient(request: FastifyRequest): NousClientContext {
  return nousClientContext({ appClaim: request.appSession, userAgent: headerString(request.headers["user-agent"]), header: headerString(request.headers[NOUS_CLIENT_HEADER]) });
}

export function headerString(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export function secureTokenMatches(expected: string | null, submitted: string | string[] | undefined): boolean {
  const actual = headerString(submitted);
  if (!expected || !actual) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const actualHash = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

export function isLoopbackRequest(request: FastifyRequest): boolean {
  // A phone's request is injected in-process; it is never the worker or gateway on this host (Nous Pro security review P2-1).
  if (request.mobileDevice) return false;
  const ip = requestIpForLog(request);
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function requestPathname(request: FastifyRequest): string {
  return new URL(request.url, "http://space.local").pathname;
}

/**
 * The path the router actually matched. Guards must decide on this instead of
 * the raw request URL: find-my-way percent-decodes the path before matching, so
 * a raw prefix check can disagree with the route that runs. Requests that did
 * not match a route fall back to the decoded pathname.
 */
export function requestRoutePath(request: FastifyRequest): string {
  const routeUrl = request.routeOptions?.url;
  if (typeof routeUrl === "string" && routeUrl.length > 0) {
    return routeUrl;
  }
  const pathname = requestPathname(request);
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** Reads one cookie from a raw Cookie header (used for HTTP upgrade requests). */
export function cookieValueFromHeader(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}
