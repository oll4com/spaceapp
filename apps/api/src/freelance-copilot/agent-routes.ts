import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  effectiveFreelanceAutonomy, freelanceChannelEgress, FREELANCE_CHANNEL_ALIASES, FREELANCE_CHANNEL_LOGIN_URLS, FREELANCE_CHANNELS, FREELANCE_GOOGLE_SIGN_IN_CHANNELS, freelanceAccountUpdateSchema, freelanceChannelSchema, freelanceClientReadySchema,
  freelanceEventIdSchema, freelanceIncomingSchema, freelanceLeadCreateSchema, freelanceLeadIdSchema, freelanceLeadStatusSchema, freelanceLeadUpdateSchema, freelanceMemoryCreateSchema,
  freelanceMemoryIdSchema, freelanceMemoryQuerySchema, freelanceMessageCreateSchema, freelanceMessageIdSchema, freelanceMessageUpdateSchema, freelanceQuestionAskSchema, freelanceQuestionIdSchema,
  freelanceRuleProposalSchema, freelanceSendBeginSchema, freelanceSendDoneSchema, freelanceSendFailedSchema, type JobApplyCandidate, type Pane
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import { registerBookmarkAgentRoutes } from "../marketing-copilot/agent-routes.js";
import type { MarketingCopilotService } from "../marketing-copilot/service.js";
import type { FreelanceCopilotService } from "./service.js";

// Agent-facing routes of the Freelance Copilot pane, reached with the pane-scoped CLI bridge token. The owner is the
// room owner; the agent finds leads, drafts, asks and reports, and sends only through the send gate. The mailbox
// password never leaves the server: the agent receives codes, links and message texts.
export const cliFreelanceCopilotPathPrefix = "/api/cli/freelance-copilot/";

export interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface FreelanceCopilotAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane" | "getControlActor">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** The operator's Job Copilot profile (name, languages, experience) when Job Copilot is on. */
  candidate?(owner: string): Promise<JobApplyCandidate | null>;
  /** The operator's bookmarks (Marketing Copilot's store, one list per owner) when Marketing Copilot is on. */
  bookmarks?: Pick<MarketingCopilotService, "listBookmarks" | "createBookmark" | "openBookmark">;
}

const waitMs = z.number().int().min(0).max(120_000).default(60_000);
const timeoutMs = z.number().int().min(0).max(180_000).default(90_000);
const sinceMinutes = z.number().int().min(1).max(7 * 24 * 60).optional();
const mailFilter = { fromContains: z.string().trim().min(1).max(200).optional(), subjectContains: z.string().trim().min(1).max(200).optional(), sinceMinutes };

