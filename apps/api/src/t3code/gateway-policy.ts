import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const T3_GATEWAY_SOCKET = "/run/space-t3code/transport.sock";
export const T3_GATEWAY_OWNER = "user:operator";
export const T3_MAX_BODY_BYTES = 64 * 1024 * 1024;
export const T3_MAX_FRAME_BYTES = 8 * 1024 * 1024;
// The app's hashed client bundle is served once for every pane from this
// pane-independent path, so a browser keeps it across panes and reloads.
export const T3_SHARED_ASSETS_PATH = "/api/t3code/assets/";
export const T3_IMMUTABLE_CACHE = "private, max-age=31536000, immutable";
// Authentic app needs same-origin scripts, workers, fonts and blob previews,
// but cannot frame other origins or connect outside Space.
export const T3_APP_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
export const T3_ASSET_EXTENSION = /\.(?:js|css|woff2?|ttf|otf|wasm|json|svg|png|webp|gif|jpe?g|mp3|wav|glb)$/;
const PANE = /^pane:[A-Za-z0-9_-]{6,80}$/;
const PRIVATE_QUERY = /(?:token|ticket|secret|password|credential|authorization|csrf|^target$|^url$|^host$|^origin$)/i;

export class T3GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function parseT3GatewayPath(rawUrl: string) {
  if (rawUrl.length > 8192 || /[\\\x00-\x20\x7f#]/.test(rawUrl)) throw new T3GatewayError(400, "T3_PATH_INVALID");
  const match = /^\/api\/t3code\/panes\/([^/]+)\/app\/(.*)$/.exec(rawUrl);
  if (!match) throw new T3GatewayError(404, "T3_NOT_FOUND");
  let paneId: string, decoded: string;
  const suffix = match[2]!;
  const pathname = suffix.split("?", 1)[0]!;
  try { paneId = decodeURIComponent(match[1]!); decoded = decodeURIComponent(pathname); }
  catch { throw new T3GatewayError(400, "T3_PATH_INVALID"); }
  if (!PANE.test(paneId) || /%(?:2f|5c)/i.test(pathname) || /[%\\\x00-\x1f\x7f]/.test(decoded) ||
      decoded.startsWith("/") || decoded.split("/").some(part => part === "." || part === "..")) {
    throw new T3GatewayError(400, "T3_PATH_INVALID");
  }
  const query = new URLSearchParams(suffix.includes("?") ? suffix.slice(suffix.indexOf("?") + 1) : "");
  if ([...query].length > 32 || [...query].some(([key, value]) => PRIVATE_QUERY.test(key) || key.length > 80 || value.length > 2048 || /[\x00-\x1f\x7f]/.test(key + value))) {
    throw new T3GatewayError(400, "T3_QUERY_INVALID");
  }
  return { paneId, basePath: `/api/t3code/panes/${paneId}/app/`, upstreamPath: "/" + suffix };
}

export function isAllowedT3Http(method: string, rawPath: string): boolean {
  const path = rawPath.split("?", 1)[0]!;
  // /api/orchestration/dispatch and /snapshot are T3 0.0.45's (kept for a rollback). T3 0.1.0's app mutates projects over
  // RPC; its HTTP route serves Space's own proof cleanup. The MCP OAuth (/oauth/mcp, /.well-known/oauth-protected-resource)
  // and inbound hook (/v1/environments/*/hooks) routes are never forwarded.
  if (method === "POST") return path === "/api/orchestration/dispatch" || path === "/api/projects/mutate" || path === "/api/pull-requests/diff" ||
    path === "/api/observability/v1/traces";
  if (method !== "GET" && method !== "HEAD") return false;
  if (["/.well-known/t3/environment", "/api/auth/session", "/api/orchestration/snapshot", "/api/orchestration/shell"].includes(path)) return true;
  // T3 0.1.0 reads a thread's bounded snapshot, history pages and transcript separately.
  if (/^\/api\/orchestration\/threads\/[^/]+(?:\/(?:bounded|history|transcript))?$/.test(path)) return true;
  if (/^\/assets\/[A-Za-z0-9_./-]+$/.test(path) && T3_ASSET_EXTENSION.test(path)) return true;
  if (/^\/(?:favicon\.ico|favicon-\d+x\d+\.png|apple-touch-icon\.png|manifest\.webmanifest|third-party-licenses\.json|icon-[a-z0-9-]+\.png)$/.test(path)) return true;
  return ["/", "/welcome", "/usage", "/pull-requests"].includes(path) ||
    /^\/(?:settings(?:\/[a-z-]+)?|projects\/[A-Za-z0-9_-]+|draft\/[A-Za-z0-9_-]+|(?:primary|[a-f0-9-]{36})\/[A-Za-z0-9_:-]+)$/.test(path);
}

export function t3RedirectLocation(location: string, basePath: string, fromPath = "/"): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(location) && !location.startsWith("http://127.0.0.1:3773/")) throw new T3GatewayError(502, "T3_REDIRECT_REJECTED");
  if (location.startsWith("//") || /[\\\x00-\x20\x7f]/.test(location)) throw new T3GatewayError(502, "T3_REDIRECT_REJECTED");
  const target = new URL(location, "http://127.0.0.1:3773" + fromPath);
  if (target.origin !== "http://127.0.0.1:3773" || target.hash) throw new T3GatewayError(502, "T3_REDIRECT_REJECTED");
  const prefixed = basePath + target.pathname.slice(1) + target.search;
  const parsed = parseT3GatewayPath(prefixed);
  if (!isAllowedT3Http("GET", parsed.upstreamPath)) throw new T3GatewayError(502, "T3_REDIRECT_REJECTED");
  return prefixed;
}

