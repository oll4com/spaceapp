import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MailCampaignsRepository, MailHitDetails } from "@space/db";
import { mailCampaignIdSchema, type SpaceInstance } from "@space/contracts";
import { textToHtml } from "../mail-copilot/gmail-mime.js";
import { openPixel } from "./mime.js";
import type { MailCampaignsRouteDependencies } from "./routes.js";

// Mail open tracking (operator orders 22/11, nous_msg:81e970f5 and nous_msg:7763c6c7: who opened it, from which IP, every time). A tracked
// mail goes to one recipient under its own random token with a 1x1 pixel: each fetch is one open, every one stored, none merged. Links
// are not wrapped (operator 22/11: no tracked link). Limits: Gmail fetches the pixel through Google Image Proxy (a Google
// IP, not the reader's), Apple Mail Privacy Protection fetches on delivery (an open nobody made), blocked images give no open.
// template-html.ts drops 1x1 pixels from campaign templates on purpose; this pixel is added at send time only: to one Mail Copilot mail, or to
// each recipient's mail of a campaign with `track` on (campaigns.ts sendOne, after the approval's render hash check).
// spaceapp.example resolves to a private IP, so the pixel and links live on the public relay https://oll4.com/m/ (public-host, Hestia
// public_html/m/index.php, built by space-c6 22/11): it answers the gif or the 302 and posts each hit here with the reader's IP.

/** Public path (api-request-classes.ts `publicPaths`), answered only to the relay's address. */
export const MAIL_HIT_ROUTE = "/api/public/mail/hit";
export const MAIL_TRACKING_RELAY_IP = "192.0.2.110";
const DEFAULT_RELAY = "https://oll4.com/m/";
const hitSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32}$/), kind: z.enum(["open", "click"]), n: z.number().int().min(0).max(9999).optional(),
  ip: z.string().max(64).nullish(), userAgent: z.string().nullish(), country: z.string().max(8).nullish()
});
const opensQuery = z.object({ campaignId: mailCampaignIdSchema.optional() }).strict();
// A stored user agent is cut at 500 characters (a header is client input); the rest is never read.
const USER_AGENT_CHARS = 500;
const LOOKUP_MS = 4_000;

/** Turns a recipient's mail into its tracked HTML part. */
export type MailTracker = (owner: string, input: { recipient: string; recipientName: string; subject: string; text: string; from?: string }) => Promise<string>;

/** The relay URL with this instance named (the relay posts hits back to it); null on a public install, which has no relay. */
export function trackingRelay(config: { instance: SpaceInstance; publicDistribution?: boolean }, env = process.env): string | null {
  if (config.publicDistribution && !env.SPACE_MAIL_TRACKING_RELAY) return null;
  const url = new URL(env.SPACE_MAIL_TRACKING_RELAY || DEFAULT_RELAY);
  url.searchParams.set("i", config.instance === "dev" ? "dev" : "stable");
  return url.toString();
}

const DEFAULT_RELAYS = "unboxexpert.com=https://unboxexpert.com/m/";
/** A sender domain's own relay (SPACE_MAIL_TRACKING_RELAYS "domain=url,…"; public-host public_html/m/index.php on that site), so a campaign mail names only its own site; other domains use `trackingRelay`. */
export function trackingRelays(config: { instance: SpaceInstance; publicDistribution?: boolean }, env = process.env): Record<string, string> {
  if (config.publicDistribution && !env.SPACE_MAIL_TRACKING_RELAYS) return {};
  return Object.fromEntries((env.SPACE_MAIL_TRACKING_RELAYS || DEFAULT_RELAYS).split(",").filter((entry) => entry.trim()).map((entry) => {
    const [domain, url] = [entry.slice(0, entry.indexOf("=")).trim(), entry.slice(entry.indexOf("=") + 1).trim()];
    if (!/^[a-z0-9.-]+$/.test(domain) || !url.startsWith("https://")) throw new Error("SPACE_MAIL_TRACKING_RELAYS entries must be domain=https URL.");
    return [domain, trackingRelay(config, { SPACE_MAIL_TRACKING_RELAY: url })!];
  }));
}

/**
 * Records one recipient's tracked mail (token, address, display name, subject) and answers its HTML part: the text as the untracked mail
 * shows it and the pixel at the end. Pixel only (operator 22/11 22:16: no tracked link, an open is recorded when the mail is opened);
 * the click route still answers the two test mails sent with wrapped links that morning. Sends nothing.
 */
export async function trackedMailHtml(repository: Pick<MailCampaignsRepository, "trackMessage">, relay: string,
  input: { ownerUserId: string; recipient: string; recipientName: string; subject: string; text: string }) {
  const token = randomBytes(24).toString("base64url");
  await repository.trackMessage({ token, ownerUserId: input.ownerUserId, recipient: input.recipient, recipientName: input.recipientName, subject: input.subject, links: [] });
  return { token, html: textToHtml(input.text) + openPixel(relay, token) };
}