export function registerFreelanceCopilotAgentRoutes(app: FastifyInstance, service: FreelanceCopilotService, deps: FreelanceCopilotAgentRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  const route = (path: string) => `${cliFreelanceCopilotPathPrefix}${path}`;

  async function context(request: FastifyRequest, reply: FastifyReply): Promise<{ owner: string; pane: Pane; cliSessionId: string } | null> {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return null;
    const room = await deps.store.getRoom(bridge.claims.roomId);
    if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; open the Freelance Copilot pane from a signed-in operator account.");
    const pane = await deps.store.getPane(bridge.claims.paneId);
    if (pane.mode !== "FREELANCE_COPILOT") throw new SpaceConflictError("Freelance Copilot tools belong to the CLI session of a Freelance Copilot pane.");
    return { owner: room.ownerUserId, pane, cliSessionId: bridge.claims.cliSessionId };
  }
  /** Registers an agent route: resolves the bridge, then hands the owner, the pane and the request to the handler. */
  function handle(method: "get" | "post" | "patch", path: string, handler: (bridge: { owner: string; pane: Pane; cliSessionId: string }, request: FastifyRequest) => Promise<unknown>) {
    app[method](route(path), routeOptions, async (request, reply) => {
      const bridge = await context(request, reply);
      if (!bridge) return reply;
      return handler(bridge, request);
    });
  }
  const body = <TSchema extends z.ZodTypeAny>(schema: TSchema, request: FastifyRequest) => parseBody(schema, request.body ?? {});

  handle("get", "state", async ({ owner, pane }) => {
    const settings = service.settingsOf(pane);
    return {
      paneId: pane.id, settings,
      channels: Object.fromEntries(FREELANCE_CHANNELS.map((id) => [id, { ...settings.channels[id], effectiveAutonomy: effectiveFreelanceAutonomy(settings, id), egressRoute: freelanceChannelEgress(settings, id), loginUrl: FREELANCE_CHANNEL_LOGIN_URLS[id],
        ...(FREELANCE_GOOGLE_SIGN_IN_CHANNELS.includes(id) ? { signIn: "GOOGLE", alias: null } : { signIn: "EMAIL", alias: FREELANCE_CHANNEL_ALIASES[id] }) }])),
      accounts: await service.listAccounts(owner), mailbox: await service.mailboxStatus(owner), run: await service.runView(owner, pane), funnel: await service.funnel(owner)
    };
  });
  handle("post", "next", async ({ owner, pane }, request) => service.nextItem(owner, pane, body(z.object({ waitMs }).strict(), request)));
  if (deps.bookmarks) registerBookmarkAgentRoutes(handle, deps.bookmarks, deps, "freelance_copilot");
  handle("post", "report", async ({ owner, pane }, request) => service.reportItem(owner, pane, body(z.object({
    eventId: freelanceEventIdSchema, outcome: z.enum(["done", "needs_user", "skipped"]), summary: z.string().trim().min(1).max(1000), memoryIds: z.array(freelanceMemoryIdSchema).max(20).default([])
  }).strict(), request)));

  // ---- leads -------------------------------------------------------------------------------------
  handle("get", "leads", async ({ owner }, request) => {
    const query = parseQuery(z.object({ status: z.string().max(200).optional(), channel: freelanceChannelSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict(), request.query ?? {});
    return { leads: await service.listLeads(owner, { status: query.status?.split(",").map((entry) => freelanceLeadStatusSchema.parse(entry.trim())), channel: query.channel, limit: query.limit }) };
  });
  handle("get", "leads/:id", async ({ owner }, request) => service.leadDetail(owner, parseQuery(z.object({ id: freelanceLeadIdSchema }).strict(), request.params).id));
  handle("post", "leads", async ({ owner, pane }, request) => service.addLead(owner, pane, body(freelanceLeadCreateSchema, request), "AGENT"));
  handle("patch", "leads/:id", async ({ owner, pane }, request) => ({ lead: await service.updateLead(owner, pane, parseQuery(z.object({ id: freelanceLeadIdSchema }).strict(), request.params).id, body(freelanceLeadUpdateSchema, request)) }));
  handle("post", "client-ready", async ({ owner, pane }, request) => {
    const lead = await service.clientReady(owner, pane, body(freelanceClientReadySchema, request));
    await deps.audit(request, "freelance_copilot.client_ready", lead.id, { channel: lead.channel });
    return { lead };
  });

  // ---- messages ----------------------------------------------------------------------------------
  handle("post", "messages", async ({ owner, pane }, request) => service.createMessage(owner, pane, body(freelanceMessageCreateSchema, request)));
  handle("patch", "messages/:id", async ({ owner, pane }, request) => service.updateMessage(owner, pane, parseQuery(z.object({ id: freelanceMessageIdSchema }).strict(), request.params).id, body(freelanceMessageUpdateSchema, request)));
  handle("post", "messages/incoming", async ({ owner, pane }, request) => service.recordIncoming(owner, pane, body(freelanceIncomingSchema, request)));
  handle("post", "review", async ({ owner, pane }, request) => service.requestReview(owner, pane, body(z.object({ messageId: freelanceMessageIdSchema, summary: z.string().trim().min(1).max(1000).optional() }).strict(), request)));
  handle("post", "review/wait", async ({ owner }, request) => service.waitForReview(owner, body(z.object({ messageId: freelanceMessageIdSchema, waitMs }).strict(), request)));
  handle("post", "send/begin", async ({ owner, pane }, request) => {
    const message = await service.beginSend(owner, pane, body(freelanceSendBeginSchema, request).messageId);
    await deps.audit(request, "freelance_copilot.send.begin", message.id, { channel: message.channel, kind: message.kind, ruleId: message.ruleId });
    return { message };
  });
  handle("post", "send/done", async ({ owner, pane }, request) => {
    const message = await service.finishSend(owner, pane, body(freelanceSendDoneSchema, request));
    await deps.audit(request, "freelance_copilot.send.done", message.id, { channel: message.channel, kind: message.kind, url: message.sentUrl });
    return { message };
  });
  handle("post", "send/failed", async ({ owner, pane }, request) => ({ message: await service.failSend(owner, pane, body(freelanceSendFailedSchema, request)) }));

  // ---- accounts and mail -------------------------------------------------------------------------
  handle("get", "accounts", async ({ owner }) => ({ accounts: await service.listAccounts(owner) }));
  // Sign-ups use the channel aliases and phone checks are the operator's, so the personal email and phone stay out.
  handle("get", "profile", async ({ owner }) => {
    const candidate = await deps.candidate?.(owner) ?? null;
    if (!candidate) return { candidate: null };
    const { email: _email, phone: _phone, ...rest } = candidate;
    return { candidate: rest };
  });
  handle("post", "accounts", async ({ owner, pane }, request) => ({ account: await service.updateAccount(owner, pane, body(freelanceAccountUpdateSchema, request), "AGENT") }));
  handle("post", "mail/recent", async ({ owner }, request) => ({ messages: await service.recentMail(owner, body(z.object({ ...mailFilter, channel: freelanceChannelSchema.optional(), limit: z.number().int().min(1).max(20).default(10) }).strict(), request)) }));
  handle("post", "mail/read", async ({ owner }, request) => ({ mail: await service.readMail(owner, body(z.object({ uid: z.number().int().min(1) }).strict(), request).uid) }));
  handle("post", "mail/code", async ({ owner }, request) => {
    const input = body(z.object({ ...mailFilter, pattern: z.string().min(1).max(200).default("\\b(\\d{4,8})\\b"), timeoutMs }).strict(), request);
    return { result: await service.waitForCode(owner, input) };
  });
  handle("post", "mail/link", async ({ owner }, request) => {
    const input = body(z.object({ ...mailFilter, urlContains: z.string().trim().min(1).max(200).optional(), timeoutMs }).strict(), request);
    return { result: await service.findLink(owner, input) };
  });

  // ---- questions, memory, rules, notes -----------------------------------------------------------
  handle("post", "question", async ({ owner, pane }, request) => service.askQuestion(owner, pane, body(freelanceQuestionAskSchema, request)));
  handle("post", "question/wait", async ({ owner }, request) => service.waitForAnswer(owner, body(z.object({ questionId: freelanceQuestionIdSchema, waitMs }).strict(), request)));
  handle("post", "memory/recall", async ({ owner }, request) => ({ memories: await service.recallMemory(owner, body(freelanceMemoryQuerySchema, request)) }));
  handle("post", "memory", async ({ owner }, request) => ({ memory: await service.rememberMemory(owner, body(freelanceMemoryCreateSchema, request), "AGENT") }));
  handle("get", "rules", async ({ owner }) => ({ rules: await service.listRules(owner) }));
  handle("post", "rules", async ({ owner, pane }, request) => ({ rule: await service.proposeRule(owner, pane, body(freelanceRuleProposalSchema, request), "AGENT") }));
  handle("post", "note", async ({ owner, pane }, request) => {
    const input = body(z.object({ message: z.string().trim().min(1).max(1000), leadId: freelanceLeadIdSchema.optional(), needsUser: z.boolean().default(false) }).strict(), request);
    return { event: await service.note(owner, pane, input) };
  });
}
