import { createSign } from "node:crypto";
import { mailAddressDomain, type MailSender } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { createGmailClient } from "../mail-copilot/gmail-client.js";
import type { MailCopilotGoogleAccess } from "../mail-copilot/service.js";
import { dkimSign } from "./dkim.js";
import { mailSite } from "./site.js";
import { smtpCheck, smtpSubmit } from "./smtp.js";

// How a sender's mail leaves (plan clipboard:IJ2ovfLg1Lbw step 4). Secrets come from the owner's kept Vault keys, read by the API
// only at the moment of use and never returned: the Workspace service-account JSON (GMAIL_DELEGATED) or the SMTP password.
export interface MailTransport {
  /** One message to one recipient; `raw` is the complete RFC 5322 message. `messageId`: the Message-ID the provider sent instead of ours. */
  send(raw: Buffer, envelope: { from: string; to: string }): Promise<{ providerId: string; messageId?: string }>;
  /** Proves the route works without sending anything; the answer says what was checked. */
  check(): Promise<string>;
}
export interface MailTransportDeps {
  google(): MailCopilotGoogleAccess | null;
  /** A kept Vault key's value (null: unknown, without a value or not kept). */
  keptKey(owner: string, id: string): Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** The HELO name for SMTP submission (the sending host's public name). */
  heloName: string;
  /** Tests replace the SMTP client. */
  smtp?: { check: typeof smtpCheck; submit: typeof smtpSubmit };
}

// The scopes the Workspace admin already granted this client for the kits sender (send, and read for Send-as, bounces and seeds).
const DELEGATED_SCOPES = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

interface ServiceAccountKey { client_email: string; private_key: string; token_uri: string }
function serviceAccount(json: string): ServiceAccountKey {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(json) as Record<string, unknown>; } catch { throw new SpaceConflictError("The Workspace delegation key in the Vault is not a service-account JSON file."); }
  const tokenUri = typeof parsed.token_uri === "string" ? parsed.token_uri : "https://oauth2.googleapis.com/token";
  if (parsed.type !== "service_account" || typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string" || !/^https:\/\/oauth2\.googleapis\.com\/token$/.test(tokenUri)) {
    throw new SpaceConflictError("The Workspace delegation key in the Vault is not a Google service-account key.");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: tokenUri };
}
const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** An access token for `subject` through domain-wide delegation (JWT bearer grant, RS256), cached until 5 minutes before it ends. */
export function createDelegatedTokens(fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<string, { token: string; until: number }>();
  return async (keyJson: string, subject: string, scope = DELEGATED_SCOPES): Promise<string> => {
    const key = serviceAccount(keyJson);
    const cacheKey = `${key.client_email}|${subject}|${scope}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.until > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iss: key.client_email, sub: subject, scope, aud: key.token_uri, iat, exp: iat + 3600 }))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
    const response = await fetchImpl(key.token_uri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64url(signature)}` }) });
    const body = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || !body.access_token) throw new SpaceConflictError(`Google refused the Workspace delegation for ${subject}: ${body.error_description ?? body.error ?? response.status}.`);
    cache.set(cacheKey, { token: body.access_token, until: now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 });
    return body.access_token;
  };
}

export function createMailTransports(deps: MailTransportDeps) {
  const delegated = createDelegatedTokens(deps.fetchImpl);
  const smtp = deps.smtp ?? { check: smtpCheck, submit: smtpSubmit };
  async function secret(owner: string, id: string, what: string): Promise<string> {
    const value = await deps.keptKey(owner, id);
    if (!value) throw new SpaceConflictError(`The ${what} (${id}) is not in the Vault as a kept key with a value.`);
    return value;
  }
  async function gmail(owner: string, sender: MailSender) {
    const config = sender.config;
    if (config.route === "GMAIL_CONNECTOR") {
      const google = deps.google();
      if (!google?.googleConfigured) throw new SpaceConflictError("Google access is unavailable on this server.");
      const token = await google.googleAccessToken(owner, config.account, "MAIL_ORGANIZE").catch(() => {
        throw new SpaceConflictError(`${config.account} has not allowed full Gmail access for Space (Mail Copilot → Setup → Accounts).`);
      });
      return createGmailClient({ accessToken: token, fetchImpl: deps.fetchImpl });
    }
    if (config.route !== "GMAIL_DELEGATED") throw new Error("not a Gmail route");
    if (mailAddressDomain(config.subject) !== sender.domain) throw new SpaceConflictError("A delegated sender sends as a mailbox of its own domain.");
    return createGmailClient({ accessToken: await delegated(await secret(owner, config.vaultKeyId, "Workspace delegation key"), config.subject), fetchImpl: deps.fetchImpl });
  }

  return {
    /** The sender's own Gmail mailbox (read for bounces and replies); null for SMTP senders. */
    gmailFor: (owner: string, sender: MailSender) => sender.config.route === "SMTP" ? null : gmail(owner, sender),
    for(owner: string, sender: MailSender): MailTransport {
      const config = sender.config;
      if (config.route === "SMTP") {
        if (!mailSite().smtpHosts.has(config.host)) throw new SpaceConflictError(`${config.host} is not our own mail server; another relay or provider needs the operator's EXTERNAL decision.`);
        const options = async () => ({ host: config.host, port: config.port, username: config.username, password: await secret(owner, config.vaultKeyId, "SMTP password"), heloName: deps.heloName });
        return {
          send: async (raw, envelope) => smtp.submit(await options(), envelope, config.dkim
            ? dkimSign(raw, { domain: sender.domain, selector: config.dkim.selector, privateKey: await secret(owner, config.dkim.vaultKeyId, "DKIM key") }) : raw),
          check: async () => smtp.check(await options())
        };
      }
      return {
        async send(raw) {
          const client = await gmail(owner, sender);
          const sent = await client.send(raw.toString("base64url"));
          // Gmail replaces our Message-ID with its own (info@example.invalid 12/11): DSNs and replies quote the one it sent, so the send log keeps that.
          const message = await client.message(sent.id, "metadata").catch(() => null);
          const headers = (message?.payload as { headers?: Array<{ name: string; value: string }> } | undefined)?.headers ?? [];
          const messageId = headers.find((entry) => entry.name.toLowerCase() === "message-id")?.value.trim();
          return { providerId: sent.id, ...(messageId ? { messageId } : {}) };
        },
        async check() {
          const aliases = await (await gmail(owner, sender)).sendAs();
          if (!aliases.some((alias) => alias.email === sender.address)) throw new SpaceConflictError(`${sender.address} is not a verified "Send mail as" address of ${config.route === "GMAIL_CONNECTOR" ? config.account : config.subject}.`);
          return `${sender.address} is a verified Send-as address of ${config.route === "GMAIL_CONNECTOR" ? config.account : config.subject}.`;
        }
      };
    }
  };
}
export type MailTransports = ReturnType<typeof createMailTransports>;
