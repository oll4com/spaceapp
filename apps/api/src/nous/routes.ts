import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { nousAwayInputSchema, nousDecisionAnswerInputSchema, nousMessageIdSchema, nousDecisionFeedbackInputSchema, nousDecisionIdSchema, nousGoalCreateInputSchema, nousGoalEditInputSchema, nousGoalHistoryQuerySchema, nousGoalIdSchema, nousGoalsReorderInputSchema, nousRequestStatusSchema, nousSendInputSchema, nousSettingsInputSchema, type NousProviderOption, type NousStandingApproval, type NousMessage, type NousDecision } from "@space/contracts";
import type { NousAwayControl } from "./away.js";
import type { NousAttachments } from "./attachments.js";
import type { NousScorecard } from "./progress.js";
import type { NousRequests } from "./requests.js";
import type { NousGoalHistory } from "./goal-history.js";
import { operatorMessagesToAnswer, type NousService } from "./service.js";
import { requestNousClient } from "../request-helpers.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

export interface NousRouteDependencies {
  routeOptions: Record<string, unknown>;
  providers?(): Promise<NousProviderOption[]>;
  validateModels?(owner: string, patch: z.infer<typeof nousSettingsInputSchema>): Promise<void>;
  /** The signed-in ADMIN or OPERATOR's user id. */
  owner(request: FastifyRequest): Promise<string>;
  /** Operator 2/11 15:08 BKK: Nous is on with "May send", so the approvals it covers are Nous's (wiring.ts `coversApproval`). */
  coversApproval?(owner: string): Promise<boolean>;
  /** A person at the dock, never a proof or automation session: only they answer Nous's critical decisions. */
  assertPerson(request: FastifyRequest): void;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  /** Nous's scorecard against its 2026-10-17 baseline (read only). */
  progress(owner: string): Promise<NousScorecard>;
  /** Files the operator sends with a message (plan clipboard:hQg9iKGYDqx7); without it messages carry text only. */
  attachments?: NousAttachments;
  /** Away mode's Settings switch (plan clipboard:B7eTUHTJYg3X). */
  away?: Pick<NousAwayControl, "fromSettings">;
  /** "Show everything" (operator request 2026-10-21): the texts a decision sends, read whole from the files it names. */
  decisionFiles(owner: string, id: string): Promise<Array<{ ref: string; text: string | null; total: number | null; truncated: boolean; error?: string }>>;
  /** Where Nous works on its own, only a person turns an allowance (May promote, May approve Warm) on. */
  assertAllowanceChange(request: FastifyRequest, owner: string, input: z.infer<typeof nousSettingsInputSchema>): Promise<void>;
  /** Goal 7365014c-c: the stored Always-approve kinds, each with how often it ran by itself in the last 14 days. */
  alwaysApproveCounts(owner: string): Promise<Array<NousStandingApproval & { count: number }>>;
  /** The installed Vault broker's commit, hash and the diff stat of its sources to stable's HEAD (vault/broker-report.ts). */
  vaultBrokerReport?(): Promise<string>;
  /** The Requests tab: every operator message with how it ended (requests.ts). */
  requests?: NousRequests;
  /** A goal's work history (plan clipboard:jNDx8l-vMEl9). */
  goalHistory?: NousGoalHistory;
  /** The page's tool steps with their translation into the operator's agent language, where one is ready (step-translations.ts). */
  stepTranslations?(owner: string, messages: NousMessage[], traceId?: string): Promise<NousMessage[]>;
  /** The marked-outcome path (space_settle_decision's, wiring.ts): an APPROVED decision done with proof or void; any other comes back as it is. */
  settleDecision?(owner: string, id: string, settlement: { state: "DONE" | "VOID"; proof: string | null; reason: string }): Promise<NousDecision | null>;
}

const decisionParams = z.object({ id: nousDecisionIdSchema }).strict();
const goalParams = z.object({ id: nousGoalIdSchema }).strict();
// No question is ever lost (operator 31/10): the dock pages back past the newest 200 rows, Clear conversation included.
const messagesQuery = z.object({ before: nousMessageIdSchema.optional(), limit: z.coerce.number().int().min(1).max(500).default(200),
  cleared: z.enum(["1", "true"]).optional() }).strict();
const requestsQuery = z.object({ before: nousMessageIdSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(50), status: nousRequestStatusSchema.optional(),
  since: z.string().datetime({ offset: true }).optional(), q: z.string().max(200).optional() }).strict();
// Audit 6/11: done needs its proof (a URL, a message id, a booking), void its reason, as space_settle_decision.
const settleSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("DONE"), proof: z.string().trim().min(1).max(1_000), reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ state: z.literal("VOID"), proof: z.string().trim().max(1_000).optional(), reason: z.string().trim().min(1).max(500) }).strict()]);
const vaultBrokerReinstallSchema = z.object({ reason: z.string().trim().min(1).max(1_000) }).strict();

