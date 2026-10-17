import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  mailActionListQuerySchema, mailComposeInputSchema, mailCopilotEventListQuerySchema, mailCopilotFixRequestSchema, mailCopilotMemoryCreateSchema, mailCopilotMemoryQuerySchema, mailCopilotMemoryUpdateSchema, mailCopilotPaneMetadataSchema,
  mailCopilotQuestionAnswerSchema, mailCopilotReviewDecideSchema, mailCopilotViewInputSchema, mailRuleDecisionSchema, mailRuleProposalSchema, mailRuleStatusSchema, mailThreadActionSchema, mailThreadsQuerySchema, resolveMailCopilotPaneMetadata,
  type MailCopilotRun, type Pane
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { MailCopilotService } from "./service.js";
import { syncPaneAccounts } from "./sync.js";

export interface MailCopilotRouteDependencies {
  store: Pick<SpaceStore, "getPane" | "updateMailCopilotMetadata">;
  routeOptions: Record<string, unknown>;
  /** Resolves the signed-in owner; throws the API's 401 error when absent. */
  authenticatedOwner(request: FastifyRequest): Promise<string>;
  assertPaneAccess(request: FastifyRequest, pane: Pane): Promise<void>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** Sends the run's kickoff prompt into the pane's CLI (the existing pane CLI input path). */
  kickoff?(pane: Pane, run: MailCopilotRun): Promise<void>;
  now?(): string;
}

const paneParamsSchema = z.object({ id: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/) }).strict();
const paneIdSchema = z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/);
const emailSchema = z.string().trim().min(3).max(320);
const threadParamsSchema = z.object({ threadId: z.string().min(1).max(200) }).strict();
const memoryParamsSchema = z.object({ id: z.string().regex(/^mailmem:[A-Za-z0-9_-]{6,80}$/) }).strict();
const attachmentParamsSchema = z.object({ messageId: z.string().min(1).max(200), attachmentId: z.string().min(1).max(400) }).strict();

