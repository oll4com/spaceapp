import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  mailComposeInputSchema, mailCopilotEventInputSchema, mailCopilotMemoryCreateSchema, mailCopilotMemoryQuerySchema, mailCopilotMemoryUpdateSchema, mailCopilotNextRequestSchema,
  mailCopilotQuestionAskSchema, mailCopilotQuestionWaitSchema, mailCopilotReportRequestSchema, mailCopilotReviewRequestSchema, mailCopilotReviewWaitSchema, mailThreadActionSchema,
  mailRuleProposalSchema, mailRuleStatusSchema, mailThreadsQuerySchema, resolveMailCopilotPaneMetadata, type Pane
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { MailCopilotService } from "./service.js";

// Agent-facing routes of the Mail Copilot pane, reached with the pane-scoped CLI bridge token. The owner is the
// room owner; the agent gets mail as text, memories, work items and decisions, never a token.
export const cliMailCopilotPathPrefix = "/api/cli/mail-copilot/";
const ruleIdSchema = z.string().regex(/^mailrule:[A-Za-z0-9_-]{6,80}$/);

export interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface MailCopilotAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
}

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const threadParamsSchema = z.object({ threadId: z.string().min(1).max(200) }).strict();
const memoryParamsSchema = z.object({ id: z.string().regex(/^mailmem:[A-Za-z0-9_-]{6,80}$/) }).strict();
const recallSchema = z.object({
  query: z.string().trim().max(500).optional(), contactEmail: emailSchema.optional(), domain: z.string().trim().toLowerCase().max(200).optional(),
  kinds: z.array(z.enum(["CONTACT", "STYLE", "TEMPLATE", "FACT", "LESSON", "PREFERENCE"])).max(6).optional(), limit: z.number().int().min(1).max(100).optional()
}).strict();

