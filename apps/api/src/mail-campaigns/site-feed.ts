import { hkdfSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MailCampaignsService } from "./service.js";
import type { MailCampaignsRepository } from "@space/db";
import { MAIL_TRACKING_RELAY_IP } from "./open-tracking.js";

/**
 * The UnboxExpert admin's read-only window on Mail Campaigns (operator 23/11, plan clipboard:ES4AQEtVuDon step 3): the site's part of
 * Mail Copilot → Campaigns (scope below). Nothing here changes or sends anything; managing stays in Space (Nous, Mail Copilot).
 * Only public-host (the site's server) asks, with the site's key in x-space-site-key: public-host hosts other sites too, so the IP alone is not enough.
 */
export const MAIL_SITE_FEED_ROUTE = "/api/public/mail/site-feed";
export const MAIL_SITE_FEED_SITE = "unboxexpert.com";
export const MAIL_UNSUBSCRIBE_ROUTE = "/api/public/mail/unsubscribe";
export const MAIL_WEB_ROUTE = "/api/public/mail/web";
const isSiteSender = (sender: { address: string }) => sender.address.toLowerCase().endsWith(`@${MAIL_SITE_FEED_SITE}`);
const SITE_LIST_NAME = /^(example.invalid customers|unboxexpert)\b/i;
const MEMBERS_PAGE = 200; // members come in pages of 200; the admin's pager asks for the next offset

/** The site's key, derived from the unsubscribe secret so there is nothing new to store (public-host keeps it in private/admin.env). */
export function mailSiteFeedKey(secret: string, site = MAIL_SITE_FEED_SITE): string {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("space-mail-campaigns"), Buffer.from(`site-feed:${site}`), 32)).toString("base64url");
}

