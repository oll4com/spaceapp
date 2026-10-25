/** Request address and header helpers shared by the API composition root and route domains (moved verbatim from it). */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export function requestIpForLog(request: FastifyRequest): string | undefined {
  try {
    return request.ip;
  } catch {
    return undefined;
  }
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
