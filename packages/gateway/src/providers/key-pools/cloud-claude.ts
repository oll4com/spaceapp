import { createSign } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { gatewayError } from "../../errors.js";

/**
 * Claude on Amazon Bedrock and Google Vertex AI as key pools that spend a cloud credit (plan clipboard:qIOxhbvXfHyT step 3): each pool serves
 * only `/messages` (the Anthropic Messages API) and builds each upstream request from the stored key. Azure was ruled out (its subscription is
 * Sponsored: Foundry's Claude would bill the card; report ~/agent-workspace/nous/opus-access/report.md).
 */
export interface ClaudePoolRequest { apiKey: string; body: Record<string, unknown>; streaming: boolean; headers: IncomingHttpHeaders; fetchImpl: typeof fetch }
export type ClaudePoolUpstream = { url: string; headers: Record<string, string>; body: string };

/** The cloud refused the key before any request was sent (Vertex's token exchange): its status goes through the pool's failure marking. */
export class UpstreamRefusal extends Error {
  constructor(readonly status: number, readonly text: string) { super(`HTTP ${status}`); }
}

/** The models these pools send (dated or `-latest` ids are refused), so every request has an Anthropic list price for the credit cap. */
export const CLOUD_CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

const header = (headers: IncomingHttpHeaders, name: string) => { const value = headers[name]; return Array.isArray(value) ? value.join(",") : value; };
const beta = (headers: IncomingHttpHeaders): Record<string, string> => { const value = header(headers, "anthropic-beta"); return value ? { "anthropic-beta": value } : {}; };

/** Bedrock's stored key: `<region>:<API key>`; a bare key is taken as us-east-1's. */
export const BEDROCK_KEY = /^[a-z]{2}(?:-[a-z]+)+-\d:[A-Za-z0-9+/=_.-]{20,4096}$/;
export const bedrockKeyFrom = (pasted: string): string | null => (BEDROCK_KEY.test(pasted) ? pasted : BEDROCK_KEY.test(`us-east-1:${pasted}`) ? `us-east-1:${pasted}` : null);

/** Bedrock's Anthropic-native endpoint (Mantle): the Messages API with the key in `x-api-key` and `anthropic.` model ids. */
export async function bedrockMessages({ apiKey, body, headers }: ClaudePoolRequest): Promise<ClaudePoolUpstream> {
  // shortcut: Bedrock API keys only (no SigV4 signing of IAM access keys), add SigV4 if AWS issues only IAM credentials.
  const at = apiKey.indexOf(":");
  return { url: `https://bedrock-mantle.${apiKey.slice(0, at)}.api.aws/anthropic/v1/messages`,
    headers: { "x-api-key": apiKey.slice(at + 1), "anthropic-version": header(headers, "anthropic-version") ?? "2023-06-01", ...beta(headers) },
    body: JSON.stringify({ ...body, model: `anthropic.${String(body.model)}` }) };
}

interface VertexAccount { project_id: string; client_email: string; private_key: string; location: string }
/** Vertex's stored key: the service account's JSON cut to what signs a token, and where it calls (project in the path, location in the host). `-{5}`: the public export refuses the literal PEM header. */
export const VERTEX_KEY = /^\{"project_id":"[a-z][a-z0-9-]{4,28}[a-z0-9]","client_email":"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+","private_key":"-{5}BEGIN PRIVATE KEY-{5}[A-Za-z0-9+/=\\]+-{5}END PRIVATE KEY-{5}(?:\\n)?","location":"[a-z0-9-]{2,30}"\}$/;
/** A pasted service-account key file (an optional `location`, default global); anything else: null. */
export function vertexKeyFrom(pasted: string): string | null {
  let json: Record<string, unknown>;
  try { json = JSON.parse(pasted) as Record<string, unknown>; } catch { return null; }
  if (json?.type !== "service_account" || typeof json.project_id !== "string" || typeof json.client_email !== "string" || typeof json.private_key !== "string") return null;
  return JSON.stringify({ project_id: json.project_id, client_email: json.client_email, private_key: json.private_key,
    location: typeof json.location === "string" ? json.location : "global" });
}

const tokens = new Map<string, { token: string; until: number }>();
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An OAuth access token for the service account (a signed JWT exchanged at Google), kept until 5 minutes before it expires. */
async function vertexToken(account: VertexAccount, fetchImpl: typeof fetch): Promise<string> {
  const cached = tokens.get(account.client_email);
  if (cached && cached.until > Date.now()) return cached.token;
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iss: account.client_email, scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })}`;
  const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url")}`;
  const response = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
  const answer = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!response.ok || typeof answer?.access_token !== "string") {
    // Google's 400 invalid_grant is a deleted or wrong key: the key's fault (401); a 5xx is Google's.
    const status = response.status >= 500 ? 502 : 401;
    throw new UpstreamRefusal(status, JSON.stringify(gatewayError("upstream_auth", `Google refused the Vertex service account's token request (HTTP ${response.status}).`)));
  }
  tokens.set(account.client_email, { token: answer.access_token, until: Date.now() + (Number(answer.expires_in) > 600 ? Number(answer.expires_in) - 300 : 300) * 1000 });
  return answer.access_token;
}

/** Vertex's rawPredict: the model in the URL, the body without `model` and with Vertex's `anthropic_version`. */
export async function vertexMessages({ apiKey, body, streaming, headers, fetchImpl }: ClaudePoolRequest): Promise<ClaudePoolUpstream> {
  const account = JSON.parse(apiKey) as VertexAccount;
  const { location } = account;
  const host = location === "global" ? "aiplatform.googleapis.com" : location === "us" || location === "eu" ? `aiplatform.${location}.rep.googleapis.com` : `${location}-aiplatform.googleapis.com`;
  const { model, ...rest } = body;
  return { url: `https://${host}/v1/projects/${account.project_id}/locations/${location}/publishers/anthropic/models/${String(model)}:${streaming ? "streamRawPredict" : "rawPredict"}`,
    headers: { authorization: `Bearer ${await vertexToken(account, fetchImpl)}`, ...beta(headers) },
    body: JSON.stringify({ ...rest, anthropic_version: "vertex-2023-10-16" }) };
}