export function registerMailSiteFeed(app: FastifyInstance, service: MailCampaignsService, repository: MailCampaignsRepository, secret: string): void {
  const key = Buffer.from(mailSiteFeedKey(secret));
  // One-click unsubscribe (plan clipboard:16ji8NSSApw0 step 3): a site's /u/ page passes the token on at once. public-host only, no site key: the token
  // proves itself (HMAC). 400 when this instance did not sign it, so the page tries the other instance; a repeat answers ok again.
  app.post(MAIL_UNSUBSCRIBE_ROUTE, { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.ip !== MAIL_TRACKING_RELAY_IP && request.ip !== `::ffff:${MAIL_TRACKING_RELAY_IP}`) return reply.code(403).send({ error: "Only the site's server passes unsubscribes on." });
    const token = (request.body as { token?: unknown } | null | undefined)?.token;
    if (typeof token !== "string" || token.length < 10 || token.length > 600) return reply.code(400).send({ error: "Not an unsubscribe token." });
    const result = await service.unsubscribe([token], "one-click page");
    return result.invalid ? reply.code(400).send({ error: "Not an unsubscribe token of this Space." }) : { ok: true };
  });
  // "View in browser" (plan clipboard:2wiBJQwRzN8X step 4): the relay's `&v=<token>` page asks for the mail that recipient was sent. public-host only; the
  // token (the unsubscribe one, HMAC) is the only key; 404 when this instance did not sign it or that mail was not sent, so the relay tries no further.
  app.get(MAIL_WEB_ROUTE, { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.ip !== MAIL_TRACKING_RELAY_IP && request.ip !== `::ffff:${MAIL_TRACKING_RELAY_IP}`) return reply.code(403).send({ error: "Only the site's server shows mails." });
    const token = (request.query as { token?: unknown }).token;
    if (typeof token !== "string" || token.length < 10 || token.length > 600) return reply.code(400).send({ error: "Not a mail token." });
    const html = await service.webVersion(token);
    if (html === null) return reply.code(404).send({ error: "No such sent mail on this Space." });
    return reply.header("cache-control", "no-store").header("x-robots-tag", "noindex").type("text/html; charset=utf-8").send(html);
  });
  app.get(MAIL_SITE_FEED_ROUTE, { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.ip !== MAIL_TRACKING_RELAY_IP && request.ip !== `::ffff:${MAIL_TRACKING_RELAY_IP}`) return reply.code(403).send({ error: "Only the site's server reads this feed." });
    const given = Buffer.from(String(request.headers["x-space-site-key"] ?? ""));
    if (given.length !== key.length || !timingSafeEqual(given, key)) return reply.code(401).send({ error: "Wrong site key." });
    // The owner whose sender writes from the site's domain (one operator per instance).
    let owner: string | null = null;
    for (const candidate of await repository.contactOwners()) {
      if ((await repository.listSenders(candidate)).some(isSiteSender)) { owner = candidate; break; }
    }
    if (!owner) return reply.code(404).send({ error: `No sender writes from ${MAIL_SITE_FEED_SITE}.` });
    // Scope (plan step 3): the site's senders, their campaigns and those campaigns' lists, templates and opens, plus the lists named for the
    // site ("example.invalid customers …", "UnboxExpert …"). public-host hosts other sites, so the owner's other outreach never leaves Space.
    const senders = (await service.senders(owner)).filter(isSiteSender);
    const campaigns = (await repository.listCampaigns(owner, {})).filter((campaign) => senders.some((sender) => sender.id === campaign.senderId));
    const campaignLists = new Set(campaigns.flatMap((campaign) => campaign.listIds));
    const lists = (await service.lists(owner)).filter((list) => campaignLists.has(list.id) || SITE_LIST_NAME.test(list.name));
    const query = request.query as { listId?: unknown; offset?: unknown; html?: unknown; archive?: unknown };
    // Newsletter archive and admin preview (plan vxtgxdSGE586 step 4): mails for nobody in particular (`archiveVersion`). `archive` lists the DONE
    // campaigns whose mail needs no recipient's values (the public archive shows only these); `html` is one campaign's mail, any status (admin preview).
    if (query.archive !== undefined) {
      const siteOwner = owner;
      const done = await Promise.all(campaigns.filter((campaign) => campaign.status === "DONE")
        .map(async (campaign) => ({ campaign, mail: await service.archiveVersion(siteOwner, campaign) })));
      return { campaigns: done.flatMap(({ campaign, mail }) => mail ? [{ id: campaign.id, doneAt: campaign.updatedAt, subject: mail.subject, preheader: mail.preheader, language: mail.language }] : []) };
    }
    if (typeof query.html === "string") {
      const found = campaigns.find((campaign) => campaign.id === query.html);
      const mail = found ? await service.archiveVersion(owner, found) : null;
      if (!found || !mail) return reply.code(404).send({ error: "No such campaign in this site's feed, or its mail needs a recipient's values." });
      return { id: found.id, status: found.status, doneAt: found.status === "DONE" ? found.updatedAt : null, ...mail };
    }
    if (typeof query.listId === "string") {
      if (!lists.some((list) => list.id === query.listId)) return reply.code(404).send({ error: "No such list in this site's feed." });
      const offset = Math.max(0, Number.parseInt(String(query.offset ?? "0"), 10) || 0);
      const contacts = await service.contacts(owner, { listId: query.listId, limit: MEMBERS_PAGE, offset });
      return { offset, pageSize: MEMBERS_PAGE, contacts: contacts.map(({ id, address, name, health, createdAt }) => ({ id, address, name, health, createdAt })) };
    }
    // Inbox or spam (plan vxtgxdSGE586 step 6d): the latest seed placement check, without the raw verdict headers.
    const latestSeeds = async (owner: string, campaignId: string) => {
      const check = (await repository.listChecks(owner, { campaignId })).find((row) => row.kind === "SEED");
      return check ? { status: check.status, score: check.score, createdAt: check.createdAt,
        placements: ((check.details.placements ?? []) as Array<Record<string, unknown>>).map(({ headers: _headers, ...placement }) => placement) } : null;
    };
    // Delivery (plan vxtgxdSGE586 step 6a/6b): the DMARC aggregate and TLS-RPT reports about the site's domain, newest first.
    const aboutSite = (check: { kind: string; details: Record<string, unknown> }) => check.kind === "DMARC_REPORT" ? check.details.domain === MAIL_SITE_FEED_SITE
      : check.kind === "TLS_REPORT" && ((check.details.policies ?? []) as Array<{ domain?: unknown }>).some((policy) => policy.domain === MAIL_SITE_FEED_SITE);
    const deliveryReports = (await repository.listChecks(owner, {})).filter(aboutSite).map(({ kind, status, score, details, createdAt }) => ({ ...details, kind, status, score, createdAt }));
    const campaignIds = new Set(campaigns.map((campaign) => campaign.id));
    const templateIds = new Set(campaigns.map((campaign) => campaign.templateId));
    return {
      // A sender's config names its route and kept-key ids only; the feed leaves it out all the same.
      senders: senders.map(({ config: _config, ...sender }) => sender),
      campaigns: await Promise.all(campaigns.map(async (campaign) => ({ ...campaign, stats: await repository.campaignStats(owner, campaign.id), seeds: await latestSeeds(owner, campaign.id) }))),
      templates: (await service.templates(owner)).filter((template) => templateIds.has(template.id)),
      lists,
      deliveryReports,
      opens: (await repository.trackedMessages(owner)).filter((message) => message.campaignId !== null && campaignIds.has(message.campaignId))
    };
  });
}