/** Operator-facing routes of the Mail Copilot pane: settings, view, and the mailbox of its Google accounts. */
export function registerMailCopilotRoutes(app: FastifyInstance, service: MailCopilotService, deps: MailCopilotRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  async function paneOf(request: FastifyRequest): Promise<Pane> {
    await deps.authenticatedOwner(request);
    const params = parseQuery(paneParamsSchema, request.params);
    const pane = await deps.store.getPane(params.id);
    await deps.assertPaneAccess(request, pane);
    if (pane.mode !== "MAIL_COPILOT") throw new SpaceConflictError("Settings belong to a Mail Copilot pane.");
    return pane;
  }
  /** Mailbox routes are owner-scoped; an optional paneId narrows the accounts to that pane's choice. */
  async function ownerAndPane(request: FastifyRequest, paneId: string | undefined): Promise<{ owner: string; pane: Pane | null }> {
    const owner = await deps.authenticatedOwner(request);
    if (!paneId) return { owner, pane: null };
    const pane = await deps.store.getPane(paneId);
    await deps.assertPaneAccess(request, pane);
    return { owner, pane: pane.mode === "MAIL_COPILOT" ? pane : null };
  }

  app.get("/api/panes/:id/mail-copilot/settings", routeOptions, async (request) => {
    const pane = await paneOf(request);
    return { metadata: resolveMailCopilotPaneMetadata(pane.mailCopilotMetadata) };
  });

  app.put("/api/panes/:id/mail-copilot/settings", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const input = parseBody(mailCopilotPaneMetadataSchema, request.body ?? {});
    // A client that does not name the operator's view keeps it.
    const current = resolveMailCopilotPaneMetadata(pane.mailCopilotMetadata);
    const metadata = { ...input, ...(input.view ?? current.view ? { view: input.view ?? current.view } : {}) };
    const updated = await deps.store.updateMailCopilotMetadata(pane.id, metadata);
    await deps.audit(request, "mail_copilot.settings.update", pane.id, { paused: metadata.settings.paused, autonomy: metadata.settings.autonomy, accounts: metadata.settings.accounts.length });
    return { metadata: resolveMailCopilotPaneMetadata(updated.mailCopilotMetadata) };
  });

  // The operator's selection (account, label, thread) so the agent can act on "this email"; debounced by the pane, never audited.
  app.put("/api/panes/:id/mail-copilot/view", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const input = parseBody(mailCopilotViewInputSchema, request.body ?? {});
    const current = resolveMailCopilotPaneMetadata(pane.mailCopilotMetadata);
    const updated = await deps.store.updateMailCopilotMetadata(pane.id, { ...current, view: { ...input, updatedAt: now() } });
    return { view: resolveMailCopilotPaneMetadata(updated.mailCopilotMetadata).view ?? null };
  });

  // ---- runs, activity, questions, reviews and memory (the rail) --------------------------------
  app.get("/api/panes/:id/mail-copilot/run", routeOptions, async (request) => {
    const pane = await paneOf(request);
    return service.runView(await deps.authenticatedOwner(request), pane.id);
  });
  app.post("/api/panes/:id/mail-copilot/run/start", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const owner = await deps.authenticatedOwner(request);
    const started = await service.startRun(owner, pane.id);
    let kickoffSent = false;
    if (started.kickoff && deps.kickoff) {
      await deps.kickoff(pane, started.run);
      await service.markKickoff(owner, started.run.id);
      kickoffSent = true;
    }
    await deps.audit(request, "mail_copilot.run.start", pane.id, { runId: started.run.id, resumed: started.resumed, kickoffSent });
    return { ...(await service.runView(owner, pane.id)), kickoffSent };
  });
  for (const action of ["pause", "stop"] as const) {
    app.post(`/api/panes/:id/mail-copilot/run/${action}`, routeOptions, async (request) => {
      const pane = await paneOf(request);
      const owner = await deps.authenticatedOwner(request);
      const run = action === "pause" ? await service.pauseRun(owner, pane.id) : await service.stopRun(owner, pane.id);
      await deps.audit(request, `mail_copilot.run.${action}`, pane.id, { runId: run.id });
      return service.runView(owner, pane.id);
    });
  }
  // "Check for new mail now": the same sync the background poller runs, for this pane's accounts.
  app.post("/api/panes/:id/mail-copilot/sync", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const owner = await deps.authenticatedOwner(request);
    const result = await syncPaneAccounts(service, owner, pane, request.log);
    await deps.audit(request, "mail_copilot.sync", pane.id, result);
    return result;
  });
  app.get("/api/mail-copilot/events", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const query = parseQuery(mailCopilotEventListQuerySchema, request.query ?? {});
    return { events: await service.listEvents(owner, query) };
  });
  app.post("/api/panes/:id/mail-copilot/answer", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const owner = await deps.authenticatedOwner(request);
    return service.answerQuestion(owner, pane, parseBody(mailCopilotQuestionAnswerSchema, request.body ?? {}));
  });
  // Rules: what the copilot may do alone under RULES autonomy; proposed by the agent, decided (or written) by the operator.
  app.get("/api/mail-copilot/rules", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const query = parseQuery(z.object({ status: z.string().optional(), account: z.string().optional() }).strict(), request.query ?? {});
    const status = query.status ? query.status.split(",").map((entry) => mailRuleStatusSchema.parse(entry.trim())) : undefined;
    return { rules: await service.listRules(owner, { status, accountEmail: query.account ?? null }) };
  });
  app.post("/api/mail-copilot/rules", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const rule = await service.createRule(owner, null, parseBody(mailRuleProposalSchema, request.body ?? {}));
    await deps.audit(request, "mail_copilot.rule.create", rule.id, { name: rule.name });
    return { rule };
  });
  app.post("/api/mail-copilot/rules/:id/decide", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: z.string().regex(/^mailrule:[A-Za-z0-9_-]{6,80}$/) }).strict(), request.params);
    const input = parseBody(mailRuleDecisionSchema, request.body ?? {});
    const rule = await service.decideRule(owner, null, params.id, input);
    await deps.audit(request, "mail_copilot.rule.decide", rule.id, { decision: input.decision });
    return { rule };
  });
  app.post("/api/panes/:id/mail-copilot/review", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(mailCopilotReviewDecideSchema, request.body ?? {});
    const decided = await service.decideReview(owner, pane, input);
    await deps.audit(request, "mail_copilot.review.decide", input.reviewId, { decision: input.decision, sent: Boolean(decided.sent) });
    return decided;
  });
  // "Send to AI": the operator hands one conversation to the copilot to check and fix what it needs.
  app.post("/api/panes/:id/mail-copilot/fix", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(mailCopilotFixRequestSchema, request.body ?? {});
    const result = await service.requestFix(owner, pane, input);
    await deps.audit(request, "mail_copilot.fix.request", input.threadId, { account: input.account, paneId: pane.id, runStarted: result.runStarted });
    return result;
  });
  // Every mail sent to the copilot to fix, with the copilot's questions, the operator's answers and the result (Activity → Sent to AI).
  app.get("/api/panes/:id/mail-copilot/fix-requests", routeOptions, async (request) => {
    const pane = await paneOf(request);
    return { requests: await service.fixRequests(await deps.authenticatedOwner(request), pane) };
  });
  // The action log itself, newest first (Activity → Your actions): what Space recorded of the operator's and the copilot's actions.
  app.get("/api/mail-copilot/actions", routeOptions, async (request) => {
    const query = parseQuery(mailActionListQuerySchema, request.query ?? {});
    const { owner, pane } = await ownerAndPane(request, query.paneId);
    return { actions: await service.actionLog(owner, pane, { account: query.account, source: query.source, limit: query.limit }) };
  });
  // What the copilot learned from the operator's own actions, per account; Forget drops a sender's rows and learned rules.
  app.get("/api/mail-copilot/habits", routeOptions, async (request) => {
    const query = parseQuery(z.object({ paneId: paneIdSchema.optional() }).strict(), request.query ?? {});
    const { owner, pane } = await ownerAndPane(request, query.paneId);
    return { habits: await service.habitList(owner, pane) };
  });
  app.delete("/api/mail-copilot/habits", routeOptions, async (request) => {
    const query = parseQuery(z.object({ paneId: paneIdSchema.optional(), account: emailSchema, sender: z.string().trim().min(3).max(320) }).strict(), request.query ?? {});
    const { owner, pane } = await ownerAndPane(request, query.paneId);
    const result = await service.forgetHabits(owner, pane, { account: query.account, sender: query.sender });
    await deps.audit(request, "mail_copilot.habits.forget", query.sender, { account: query.account, ...result });
    return result;
  });
  app.get("/api/mail-copilot/memory", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const query = parseQuery(mailCopilotMemoryQuerySchema, { ...raw, ...(raw.kinds ? { kinds: raw.kinds.split(",") } : {}), ...(raw.limit ? { limit: Number(raw.limit) } : {}), ...(raw.pinnedOnly ? { pinnedOnly: raw.pinnedOnly === "true" } : {}) });
    return { memories: await service.listMemory(owner, query) };
  });
  app.post("/api/mail-copilot/memory", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    return { memory: await service.rememberMemory(owner, parseBody(mailCopilotMemoryCreateSchema, request.body ?? {})) };
  });
  app.patch("/api/mail-copilot/memory/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(memoryParamsSchema, request.params);
    const memory = await service.updateMemory(owner, params.id, parseBody(mailCopilotMemoryUpdateSchema, request.body ?? {}));
    if (!memory) throw new SpaceConflictError(`Memory ${params.id} was not found.`);
    return { memory };
  });
  app.delete("/api/mail-copilot/memory/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(memoryParamsSchema, request.params);
    return { forgotten: await service.forgetMemory(owner, params.id) };
  });

  // ---- mailbox ---------------------------------------------------------------------------------
  const paneQuery = z.object({ paneId: paneIdSchema.optional() });

  app.get("/api/mail-copilot/accounts", routeOptions, async (request) => {
    const query = parseQuery(paneQuery.strict(), request.query ?? {});
    const { owner, pane } = await ownerAndPane(request, query.paneId);
    return { accounts: await service.accounts(owner, pane) };
  });

  app.get("/api/mail-copilot/labels", routeOptions, async (request) => {
    const query = parseQuery(paneQuery.extend({ account: z.union([z.literal("all"), emailSchema]).default("all") }).strict(), request.query ?? {});
    const { owner, pane } = await ownerAndPane(request, query.paneId);
    return { labels: await service.labels(owner, pane, query.account) };
  });

  app.get("/api/mail-copilot/threads", routeOptions, async (request) => {
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const query = parseQuery(paneQuery.merge(mailThreadsQuerySchema).strict(), { ...raw, ...(raw.max !== undefined ? { max: Number(raw.max) } : {}) });
    const { paneId, ...rest } = query;
    const { owner, pane } = await ownerAndPane(request, paneId);
    return service.threads(owner, pane, rest);
  });

  app.get("/api/mail-copilot/threads/:threadId", routeOptions, async (request) => {
    const params = parseQuery(threadParamsSchema, request.params);
    const query = parseQuery(paneQuery.extend({ account: emailSchema, images: z.enum(["0", "1"]).default("0") }).strict(), request.query ?? {});
    const { owner, pane } = await ownerAndPane(request, query.paneId);
    return { thread: await service.thread(owner, pane, query.account, params.threadId, query.images === "1") };
  });

  app.post("/api/mail-copilot/threads/:threadId/modify", routeOptions, async (request) => {
    const params = parseQuery(threadParamsSchema, request.params);
    const body = parseBody(mailThreadActionSchema.extend({ paneId: paneIdSchema.optional() }).strict(), request.body ?? {});
    const { paneId, ...input } = body;
    const { owner, pane } = await ownerAndPane(request, paneId);
    await service.modify(owner, pane, params.threadId, input);
    await deps.audit(request, "mail_copilot.thread.modify", params.threadId, { account: input.account, action: input.action, paneId: paneId ?? null });
    return { ok: true };
  });

  app.post("/api/mail-copilot/messages/send", routeOptions, async (request) => {
    const body = parseBody(mailComposeInputSchema.extend({ paneId: paneIdSchema.optional() }).strict(), request.body ?? {});
    const { paneId, ...input } = body;
    const { owner, pane } = await ownerAndPane(request, paneId);
    const sent = await service.send(owner, pane, input);
    await deps.audit(request, "mail_copilot.message.send", sent.messageId, { account: input.account, recipients: input.to.length + input.cc.length + input.bcc.length, reply: Boolean(input.inReplyToMessageId), paneId: paneId ?? null });
    return sent;
  });

  app.post("/api/mail-copilot/drafts", routeOptions, async (request) => {
    const body = parseBody(mailComposeInputSchema.extend({ paneId: paneIdSchema.optional() }).strict(), request.body ?? {});
    const { paneId, ...input } = body;
    const { owner, pane } = await ownerAndPane(request, paneId);
    const draft = await service.draft(owner, pane, input);
    await deps.audit(request, "mail_copilot.draft.create", draft.draftId, { account: input.account, paneId: paneId ?? null });
    return draft;
  });

  app.get("/api/mail-copilot/messages/:messageId/attachments/:attachmentId", routeOptions, async (request, reply) => {
    const params = parseQuery(attachmentParamsSchema, request.params);
    const query = parseQuery(paneQuery.extend({ account: emailSchema, inline: z.enum(["0", "1"]).default("0") }).strict(), request.query ?? {});
    const { owner, pane } = await ownerAndPane(request, query.paneId);
    const file = await service.attachment(owner, pane, query.account, params.messageId, params.attachmentId);
    const safeName = file.filename.replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 200) || "attachment";
    // Inline only for images; everything else downloads, and nothing from a mailbox ever runs as a page.
    const inlineImage = query.inline === "1" && /^image\//i.test(file.mimeType);
    reply.header("Content-Type", inlineImage ? file.mimeType : "application/octet-stream");
    reply.header("Content-Disposition", `${inlineImage ? "inline" : "attachment"}; filename="${safeName}"`);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send(file.data);
  });
}
