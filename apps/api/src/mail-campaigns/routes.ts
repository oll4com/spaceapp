import type {} from "../request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { mailAddressSchema, mailCampaignCreateSchema, mailCampaignIdSchema, mailCampaignStatusSchema, mailCampaignUpdateSchema, mailConsentBasisSchema, mailContactIdSchema, mailHealthSchema, mailListCreateSchema, mailListIdSchema,
  MAIL_WARMUP_DAILY, mailSenderCreateSchema, mailSenderIdSchema, mailSenderUpdateSchema, mailSuppressionInputSchema, mailSuppressionReasonSchema, mailTemplateContentPatchSchema, mailTemplateCreateSchema, mailTemplateIdSchema, normalizeSuppressionPattern,
  type MailMadeBy, type Pane } from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { ImportSource, MailCampaignsService } from "./service.js";

// Mail Campaigns routes (plan clipboard:IJ2ovfLg1Lbw). The same handlers serve the operator (`/api/mail-campaigns/*`, session) and every
// agent (`/api/cli/mail-campaigns/*`, a CLI pane's bridge token; the owner is the room's). Only a person lifts a suppression, relabels a
// list's consent basis or approves a campaign; a paused one resumes on a person's word or, while "May send to third parties" is on, an agent's.
// No route here sends mail.
export const cliMailCampaignsPathPrefix = "/api/cli/mail-campaigns/";

interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface MailCampaignsRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane">;
  routeOptions: Record<string, unknown>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  authenticatedOwner(request: FastifyRequest): Promise<string>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** Nous on with "May send to third parties" (nous/wiring.ts `coversApproval`): what that allowance covers is no person's alone. */
  coversApproval?(owner: string): Promise<boolean>;
}
export interface MailCampaignsAgentRouteDependencies extends Omit<MailCampaignsRouteDependencies, "authenticatedOwner"> {
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims; runtimeId?: string | null } | null>;
}

/** Proof, automation and agent broker sessions never lift a suppression or change a list's consent basis: a person only. */
export function assertMailCampaignPerson(request: FastifyRequest): void {
  const user = request.user;
  const principal = request.sessionPrincipal ?? user?.id ?? "";
  if (!user || user.proofScope || user.automationScope || user.brokerScope || principal.startsWith("user:operator-proof") || principal.startsWith("user:proof")) {
    throw Object.assign(new Error("Only the operator, signed in to Space, does this."), { statusCode: 403 });
  }
}

const bool = z.enum(["true", "false"]).transform((value) => value === "true");
// A page size: the lists below page with offset.
const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const templateParams = z.object({ id: mailTemplateIdSchema }).strict();
const senderParams = z.object({ id: mailSenderIdSchema }).strict();
const campaignParams = z.object({ id: mailCampaignIdSchema }).strict();
const listParams = z.object({ id: mailListIdSchema }).strict();
const madeByModel = z.string().trim().min(1).max(120);
const templateUpdateSchema = mailTemplateContentPatchSchema.extend({ name: z.string().trim().min(1).max(120).optional(), madeByModel: madeByModel.optional() }).strict();
const listUpdateSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(1000).optional(),
  consentBasis: mailConsentBasisSchema.optional(), archived: z.boolean().optional() }).strict();
const importSchema = z.union([
  z.object({ csv: z.string().min(1).max(2_000_000), overwrite: z.boolean().optional() }).strict(),
  z.object({ text: z.string().min(1).max(500_000) }).strict(),
  z.object({ rows: z.array(z.object({ address: z.string().max(320), name: z.string().max(200).optional(), attributes: z.record(z.string(), z.string().max(500)).optional() }).strict()).min(1),
    overwrite: z.boolean().optional() }).strict(),
  z.object({ thread: z.object({ account: mailAddressSchema, threadId: z.string().min(1).max(200) }).strict() }).strict()
]);
const contactsQuery = z.object({ q: z.string().trim().max(200).optional(), health: z.union([mailHealthSchema, z.array(mailHealthSchema)]).optional(),
  limit: limit(500, 100), offset: z.coerce.number().int().min(0).default(0) }).strict();
const suppressionsBody = z.object({ items: z.array(z.object({ pattern: z.string().max(320), reason: mailSuppressionReasonSchema, note: z.string().max(500).optional() }).strict()).min(1),
  source: z.string().trim().min(1).max(200) }).strict();

interface Caller { owner: string; madeBy(model?: string): MailMadeBy; paneId: string | null; person: boolean; by: string }