/** The Nous dock: state, conversation, settings, decisions and the overview. */
export function registerNousRoutes(app: FastifyInstance, service: NousService, deps: NousRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;

  app.get("/api/nous", routeOptions, async (request) => ({ state: await service.state(await deps.owner(request)) }));
  // The copilot panes' one read of the predicate: reviews and campaigns it covers show as "Nous reviewing", with no badge or Approve.
  app.get("/api/nous/approvals", routeOptions, async (request) => ({ nousReviewing: Boolean(await deps.coversApproval?.(await deps.owner(request)).catch(() => false)) }));

  app.get("/api/nous/providers", routeOptions, async (request) => {
    await deps.owner(request);
    return { providers: await deps.providers?.() ?? [] };
  });

  // Read only: what Nous's turns ran on and cost (space-admin-action nous-turn-costs; the model study, 2026-10-21).
  app.get("/api/nous/turn-costs", routeOptions, async (request) => {
    const { days } = parseQuery(z.object({ days: z.coerce.number().int().min(1).default(7) }).strict(), request.query);
    return { costs: await service.turnCosts(await deps.owner(request), days) };
  });

  app.get("/api/nous/messages", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { before, limit, cleared } = parseQuery(messagesQuery, request.query);
    const latest = before === undefined && cleared === undefined;
    // The latest page starts at the last Clear conversation; `cleared` and `before` read past it (the rows are never deleted).
    const { messages, hasMore, clearedAt } = await service.messagePage(owner, limit, before ? { before } : { sinceClear: latest });
    const operatorIds = messages.filter((message) => message.kind === "OPERATOR").map((message) => message.id);
    // `waiting`: the operator's messages still in Nous's queue (no answer yet); the dock marks them queued or being answered. Only the latest page knows.
    // `clearedAt` (latest page only): the dock leaves the decisions asked before the last Clear out of the conversation (operator 2/11).
    return { messages: deps.stepTranslations ? await deps.stepTranslations(owner, messages, request.requestIdForSpace) : messages, hasMore, ...(latest ? { clearedAt: clearedAt ?? null } : {}),
      waiting: latest ? operatorMessagesToAnswer(messages).map((message) => message.id) : [],
      attachments: deps.attachments ? await deps.attachments.forMessages(owner, operatorIds) : {} };
  });

  // Every operator message, oldest first: "Go to my last message" walks them past the loaded page (31/10).
  app.get("/api/nous/messages/operator-index", routeOptions, async (request) => ({ messages: await service.operatorMessageRefs(await deps.owner(request)) }));

  // The Requests tab (operator 31/10 09:55 BKK, plan clipboard:2NOOFNJDUIMO): every operator message, newest first, with how it ended. Clear hides none.
  app.get("/api/nous/requests", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { before, limit, status, since, q } = parseQuery(requestsQuery, request.query);
    return deps.requests ? deps.requests.page(owner, { ...(before ? { before } : {}), limit, ...(status ? { status } : {}), ...(since ? { since } : {}), ...(q?.trim() ? { q } : {}) })
      : { requests: [], hasMore: false, counts: {} };
  });

  app.post("/api/nous/messages", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    const input = parseBody(nousSendInputSchema, request.body);
    const ids = input.attachmentIds ?? [];
    if (ids.length && !deps.attachments) return reply.code(422).send({ error: { code: "ATTACHMENTS_UNAVAILABLE", message: "Files cannot be sent to Nous here." } });
    // The files' block rides on the operator's message, so every turn that sees the message sees its files.
    const prepared = ids.length ? await deps.attachments!.prepare(owner, ids) : null;
    // Only a person at the dock (never a proof or automation session) can start Away from the chat.
    let person = true;
    try { deps.assertPerson(request); } catch { person = false; }
    const message = await service.send(owner, [input.content, prepared?.block].filter(Boolean).join("\n\n"), { person, client: requestNousClient(request),
      ...(request.mobileDevice ? { mobile: { device: request.mobileDevice.id, scopes: request.mobileDevice.scopes } } : {}) });
    if (prepared) await deps.attachments!.link(owner, message.id, prepared.attachments.map((attachment) => attachment.id));
    return reply.code(202).send({ message, attachments: prepared?.attachments ?? [] });
  });

  // Operator 31/10: clears what the dock shows, never the database: a mark the latest page starts after; rows and files stay.
  app.delete("/api/nous/messages", routeOptions, async (request) => ({ cleared: await service.clear(await deps.owner(request)) }));

  app.post("/api/nous/stop", routeOptions, async (request) => ({ stopped: service.stop(await deps.owner(request)) }));

  app.patch("/api/nous/settings", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const input = parseBody(nousSettingsInputSchema, request.body);
    await deps.assertAllowanceChange(request, owner, input);
    await deps.validateModels?.(owner, input);
    return { settings: await service.saveSettings(owner, input) };
  });

  app.post("/api/nous/away", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    if (!deps.away) return reply.code(422).send({ error: { code: "NOUS_AWAY_UNAVAILABLE", message: "Away mode is not available here." } });
    return { away: await deps.away.fromSettings(owner, parseBody(nousAwayInputSchema, request.body)) };
  });

  app.get("/api/nous/overview", routeOptions, async (request) => ({ overview: await service.overview(await deps.owner(request)) }));

  app.get("/api/nous/progress", routeOptions, async (request) => ({ progress: await deps.progress(await deps.owner(request)) }));

  // Read only (goal 7365014c-c): Settings shows what each "Always approve" spares the operator.
  app.get("/api/nous/always-approve", routeOptions, async (request) => ({ rules: await deps.alwaysApproveCounts(await deps.owner(request)) }));

  app.get("/api/nous/decisions", routeOptions, async (request) => {
    const { before } = parseQuery(z.object({ before: z.string().datetime({ offset: true }).optional() }), request.query ?? {});
    const owner = await deps.owner(request);
    return before ? await service.earlierDecisions(owner, before) : { decisions: await service.decisions(owner) };
  });

  // An agent asks for the Vault broker's reinstall (space-admin-action vault-broker-reinstall); only the operator's yes runs it.
  app.post("/api/nous/decisions/vault-broker-reinstall", routeOptions, async (request) => {
    const { reason } = parseBody(vaultBrokerReinstallSchema, request.body);
    // The operator approves a build of stable's code nobody reviewed as a broker diff: the card shows what the reinstall would change.
    const report = deps.vaultBrokerReport ? await deps.vaultBrokerReport().catch((error: Error) => `**Installed broker:** could not be read (${error.message}).`) : null;
    return { decision: await service.ask({ ownerUserId: await deps.owner(request), category: "RELEASE", title: "Reinstall the Vault broker from stable's code",
      body: `Space builds the broker from stable's committed code (refused if ${SPACE_INSTALL_ROOT} has local changes), installs it as root, keeps the old one `
        + "as broker.mjs.previous and restarts space-vault-broker.service; if it does not come back, the old one is restored. Agents keep filling under the current delegation; no unlock is needed."
        + (report ? `\n\n${report}` : ""),
      options: [], recommendation: reason, refs: {}, action: { type: "VAULT_BROKER_REINSTALL" } }) };
  });

  app.get("/api/nous/decisions/:id/files", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(decisionParams, request.params);
    return { files: await deps.decisionFiles(owner, id) };
  });

  app.post("/api/nous/decisions/:id/answer", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    const { id } = parseQuery(decisionParams, request.params);
    return { decision: await service.answer(owner, id, parseBody(nousDecisionAnswerInputSchema, request.body)) };
  });

  app.post("/api/nous/decisions/:id/feedback", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    const { id } = parseQuery(decisionParams, request.params);
    return { decision: await service.feedback(owner, id, parseBody(nousDecisionFeedbackInputSchema, request.body).couldHaveDecided) };
  });

  // The admin action nous-decision-settle (audit 6/11): marks the decisions the audit found done, so the Score drops them now.
  app.post("/api/nous/decisions/:id/settle", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(decisionParams, request.params);
    if (!deps.settleDecision) return reply.code(501).send({ error: "Settling is not wired on this install." });
    const body = parseBody(settleSchema, request.body);
    const before = await deps.settleDecision(owner, id, { state: body.state, proof: body.proof ?? null, reason: body.reason });
    if (!before) return reply.code(404).send({ error: `No decision ${id}.` });
    if (before.status !== "APPROVED") return reply.code(409).send({ error: `${id} is ${before.status}; only an approved decision is settled.` });
    return { id, state: body.state, previousOutcome: before.outcome };
  });

  // Goals (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1): the list for the dock; every write from a person only.
  app.get("/api/nous/goals", routeOptions, async (request) => ({ view: await service.goalsView(await deps.owner(request)) }));
  app.post("/api/nous/goals", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    return reply.code(201).send({ goal: await service.createGoal(owner, parseBody(nousGoalCreateInputSchema, request.body).text) });
  });
  app.get("/api/nous/goals/:id/events", routeOptions, async (request) => {
    const { id } = parseQuery(goalParams, request.params);
    const { before } = parseQuery(z.object({ before: z.string().regex(/^\d{1,19}$/) }).strict(), request.query);
    return service.goalEvents(await deps.owner(request), id, before);
  });
  // A goal's work history (plan clipboard:jNDx8l-vMEl9), newest first, paged by the oldest `at` held; the Nous app reads it too.
  app.get("/api/nous/goals/:id/history", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(goalParams, request.params);
    const page = await deps.goalHistory?.page(owner, id, parseQuery(nousGoalHistoryQuerySchema, request.query));
    return page ?? reply.code(404).send({ error: { code: "NOT_FOUND", message: "This goal does not exist." } });
  });
  app.post("/api/nous/goals/reorder", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    return { goals: await service.reorderGoals(owner, parseBody(nousGoalsReorderInputSchema, request.body).ids) };
  });
  app.patch("/api/nous/goals/:id", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    const { id } = parseQuery(goalParams, request.params);
    return { goal: await service.editGoal(owner, id, parseBody(nousGoalEditInputSchema, request.body)) };
  });
  app.delete("/api/nous/goals/:id", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    const { id } = parseQuery(goalParams, request.params);
    if (!(await service.removeGoal(owner, id))) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "This goal does not exist." } });
    return { removed: true };
  });
}
