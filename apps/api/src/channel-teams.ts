import { createPublicKey, createVerify, type JsonWebKeyInput } from "node:crypto";
import type { ChannelInboundMessage } from "@space/contracts";

/**
 * Space Dots Stage 6: Microsoft Teams adapter (Bot Framework).
 *
 * Every activity must carry a Bot Framework JWT: RS256, signed by a key from
 * the Bot Framework OpenID metadata, issued by https://api.botframework.com,
 * for this app id, within its validity window, and naming the same service
 * URL as the activity. Replies use the app's client-credentials token.
 */
const OPENID_METADATA = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const ISSUER = "https://api.botframework.com";
interface Jwk { kid?: string; kty?: string; n?: string; e?: string; endorsements?: string[] }

export function createBotFrameworkVerifier(input: { appId: string; fetchImpl?: typeof fetch; nowMs?: () => number }) {
  const fetchImpl = input.fetchImpl ?? fetch;
  let keys: { fetchedAt: number; keys: Jwk[] } | null = null;
  async function signingKeys(force = false): Promise<Jwk[]> {
    const now = Date.now();
    // Unknown key ids refresh the set at most every five minutes, so forged tokens cannot make Space fetch on every request.
    if (keys && (now - keys.fetchedAt < (force ? 5 * 60_000 : 24 * 3_600_000))) return keys.keys;
    const metadata = await (await fetchImpl(OPENID_METADATA, { signal: AbortSignal.timeout(10_000) })).json() as { jwks_uri?: unknown };
    if (typeof metadata.jwks_uri !== "string" || !metadata.jwks_uri.startsWith("https://")) throw new Error("Bot Framework metadata has no key set.");
    const set = await (await fetchImpl(metadata.jwks_uri, { signal: AbortSignal.timeout(10_000) })).json() as { keys?: Jwk[] };
    keys = { fetchedAt: now, keys: Array.isArray(set.keys) ? set.keys : [] };
    return keys.keys;
  }
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  /** Returns true only for a valid token for this app and service URL. */
  return async function verify(authorization: string | undefined, serviceUrl: string | null): Promise<boolean> {
    const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "")?.[1];
    if (!token) return false;
    const [headerPart, payloadPart, signaturePart] = token.split(".") as [string, string, string];
    let header: Record<string, unknown>, claims: Record<string, unknown>;
    try { header = decode(headerPart); claims = decode(payloadPart); } catch { return false; }
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
    let key = (await signingKeys()).find((candidate) => candidate.kid === header.kid);
    // Keys rotate; refresh once for an unknown key id.
    if (!key) key = (await signingKeys(true)).find((candidate) => candidate.kid === header.kid);
    // Only keys endorsed for Teams; Web Chat and Direct Line tokens use other endorsements.
    if (!key || !Array.isArray(key.endorsements) || !key.endorsements.includes("msteams")) return false;
    let valid = false;
    try {
      valid = createVerify("RSA-SHA256").update(`${headerPart}.${payloadPart}`).verify(createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" } as JsonWebKeyInput), Buffer.from(signaturePart, "base64url"));
    } catch { return false; }
    if (!valid) return false;
    const nowSeconds = (input.nowMs?.() ?? Date.now()) / 1000;
    const skew = 300;
    if (claims.iss !== ISSUER || claims.aud !== input.appId) return false;
    if (typeof claims.exp !== "number" || claims.exp + skew < nowSeconds) return false;
    if (typeof claims.nbf === "number" && claims.nbf - skew > nowSeconds) return false;
    // The token must name the service the activity came from; replies go only there.
    if (serviceUrl === null || typeof claims.serviceurl !== "string" || claims.serviceurl.replace(/\/$/, "") !== serviceUrl.replace(/\/$/, "")) return false;
    return isTeamsServiceUrl(serviceUrl);
  };
}