function registerOperations(app: FastifyInstance, service: MailCampaignsService, deps: Omit<MailCampaignsRouteDependencies, "authenticatedOwner">, prefix: string,
  caller: (request: FastifyRequest, reply: FastifyReply) => Promise<Caller | null>): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  function route(method: "get" | "post" | "patch" | "delete", path: string, handler: (who: Caller, request: FastifyRequest) => Promise<unknown>) {
    app[method](`${prefix}${path}`, routeOptions, async (request, reply) => {
      const who = await caller(request, reply);
      if (!who) return reply;
      return handler(who, request);
    });
  }
  const health = (value: z.infer<typeof contactsQuery>["health"]) => value === undefined ? undefined : Array.isArray(value) ? value : [value];

  route("get", "templates", async (who, request) => ({ templates: await service.templates(who.owner, parseQuery(z.object({ archived: bool.optional() }).strict(), request.query).archived) }));
  route("post", "templates", async (who, request) => {
    const input = parseBody(mailTemplateCreateSchema.extend({ madeByModel: madeByModel.optional() }).strict(), request.body ?? {});
    const { madeByModel: model, ...template } = input;
    const created = await service.createTemplate(who.owner, template, who.madeBy(model), who.paneId);
    await deps.audit(request, "mail_campaigns.template.create", created.template.id, { fingerprint: created.version.fingerprint });
    return created;
  });
  route("get", "templates/:id", async (who, request) => service.template(who.owner, parseQuery(templateParams, request.params).id,
    parseQuery(z.object({ version: z.coerce.number().int().min(1).optional() }).strict(), request.query).version));
  route("patch", "templates/:id", async (who, request) => {
    const { id } = parseQuery(templateParams, request.params);
    const { madeByModel: model, ...patch } = parseBody(templateUpdateSchema, request.body ?? {});
    const updated = await service.updateTemplate(who.owner, id, patch, who.madeBy(model));
    await deps.audit(request, "mail_campaigns.template.update", id, { version: updated.version.version, fingerprint: updated.version.fingerprint });
    return updated;
  });
  route("post", "templates/:id/archive", async (who, request) => ({ template: await service.archiveTemplate(who.owner, parseQuery(templateParams, request.params).id,
    parseBody(z.object({ archived: z.boolean() }).strict(), request.body ?? {}).archived) }));
  route("post", "templates/:id/preview", async (who, request) => {
    const input = parseBody(z.object({ version: z.number().int().min(1).optional(), values: z.record(z.string(), z.string().max(2000)).default({}) }).strict(), request.body ?? {});
    return service.previewTemplate(who.owner, parseQuery(templateParams, request.params).id, input.version, input.values);
  });

  route("get", "lists", async (who, request) => ({ lists: await service.lists(who.owner, parseQuery(z.object({ archived: bool.optional() }).strict(), request.query).archived) }));
  route("post", "lists", async (who, request) => {
    const list = await service.createList(who.owner, parseBody(mailListCreateSchema, request.body ?? {}));
    await deps.audit(request, "mail_campaigns.list.create", list.id, { consentBasis: list.consentBasis, by: who.by });
    return { list };
  });
  route("get", "lists/:id", async (who, request) => service.list(who.owner, parseQuery(listParams, request.params).id));
  route("patch", "lists/:id", async (who, request) => {
    const { id } = parseQuery(listParams, request.params);
    const { archived, ...patch } = parseBody(listUpdateSchema, request.body ?? {});
    // A consent basis decides how much a list may receive: an agent sets it when it makes the list, only a person changes it later.
    if (patch.consentBasis) { if (!who.person) throw new SpaceConflictError("Only the operator changes a list's consent basis."); assertMailCampaignPerson(request); }
    const list = await service.updateList(who.owner, id, { ...patch, ...(archived === undefined ? {} : { archivedAt: archived ? new Date().toISOString() : null }) });
    await deps.audit(request, "mail_campaigns.list.update", id, { ...patch, archived });
    return { list };
  });
  route("get", "lists/:id/contacts", async (who, request) => {
    const query = parseQuery(contactsQuery, request.query);
    return { contacts: await service.contacts(who.owner, { listId: parseQuery(listParams, request.params).id, q: query.q, health: health(query.health), limit: query.limit, offset: query.offset }) };
  });
  route("post", "lists/:id/import", async (who, request) => {
    const { id } = parseQuery(listParams, request.params);
    const result = await service.importContacts(who.owner, id, parseBody(importSchema, request.body ?? {}) as ImportSource, who.by);
    await deps.audit(request, "mail_campaigns.list.import", id, { ...result });
    return result;
  });
  route("post", "lists/:id/import-mailbox", async (who, request) => {
    const { id } = parseQuery(listParams, request.params);
    const input = parseBody(z.object({ account: mailAddressSchema, days: z.number().int().min(1).max(3650).default(365) }).strict(), request.body ?? {});
    const result = await service.importMailbox(who.owner, id, input, who.by);
    await deps.audit(request, "mail_campaigns.list.import_mailbox", id, { ...result, days: input.days });
    return result;
  });
  route("post", "lists/:id/remove", async (who, request) => {
    const { id } = parseQuery(listParams, request.params);
    const result = await service.removeMembers(who.owner, id, parseBody(z.object({ contactIds: z.array(mailContactIdSchema).min(1) }).strict(), request.body ?? {}).contactIds);
    await deps.audit(request, "mail_campaigns.list.remove", id, result);
    return result;
  });

  route("get", "contacts", async (who, request) => {
    const query = parseQuery(contactsQuery, request.query);
    return { contacts: await service.contacts(who.owner, { q: query.q, health: health(query.health), limit: query.limit, offset: query.offset }) };
  });
  route("get", "contacts/:ref", async (who, request) => service.contact(who.owner, parseQuery(z.object({ ref: z.string().min(3).max(320) }).strict(), request.params).ref));

  route("get", "suppressions", async (who, request) => ({ suppressions: await service.suppressions(who.owner, parseQuery(z.object({ q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).optional() }).strict(), request.query)) }));
  route("post", "suppressions", async (who, request) => {
    const input = parseBody(suppressionsBody, request.body ?? {});
    const items = input.items.map((item) => mailSuppressionInputSchema.safeParse({ pattern: item.pattern, reason: item.reason, source: input.source, note: item.note ?? "" }));
    const valid = items.flatMap((item) => item.success ? [item.data] : []);
    const result = await service.addSuppressions(who.owner, valid);
    await deps.audit(request, "mail_campaigns.suppression.add", null, { ...result, invalid: items.length - valid.length, source: input.source });
    return { ...result, invalid: items.length - valid.length };
  });
  route("get", "events", async (who, request) => ({ events: await service.events(who.owner, parseQuery(z.object({ campaignId: mailCampaignIdSchema.optional(), limit: z.coerce.number().int().min(1).optional() }).strict(), request.query)) }));
  route("get", "senders", async (who) => ({ senders: await service.senders(who.owner) }));
  route("post", "senders", async (who, request) => {
    const sender = await service.createSender(who.owner, parseBody(mailSenderCreateSchema, request.body ?? {}), who.by);
    await deps.audit(request, "mail_campaigns.sender.create", sender.id, { address: sender.address, route: sender.config.route });
    return { sender };
  });
  route("patch", "senders/:id", async (who, request) => {
    const { id } = parseQuery(senderParams, request.params);
    const sender = await service.updateSender(who.owner, id, parseBody(mailSenderUpdateSchema, request.body ?? {}));
    await deps.audit(request, "mail_campaigns.sender.update", id, { status: sender?.status });
    return { sender };
  });
  // ---- campaigns (nothing here approves: that is the operator's route below) ----------------
  route("get", "campaigns", async (who, request) => {
    const query = parseQuery(z.object({ status: z.union([mailCampaignStatusSchema, z.array(mailCampaignStatusSchema)]).optional() }).strict(), request.query);
    return { campaigns: await service.campaigns(who.owner, query.status === undefined ? undefined : [query.status].flat()) };
  });
  route("post", "campaigns", async (who, request) => {
    const campaign = await service.createCampaign(who.owner, parseBody(mailCampaignCreateSchema, request.body ?? {}), who.by, who.paneId);
    await deps.audit(request, "mail_campaigns.campaign.create", campaign.id, { senderId: campaign.senderId, listIds: campaign.listIds });
    return { campaign };
  });
  route("get", "campaigns/:id", async (who, request) => service.results(who.owner, parseQuery(campaignParams, request.params).id));
  route("get", "campaigns/:id/preview", async (who, request) => service.preview(who.owner, parseQuery(campaignParams, request.params).id,
    parseQuery(z.object({ q: z.string().trim().max(200).optional(), offset: z.coerce.number().int().min(0).default(0), limit: limit(200, 50) }).strict(), request.query)));
  route("get", "campaigns/:id/preview/:contactId", async (who, request) => {
    const params = parseQuery(z.object({ id: mailCampaignIdSchema, contactId: mailContactIdSchema }).strict(), request.params);
    return service.previewMail(who.owner, params.id, params.contactId);
  });
  route("patch", "campaigns/:id", async (who, request) => {
    const { id } = parseQuery(campaignParams, request.params);
    const campaign = await service.updateCampaign(who.owner, id, parseBody(mailCampaignUpdateSchema, request.body ?? {}));
    await deps.audit(request, "mail_campaigns.campaign.update", id, { status: campaign.status });
    return { campaign };
  });
  route("post", "campaigns/:id/test", async (who, request) => {
    const { id } = parseQuery(campaignParams, request.params);
    const result = await service.testCampaign(who.owner, id, parseBody(z.object({ seeds: z.array(mailAddressSchema).max(10).optional() }).strict(), request.body ?? {}).seeds);
    await deps.audit(request, "mail_campaigns.campaign.test", id, { seeds: result.sent.length });
    return result;
  });
  route("post", "campaigns/:id/submit", async (who, request) => {
    const { id } = parseQuery(campaignParams, request.params);
    const campaign = await service.submit(who.owner, id);
    await deps.audit(request, "mail_campaigns.campaign.submit", id, { fingerprint: campaign.fingerprint });
    return { campaign };
  });
  route("post", "campaigns/:id/pause", async (who, request) => ({ campaign: await service.pause(who.owner, parseQuery(campaignParams, request.params).id, who.by) }));
  // Operator 2/11 15:01 BKK (space_memory fe0f5efe): no person-only gate stops what an allowance covers. A person resumes, an agent while "May send to
  // third parties" is on (Nous: space_mail_campaign_resume); with it off only the operator does.
  route("post", "campaigns/:id/resume", async (who, request) => {
    if (who.person) assertMailCampaignPerson(request);
    else if (!await deps.coversApproval?.(who.owner).catch(() => false)) {
      throw Object.assign(new Error("\"May send to third parties\" is off: only the operator resumes a campaign, in Mail Copilot → Campaigns."), { statusCode: 403 });
    }
    const { id } = parseQuery(campaignParams, request.params);
    const by = who.person ? "the operator" : who.paneId ?? who.by;
    const campaign = await service.resume(who.owner, id, by);
    await deps.audit(request, "mail_campaigns.campaign.resume", id, { by });
    return { campaign };
  });
  route("post", "campaigns/:id/stop", async (who, request) => {
    const { id } = parseQuery(campaignParams, request.params);
    const campaign = await service.stop(who.owner, id, who.by);
    await deps.audit(request, "mail_campaigns.campaign.stop", id, {});
    return { campaign };
  });
  // ---- the deliverability lab ----------------------------------------------------------------------------
  route("post", "campaigns/:id/lab", async (who, request) => service.runLab(who.owner, parseQuery(campaignParams, request.params).id));
  route("get", "campaigns/:id/lab", async (who, request) => service.labResults(who.owner, parseQuery(campaignParams, request.params).id));
  route("get", "campaigns/:id/lab/mime", async (who, request) => service.labMime(who.owner, parseQuery(campaignParams, request.params).id));
  route("post", "campaigns/:id/lab/record", async (who, request) => ({ check: await service.recordLab(who.owner, parseQuery(campaignParams, request.params).id, parseBody(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("SPAMASSASSIN"), sha256: z.string().regex(/^[0-9a-f]{64}$/), score: z.number().min(-100).max(1000), rules: z.array(z.string().max(120)).max(200).default([]) }).strict(),
    z.object({ kind: z.literal("AUTH_VERIFIER"), spf: z.boolean(), dkim: z.boolean(), dmarc: z.boolean(), score: z.number().min(-100).max(1000).nullable().default(null), note: z.string().max(500).optional() }).strict()
  ]), request.body ?? {})) }));
  route("post", "campaigns/:id/lab/seeds", async (who, request) => ({ check: await service.seedPlacement(who.owner, parseQuery(campaignParams, request.params).id) }));
  // ---- address health and what came back from our mail ------------------------------------------------------
  route("post", "signals", async (who, request) => {
    const input = parseBody(z.object({ // Technical: request body size; scripts/space-mail-lab.mjs posts 25 a call.
      messages: z.array(z.string().max(560_000)).min(1).max(50), source: z.string().trim().min(1).max(200) }).strict(), request.body ?? {});
    return service.signals(who.owner, input.messages.map((message) => Buffer.from(message, "base64")), input.source);
  });
  route("post", "health/check", async (who, request) => {
    const input = parseBody(z.object({ listId: mailListIdSchema.optional(), contactIds: z.array(mailContactIdSchema).optional() }).strict(), request.body ?? {});
    return service.checkHealth(who.owner, input);
  });
  // Tokens the public one-click endpoint collected: each verifies itself (HMAC), so whoever passes them on proves nothing by it.
  route("post", "unsubscribes", async (_who, request) => {
    const input = parseBody(z.object({ // Technical: request body size; scripts/space-mail-lab.mjs posts 1,000 a call.
      tokens: z.array(z.string().min(10).max(600)).min(1).max(1000), source: z.string().trim().min(1).max(200) }).strict(), request.body ?? {});
    return service.unsubscribe(input.tokens, input.source);
  });
  route("post", "senders/:id/check", async (who, request) => {
    const { id } = parseQuery(senderParams, request.params);
    const result = await service.checkSender(who.owner, id);
    await deps.audit(request, "mail_campaigns.sender.check", id, { status: result.sender.status });
    return result;
  });
  // Warm-up stage and bulk are open to every caller (operator 2/11 15:01 BKK: Nous and agents may do what he may); the actor is recorded.
  route("post", "senders/:id/warmup", async (who, request) => {
    const { id } = parseQuery(senderParams, request.params);
    const sender = await service.setSenderWarmup(who.owner, id, parseBody(z.object({ stage: z.number().int().min(0).max(MAIL_WARMUP_DAILY.length) }).strict(), request.body ?? {}).stage, who.by);
    await deps.audit(request, "mail_campaigns.sender.warmup", id, { stage: sender.warmup.stage, by: who.by });
    return { sender };
  });
  route("post", "senders/:id/bulk", async (who, request) => {
    const { id } = parseQuery(senderParams, request.params);
    const sender = await service.setSenderBulk(who.owner, id, parseBody(z.object({ bulk: z.boolean() }).strict(), request.body ?? {}).bulk, who.by);
    await deps.audit(request, "mail_campaigns.sender.bulk", id, { bulk: sender.bulk, by: who.by });
    return { sender };
  });
}