export interface T3HandleScope { sessionId: string; paneId: string }
type HandleKind = "read" | "upload";
const HANDLE_PATTERNS: Record<HandleKind, RegExp> = { read: /^\/api\/assets\/[A-Za-z0-9_.-]+\/[^/?#]+$/, upload: /^\/api\/attachments\/upload\/[A-Za-z0-9_.-]+$/ };
const HANDLE_PATH = /^\/__space\/(assets|uploads)\/([A-Za-z0-9_-]{40,3000})$/;
// Handles are sealed (AES-256-GCM) with a key derived from the Space session
// secret, so they survive API restarts: the browser keeps a read URL until the
// upstream's 30 minute refresh, and an in-memory table lost every handle on
// each deploy. The upstream path stays hidden; session, pane, kind and expiry
// are bound in the seal, and every use is still authorized per request.
export class T3AssetHandles {
  private readonly key: Buffer;
  private readonly now: () => number;
  constructor(options: { secret?: string; now?: () => number } = {}) {
    this.key = options.secret ? createHash("sha256").update("space-t3-asset-handle-v1\0" + options.secret).digest() : randomBytes(32);
    this.now = options.now ?? Date.now;
  }
  private aad(scope: T3HandleScope, kind: HandleKind) { return Buffer.from(`${kind}\n${scope.sessionId}\n${scope.paneId}`); }
  issue(scope: T3HandleScope, upstreamPath: string, expiresAt: number, kind: HandleKind) {
    if (!HANDLE_PATTERNS[kind].test(upstreamPath) || !Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new T3GatewayError(502, "T3_ASSET_INVALID");
    // Upstream refreshes read URLs every 30 minutes and signs them for one
    // hour. Keep that lifetime while checking Space authorization every use.
    const expires = Math.min(expiresAt, this.now() + (kind === "read" ? 3_600_000 : 600_000));
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(scope, kind));
    const sealed = Buffer.concat([cipher.update(JSON.stringify({ p: upstreamPath, e: expires })), cipher.final()]);
    return `/__space/${kind === "read" ? "assets" : "uploads"}/${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url")}`;
  }
  resolve(scope: T3HandleScope, path: string, method: string): string | null {
    const match = HANDLE_PATH.exec(path);
    if (!match) return null;
    const kind: HandleKind = match[1] === "assets" ? "read" : "upload";
    if (kind === "read" ? method !== "GET" && method !== "HEAD" : method !== "POST") return null;
    try {
      const bytes = Buffer.from(match[2]!, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAAD(this.aad(scope, kind)); decipher.setAuthTag(bytes.subarray(12, 28));
      const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as { p?: unknown; e?: unknown };
      return typeof value.p === "string" && HANDLE_PATTERNS[kind].test(value.p) && typeof value.e === "number" && value.e > this.now() ? value.p : null;
    } catch { return null; }
  }
}