/** Teams service endpoints, so a bot token is never sent anywhere else. */
export function isTeamsServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)(botframework\.com|trafficmanager\.net|teams\.microsoft\.com|botframework\.azure\.us)$/.test(url.hostname);
  } catch { return false; }
}

/** Reads a verified activity; only messages addressed to the bot reach a Dot. */
export function parseTeamsActivity(activity: Record<string, unknown>): ChannelInboundMessage | null {
  if (activity.type !== "message" || activity.channelId !== "msteams" || typeof activity.id !== "string" || typeof activity.serviceUrl !== "string"
    || !isTeamsServiceUrl(activity.serviceUrl)) return null;
  const conversation = (activity.conversation ?? {}) as Record<string, unknown>;
  const from = (activity.from ?? {}) as Record<string, unknown>;
  const tenantId = typeof conversation.tenantId === "string" ? conversation.tenantId : null;
  const conversationId = typeof conversation.id === "string" ? conversation.id : null;
  const userId = typeof from.aadObjectId === "string" ? from.aadObjectId : null;
  const address = typeof from.id === "string" ? from.id : null;
  if (!tenantId || !conversationId || !userId || !address) return null;
  const text = (typeof activity.text === "string" ? activity.text : "").replace(/<at>[^<]*<\/at>/g, "").replace(/<[^>]+>/g, "").trim();
  if (!text) return null;
  const direct = conversation.conversationType === "personal";
  return { provider: "TEAMS", tenantId, eventId: `${conversationId}|${activity.id}`.slice(0, 300), conversationId,
    // Channel conversation ids already name the thread (";messageid="); group chats and personal chats are one thread each.
    threadKey: conversationId, conversationKind: direct ? "DIRECT" : "GROUP", externalUserId: userId, replyAddress: address.slice(0, 300),
    displayName: typeof from.name === "string" ? from.name.slice(0, 200) : null, text: text.slice(0, 8000), serviceUrl: activity.serviceUrl };
}

export interface TeamsClient {
  post(input: { serviceUrl: string; conversationId: string; text: string }): Promise<void>;
  /** Opens a personal conversation with a user in the tenant. */
  openDirect(input: { serviceUrl: string; tenantId: string; userAddress: string }): Promise<string>;
}

export function createTeamsClient(input: { appId: string; appPassword: string; tenant?: string | null; fetchImpl?: typeof fetch }): TeamsClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  let token: { value: string; expiresAt: number } | null = null;
  async function accessToken() {
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    const tenant = input.tenant || "botframework.com";
    const response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, { method: "POST",
      signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: input.appId, client_secret: input.appPassword, scope: "https://api.botframework.com/.default" }) });
    const body = await response.json().catch(() => ({})) as { access_token?: unknown; expires_in?: unknown };
    if (!response.ok || typeof body.access_token !== "string") throw new Error(`Teams token request failed (${response.status}).`);
    token = { value: body.access_token, expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000 };
    return token.value;
  }
  async function call(url: string, payload: Record<string, unknown>) {
    const response = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Teams request failed (${response.status}).`);
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }
  const base = (serviceUrl: string) => {
    if (!isTeamsServiceUrl(serviceUrl)) throw new Error("Not a Teams service URL.");
    return serviceUrl.replace(/\/$/, "");
  };
  return {
    async post({ serviceUrl, conversationId, text }) {
      await call(`${base(serviceUrl)}/v3/conversations/${encodeURIComponent(conversationId)}/activities`, { type: "message", text: text.slice(0, 25_000), textFormat: "markdown" });
    },
    async openDirect({ serviceUrl, tenantId, userAddress }) {
      const body = await call(`${base(serviceUrl)}/v3/conversations`, { isGroup: false, tenantId, bot: { id: input.appId },
        members: [{ id: userAddress }], channelData: { tenant: { id: tenantId } } });
      if (typeof body.id !== "string") throw new Error("Teams did not open a personal conversation.");
      return body.id;
    }
  };
}