/** The mail client or browser and the device a user agent names. */
export function describeClient(userAgent: string | null): Pick<MailHitDetails, "client" | "device"> {
  const ua = userAgent ?? "";
  const client = /GoogleImageProxy|ggpht\.com/i.test(ua) ? "Gmail" : /YahooMailProxy/i.test(ua) ? "Yahoo Mail" : /Thunderbird\//.test(ua) ? "Thunderbird"
    : /Microsoft Outlook|ms-office|MSOffice|Outlook-(iOS|Android)/i.test(ua) ? "Outlook" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera"
      : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Version\/[\d.]+.*Safari\//.test(ua) ? "Safari"
        : /AppleWebKit/.test(ua) && /iPhone|iPad|Macintosh/.test(ua) ? "Apple Mail" : null;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) && !/GoogleImageProxy/.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Linux|X11/.test(ua) ? "Linux" : null;
  return { client, device };
}

/** The mail proxy behind a hit, when the IP is a mail service's and not the reader's. */
export function mailProxy(userAgent: string | null, rdns: string | null, isp: string | null): string | null {
  const ua = userAgent ?? "";
  if (/GoogleImageProxy|ggpht\.com/i.test(ua) || /(^|\.)google(usercontent)?\.com$/i.test(rdns ?? "")) return "Google Image Proxy";
  if (/YahooMailProxy/i.test(ua)) return "Yahoo proxy";
  // Apple Mail Privacy Protection fetches as a bare "Mozilla/5.0" from Apple's (or its relay partners') network.
  if (ua === "Mozilla/5.0" || /\bApple\b/i.test(isp ?? "")) return "Apple Mail Privacy";
  if (/outlook\.com$/i.test(rdns ?? "") || /\bMicrosoft\b/i.test(isp ?? "")) return "Outlook proxy";
  return null;
}

const timeout = <T>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), LOOKUP_MS).unref?.())]);
const privateIp = (ip: string) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd]|fe80:|::ffff:(10|127|192\.168)\.)/i.test(ip);

/** Reverse DNS (local resolver) and the ISP and rough geo of a public IP (ipinfo.io, no key); null for what is not found. */
export async function lookupIp(ip: string, fetchImpl: typeof fetch = fetch): Promise<Pick<MailHitDetails, "rdns" | "isp" | "geo">> {
  if (!isIP(ip) || privateIp(ip)) return { rdns: null, isp: null, geo: null };
  const [names, info] = await Promise.all([
    timeout(dns.reverse(ip)).catch(() => [] as string[]),
    timeout(fetchImpl(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, { headers: { accept: "application/json" } }).then((response) => response.ok ? response.json() : null))
      .catch(() => null) as Promise<{ hostname?: string; org?: string; city?: string; region?: string; country?: string } | null>
  ]);
  const geo = [info?.city, info?.region, info?.country].filter((part, index, all) => part && all.indexOf(part) === index).join(", ");
  return { rdns: names[0] ?? info?.hostname ?? null, isp: info?.org ?? null, geo: geo || null };
}

export function registerMailOpenTracking(app: FastifyInstance, repository: MailCampaignsRepository, deps: Pick<MailCampaignsRouteDependencies, "authenticatedOwner" | "routeOptions" | "parseQuery">
  & { lookup?: typeof lookupIp }) {
  const lookup = deps.lookup ?? lookupIp;
  // The relay's post of one open or click: the hit is stored, then what its user agent and IP tell (a lookup failure is only logged).
  app.post(MAIL_HIT_ROUTE, { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.ip !== MAIL_TRACKING_RELAY_IP && request.ip !== `::ffff:${MAIL_TRACKING_RELAY_IP}`) return reply.code(403).send({ error: "Only the mail relay posts hits." });
    const parsed = hitSchema.safeParse(request.body);
    if (!parsed.success || (parsed.data.kind === "click") !== (parsed.data.n !== undefined)) return reply.code(400).send({ error: "Not a mail hit." });
    const { token, kind, n, country } = parsed.data;
    const ip = parsed.data.ip || null;
    const userAgent = parsed.data.userAgent?.slice(0, USER_AGENT_CHARS) || null;
    const hit = await repository.recordOpen(token, { kind: kind === "click" ? "CLICK" : "OPEN", at: new Date().toISOString(), ip, userAgent, ...(n === undefined ? {} : { link: n }) });
    if (hit) {
      void (async () => {
        const where = ip ? await lookup(ip) : { rdns: null, isp: null, geo: null };
        await repository.describeOpen(hit.id, { ...describeClient(userAgent), ...where, geo: where.geo ?? (country || null), proxy: mailProxy(userAgent, where.rdns, where.isp) });
      })().catch((error: unknown) => app.log.warn({ err: error }, "Mail open details not recorded."));
    }
    // Only a link that mail's approved text carries, so the relay redirects nowhere else.
    return { url: hit?.url ?? null };
  });
  // The operator's read receipts: every tracked mail (or one campaign's) with each open and click, and each campaign's send totals.
  app.get("/api/mail-campaigns/opens", deps.routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    if (request.user?.role !== "ADMIN") throw Object.assign(new Error("Mail opens are for the operator (ADMIN) only."), { statusCode: 403 });
    const { campaignId } = deps.parseQuery(opensQuery, request.query);
    const messages = await repository.trackedMessages(owner, { campaignId });
    const ids = [...new Set(messages.flatMap((message) => message.campaignId ? [message.campaignId] : []))];
    const campaigns = await Promise.all(ids.map(async (id) => {
      const row = await repository.getCampaign(owner, id);
      return row ? { id, name: row.name, status: row.status, stats: await repository.campaignStats(owner, id) } : null;
    }));
    return { messages, campaigns: campaigns.filter((row) => row !== null) };
  });
}