export function registerMailCampaignsRoutes(app: FastifyInstance, service: MailCampaignsService, deps: MailCampaignsRouteDependencies): void {
  registerOperations(app, service, deps, "/api/mail-campaigns/", async (request) => {
    const owner = await deps.authenticatedOwner(request);
    return { owner, madeBy: () => ({ by: "OPERATOR" }), paneId: null, person: true, by: "operator" };
  });
  // A campaign reaches customers only on a person's approval of what the card showed (Nous's under "May send": space_mail_campaign_approve).
  app.post("/api/mail-campaigns/campaigns/:id/decide", deps.routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    assertMailCampaignPerson(request);
    const { id } = deps.parseQuery(campaignParams, request.params);
    const input = deps.parseBody(z.object({ decision: z.enum(["approve", "decline"]), fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(), note: z.string().trim().max(500).optional() }).strict(), request.body ?? {});
    const display = await service.decide(owner, id, input.decision, { who: request.user!.id, via: "RAIL", decisionId: null, ...(input.note ? { note: input.note } : {}),
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}) });
    await deps.audit(request, `mail_campaigns.campaign.${input.decision}`, id, {});
    return { display, campaign: await service.campaign(owner, id) };
  });
  app.delete("/api/mail-campaigns/suppressions", deps.routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    assertMailCampaignPerson(request);
    const pattern = normalizeSuppressionPattern(deps.parseBody(z.object({ pattern: z.string().min(3).max(320) }).strict(), request.body ?? {}).pattern);
    if (!pattern) throw new SpaceConflictError("Not an address or @domain.");
    const result = await service.removeSuppression(owner, pattern);
    await deps.audit(request, "mail_campaigns.suppression.remove", null, { pattern, ...result });
    return result;
  });
}

export function registerMailCampaignsAgentRoutes(app: FastifyInstance, service: MailCampaignsService, deps: MailCampaignsAgentRouteDependencies): void {
  registerOperations(app, service, deps, cliMailCampaignsPathPrefix, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return null;
    const room = await deps.store.getRoom(bridge.claims.roomId);
    if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; use Mail Campaigns from a pane of a signed-in operator's room.");
    const pane: Pane = await deps.store.getPane(bridge.claims.paneId);
    return { owner: room.ownerUserId, paneId: pane.id, person: false, by: `pane:${pane.id}`,
      madeBy: (model) => ({ by: "AGENT", runtime: bridge.runtimeId ?? "unknown", model: model ?? "unknown", paneId: pane.id }) };
  });
}
