import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Short-lived store for desktop sign-in handoffs (RFC 8252 loopback redirect with PKCE).
 *
 * The desktop client listens on a loopback port, opens the system browser with a random handoff id, that port and a
 * PKCE challenge, and keeps the verifier. After Google sign-in the browser is sent to the client's loopback listener
 * with a one-time code; the client redeems code and verifier for the session. Whoever starts the flow therefore never
 * receives the session of the person who completes it on another machine (run-spaceapp 1.1.7 review, Codex finding 1).
 * Entries are single-use, burned by any failed attempt, expire quickly and the store is bounded.
 */
export interface DesktopAuthHandoffEntry {
  token: string;
  user: { id: string; email: string; role: string };
  codeHash: string;
  codeChallenge: string;
  createdAt: number;
}

export interface DesktopAuthHandoffBinding {
  handoffId: string;
  port: number;
  codeChallenge: string;
}

export const DESKTOP_AUTH_HANDOFF_TTL_MS = 2 * 60 * 1000;
export const DESKTOP_AUTH_HANDOFF_MAX_ENTRIES = 200;
export const DESKTOP_AUTH_HANDOFF_PATH = "/space-desktop-auth";

const handoffIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
// base64url(SHA-256): 43 characters without padding.
const codeChallengePattern = /^[A-Za-z0-9_-]{43}$/;
const portPattern = /^[0-9]{4,5}$/;

export function isValidDesktopAuthHandoffId(value: unknown): value is string {
  return typeof value === "string" && handoffIdPattern.test(value);
}

/** A desktop handoff is accepted only with its loopback port and PKCE challenge; anything else is unbound. */
export function parseDesktopAuthHandoffBinding(input: { handoffId?: unknown; port?: unknown; codeChallenge?: unknown }): DesktopAuthHandoffBinding | null {
  const { handoffId, port, codeChallenge } = input;
  if (!isValidDesktopAuthHandoffId(handoffId)) return null;
  if (typeof codeChallenge !== "string" || !codeChallengePattern.test(codeChallenge)) return null;
  const portText = typeof port === "number" ? String(port) : port;
  if (typeof portText !== "string" || !portPattern.test(portText)) return null;
  const portNumber = Number(portText);
  if (portNumber < 1024 || portNumber > 65535) return null;
  return { handoffId, port: portNumber, codeChallenge };
}

export function encodeDesktopAuthHandoffCookie(binding: DesktopAuthHandoffBinding): string {
  return `${binding.handoffId}.${binding.port}.${binding.codeChallenge}`;
}

export function decodeDesktopAuthHandoffCookie(value: unknown): DesktopAuthHandoffBinding | null {
  if (typeof value !== "string") return null;
  const [handoffId, port, codeChallenge, ...rest] = value.split(".");
  if (rest.length) return null;
  return parseDesktopAuthHandoffBinding({ handoffId, port, codeChallenge });
}

/** The browser goes only to 127.0.0.1 on the machine where the sign-in happened, never to a host the caller names. */
export function desktopAuthHandoffRedirect(binding: DesktopAuthHandoffBinding, code: string): string {
  const url = new URL(`http://127.0.0.1:${binding.port}${DESKTOP_AUTH_HANDOFF_PATH}`);
  url.searchParams.set("handoff", binding.handoffId);
  url.searchParams.set("code", code);
  return url.toString();
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export interface DesktopAuthHandoffStore {
  store(handoffId: string, entry: { token: string; user: DesktopAuthHandoffEntry["user"]; code: string; codeChallenge: string }): void;
  /** Returns the session once for the right code and verifier; any attempt removes the handoff. */
  redeem(handoffId: string, code: unknown, codeVerifier: unknown): DesktopAuthHandoffEntry | null;
  readonly size: number;
}

export function createDesktopAuthHandoffStore(options: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}): DesktopAuthHandoffStore {
  const ttlMs = Math.max(1000, Math.trunc(options.ttlMs ?? DESKTOP_AUTH_HANDOFF_TTL_MS));
  const maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DESKTOP_AUTH_HANDOFF_MAX_ENTRIES));
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, DesktopAuthHandoffEntry>();

  const sweep = (): void => {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of entries) {
      if (entry.createdAt <= cutoff) {
        entries.delete(id);
      }
    }
  };

  return {
    store(handoffId, entry) {
      if (!isValidDesktopAuthHandoffId(handoffId)) {
        throw new Error("Invalid desktop handoff id.");
      }
      sweep();
      while (entries.size >= maxEntries) {
        // Map iteration follows insertion order, so the first key is the oldest.
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
      entries.set(handoffId, {
        token: entry.token,
        user: entry.user,
        codeHash: sha256(entry.code).toString("hex"),
        codeChallenge: entry.codeChallenge,
        createdAt: now()
      });
    },
    redeem(handoffId, code, codeVerifier) {
      sweep();
      if (!isValidDesktopAuthHandoffId(handoffId)) return null;
      const entry = entries.get(handoffId);
      if (!entry) {
        return null;
      }
      entries.delete(handoffId);
      if (typeof code !== "string" || typeof codeVerifier !== "string" || code.length > 256 || codeVerifier.length > 256) return null;
      const codeMatches = sameBytes(sha256(code), Buffer.from(entry.codeHash, "hex"));
      const verifierMatches = sameBytes(Buffer.from(sha256(codeVerifier).toString("base64url")), Buffer.from(entry.codeChallenge));
      return codeMatches && verifierMatches ? entry : null;
    },
    get size() {
      return entries.size;
    }
  };
}