export function registerMailCopilotAgentRoutes(app: FastifyInstance, service: MailCopilotService, deps: MailCopilotAgentRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  const route = (path: string) => `${cliMailCopilotPathPrefix}${path}`;

  async function context(request: FastifyRequest, reply: FastifyReply): Promise<{ owner: string; pane: Pane } | null> {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return null;
    const room = await deps.store.getRoom(bridge.claims.roomId);
    if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; open the Mail Copilot pane from a signed-in operator account.");
    const pane = await deps.store.getPane(bridge.claims.paneId);
    if (pane.mode !== "MAIL_COPILOT") throw new SpaceConflictError("Mail Copilot tools belong to the CLI session of a Mail Copilot pane.");
    return { owner: room.ownerUserId, pane };
  }

  app.get(route("state"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const metadata = resolveMailCopilotPaneMetadata(bridge.pane.mailCopilotMetadata);
    return { paneId: bridge.pane.id, settings: metadata.settings, view: metadata.view ?? null, accounts: await service.accounts(bridge.owner, bridge.pane), run: await service.runView(bridge.owner, bridge.pane.id) };
  });
  // What the operator looks at right now, with that conversation as text, so "reply to this email" needs one call.
  app.get(route("view"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const view = resolveMailCopilotPaneMetadata(bridge.pane.mailCopilotMetadata).view ?? null;
    const thread = view?.threadId && view.account !== "all" ? await service.thread(bridge.owner, bridge.pane, view.account, view.threadId).catch(() => null) : null;
    return { view, thread: thread ? { ...thread, messages: thread.messages.map((message) => ({ ...message, html: null })) } : null };
  });

  app.get(route("accounts"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return { accounts: await service.accounts(bridge.owner, bridge.pane) };
  });
  app.get(route("labels"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const query = parseQuery(z.object({ account: z.union([z.literal("all"), emailSchema]).default("all") }).strict(), request.query ?? {});
    return { labels: await service.labels(bridge.owner, bridge.pane, query.account) };
  });
  app.post(route("threads"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return service.threads(bridge.owner, bridge.pane, parseBody(mailThreadsQuerySchema, request.body ?? {}));
  });
  app.get(route("threads/:threadId"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const params = parseQuery(threadParamsSchema, request.params);
    const query = parseQuery(z.object({ account: emailSchema }).strict(), request.query ?? {});
    const thread = await service.thread(bridge.owner, bridge.pane, query.account, params.threadId);
    // Text only: the agent never receives HTML.
    return { thread: { ...thread, messages: thread.messages.map((message) => ({ ...message, html: null })) } };
  });
  app.post(route("threads/:threadId/modify"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const params = parseQuery(threadParamsSchema, request.params);
    const { ruleId, ...input } = parseBody(mailThreadActionSchema.extend({ ruleId: ruleIdSchema.optional() }), request.body ?? {});
    await service.modify(bridge.owner, bridge.pane, params.threadId, input, "agent", ruleId);
    const type = input.action === "archive" ? "ARCHIVED" : input.action === "trash" ? "TRASHED" : input.action === "label" || input.action === "unlabel" || input.action === "move" ? "LABELED" : input.action === "star" ? "STARRED" : null;
    const verb = input.action === "label" ? "labeled" : input.action === "unlabel" ? "unlabeled" : input.action === "move" ? "moved" : `${input.action}d`;
    if (type) await service.record(bridge.owner, { paneId: bridge.pane.id, type, accountEmail: input.account, threadId: params.threadId, message: `The copilot ${verb} a conversation`, payload: { action: input.action, labelIds: input.labelIds ?? [] } });
    await deps.audit(request, "mail_copilot.agent.modify", params.threadId, { account: input.account, action: input.action });
    return { ok: true };
  });
  // How the operator handled mail from a sender (and of a subject's shape) on one account; space_mail_next carries it per item.
  app.post(route("habits"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const input = parseBody(z.object({ account: emailSchema, from: z.string().trim().min(3).max(320), subject: z.string().max(1000).optional() }).strict(), request.body ?? {});
    return service.habits(bridge.owner, bridge.pane, input);
  });
  app.post(route("draft"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const input = parseBody(mailComposeInputSchema, request.body ?? {});
    const draft = await service.draft(bridge.owner, bridge.pane, input);
    await service.record(bridge.owner, { paneId: bridge.pane.id, type: "DRAFTED", accountEmail: input.account, threadId: input.threadId ?? null, message: `The copilot drafted: ${input.subject || "(no subject)"} → ${input.to.join(", ")}`, payload: { draftId: draft.draftId, draftMessageId: draft.messageId } });
    return draft;
  });
  app.post(route("draft/delete"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const input = parseBody(z.object({ account: emailSchema, draftId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict(), request.body ?? {});
    await service.deleteDraft(bridge.owner, bridge.pane, input.account, input.draftId);
    await deps.audit(request, "mail_copilot.agent.draft_delete", input.draftId, { account: input.account });
    return { ok: true };
  });
  // Any mail or draft, at every autonomy (operator decision 2026-10-26): a message to the Trash, a draft discarded.
  app.post(route("delete"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const gmailId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
    const input = parseBody(z.object({ account: emailSchema, messageId: gmailId.optional(), draftId: gmailId.optional() }).strict()
      .refine((value) => Boolean(value.messageId) !== Boolean(value.draftId), "Give exactly one of messageId or draftId."), request.body ?? {});
    await service.deleteMail(bridge.owner, bridge.pane, input);
    await deps.audit(request, "mail_copilot.agent.delete", input.messageId ?? input.draftId ?? null, { account: input.account, kind: input.draftId ? "draft" : "message" });
    return { ok: true, ...(input.messageId ? { trashed: input.messageId } : { discarded: input.draftId }) };
  });
  app.post(route("send"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const { ruleId, ...input } = parseBody(mailComposeInputSchema.extend({ ruleId: ruleIdSchema.optional() }), request.body ?? {});
    const sent = await service.send(bridge.owner, bridge.pane, input, "agent", ruleId);
    await deps.audit(request, "mail_copilot.agent.send", sent.messageId, { account: input.account, recipients: input.to.length + input.cc.length + input.bcc.length });
    return sent;
  });

  app.post(route("next"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return service.nextItem(bridge.owner, bridge.pane, parseBody(mailCopilotNextRequestSchema, request.body ?? {}));
  });
  app.post(route("report"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return { event: await service.reportItem(bridge.owner, bridge.pane, parseBody(mailCopilotReportRequestSchema, request.body ?? {})) };
  });
  app.post(route("events"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return { event: await service.record(bridge.owner, { paneId: bridge.pane.id, ...parseBody(mailCopilotEventInputSchema, request.body ?? {}) }) };
  });

  // Rules: the agent reads the approved ones (to name a ruleId) and proposes new ones for the operator to decide.
  app.get(route("rules"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const query = parseQuery(z.object({ status: z.string().optional() }).strict(), request.query ?? {});
    const status = query.status ? query.status.split(",").map((entry) => mailRuleStatusSchema.parse(entry.trim())) : undefined;
    return { rules: await service.listRules(bridge.owner, { status }) };
  });
  app.post(route("rules/propose"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const rule = await service.proposeRule(bridge.owner, bridge.pane, parseBody(mailRuleProposalSchema, request.body ?? {}));
    await deps.audit(request, "mail_copilot.agent.rule_propose", rule.id, { name: rule.name });
    return { rule };
  });
  app.post(route("question"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return service.askQuestion(bridge.owner, bridge.pane, parseBody(mailCopilotQuestionAskSchema, request.body ?? {}));
  });
  app.post(route("question/wait"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return service.waitForAnswer(bridge.owner, parseBody(mailCopilotQuestionWaitSchema, request.body ?? {}));
  });
  app.post(route("review"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return service.requestReview(bridge.owner, bridge.pane, parseBody(mailCopilotReviewRequestSchema, request.body ?? {}));
  });
  app.post(route("review/wait"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return service.waitForReview(bridge.owner, parseBody(mailCopilotReviewWaitSchema, request.body ?? {}));
  });

  app.post(route("memory/recall"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return { memories: await service.recallMemory(bridge.owner, parseBody(recallSchema, request.body ?? {})) };
  });
  app.get(route("memory"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const query = parseQuery(mailCopilotMemoryQuerySchema, { ...raw, ...(raw.kinds ? { kinds: raw.kinds.split(",") } : {}), ...(raw.limit ? { limit: Number(raw.limit) } : {}), ...(raw.pinnedOnly ? { pinnedOnly: raw.pinnedOnly === "true" } : {}) });
    return { memories: await service.listMemory(bridge.owner, query) };
  });
  app.post(route("memory"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    return { memory: await service.rememberMemory(bridge.owner, parseBody(mailCopilotMemoryCreateSchema, request.body ?? {})) };
  });
  app.patch(route("memory/:id"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const params = parseQuery(memoryParamsSchema, request.params);
    const memory = await service.updateMemory(bridge.owner, params.id, parseBody(mailCopilotMemoryUpdateSchema, request.body ?? {}));
    if (!memory) throw new SpaceConflictError(`Memory ${params.id} was not found.`);
    return { memory };
  });
  app.delete(route("memory/:id"), routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const params = parseQuery(memoryParamsSchema, request.params);
    return { forgotten: await service.forgetMemory(bridge.owner, params.id) };
  });
}
