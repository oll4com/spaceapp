import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  freelanceAccountUpdateSchema, freelanceBriefSchema, freelanceChannelSchema, freelanceCopilotPaneMetadataSchema, freelanceEventListQuerySchema, freelanceLeadCreateSchema,
  freelanceLeadDecisionSchema, freelanceLeadIdSchema, freelanceLeadStatusSchema, freelanceMailboxInputSchema, freelanceMemoryCreateSchema, freelanceMemoryIdSchema, freelanceMemoryKindSchema,
  freelanceMemoryQuerySchema, freelanceMemoryUpdateSchema, freelanceMessageIdSchema, freelanceMessageReviewDecisionSchema, freelanceQuestionAnswerSchema, freelanceRuleDecisionSchema,
  freelanceRuleIdSchema, freelanceRuleProposalSchema, FREELANCE_RULE_STATUSES, resolveFreelanceCopilotPaneMetadata, type FreelanceRun, type Pane
} from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { FreelanceCopilotService } from "./service.js";

export interface FreelanceCopilotRouteDependencies {
  store: Pick<SpaceStore, "getPane" | "updateFreelanceCopilotMetadata">;
  routeOptions: Record<string, unknown>;
  /** Resolves the signed-in owner; throws the API's 401 error when absent. */
  authenticatedOwner(request: FastifyRequest): Promise<string>;
  assertPaneAccess(request: FastifyRequest, pane: Pane): Promise<void>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** Sends the run's kickoff prompt into the pane's CLI (the existing pane CLI input path). */
  kickoff?(pane: Pane, run: FreelanceRun): Promise<void>;
}

// Not strict: the lead and message routes carry their own id next to the pane id.
const paneParamsSchema = z.object({ id: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/) });
const paneIdQuerySchema = z.object({ paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/).optional() }).strict();
const list = (raw: string | undefined) => raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;

/** Operator-facing routes of the Freelance Copilot pane: settings, runs, briefs, leads, reviews, accounts, mailbox, rules and memory. */
export function registerFreelanceCopilotRoutes(app: FastifyInstance, service: FreelanceCopilotService, deps: FreelanceCopilotRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;

  async function paneOf(request: FastifyRequest): Promise<Pane> {
    await deps.authenticatedOwner(request);
    const params = parseQuery(paneParamsSchema, request.params);
    const pane = await deps.store.getPane(params.id);
    await deps.assertPaneAccess(request, pane);
    if (pane.mode !== "FREELANCE_COPILOT") throw new SpaceConflictError("Settings belong to a Freelance Copilot pane.");
    return pane;
  }
  /** The pane an owner-level decision was made from (optional `paneId` query), for its Activity line. */
  async function optionalPane(request: FastifyRequest): Promise<Pane | null> {
    const query = parseQuery(paneIdQuerySchema, request.query ?? {});
    if (!query.paneId) return null;
    const pane = await deps.store.getPane(query.paneId);
    await deps.assertPaneAccess(request, pane);
    return pane.mode === "FREELANCE_COPILOT" ? pane : null;
  }

  app.get("/api/panes/:id/freelance-copilot/settings", routeOptions, async (request) => {
    const pane = await paneOf(request);
    return { metadata: resolveFreelanceCopilotPaneMetadata(pane.freelanceCopilotMetadata) };
  });
  app.put("/api/panes/:id/freelance-copilot/settings", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const input = parseBody(freelanceCopilotPaneMetadataSchema, request.body ?? {});
    // A client that does not name the operator's view keeps it.
    const current = resolveFreelanceCopilotPaneMetadata(pane.freelanceCopilotMetadata);
    const metadata = { ...input, ...(input.view ?? current.view ? { view: input.view ?? current.view } : {}) };
    const updated = await deps.store.updateFreelanceCopilotMetadata(pane.id, metadata);
    const channels = Object.entries(metadata.settings.channels).filter(([, channel]) => channel.enabled).map(([id]) => id);
    await deps.audit(request, "freelance_copilot.settings.update", pane.id, { paused: metadata.settings.paused, autonomy: metadata.settings.autonomy, channels });
    return { metadata: resolveFreelanceCopilotPaneMetadata(updated.freelanceCopilotMetadata) };
  });

  // ---- runs, briefs, activity and questions (the rail) -------------------------------------------
  app.get("/api/panes/:id/freelance-copilot/run", routeOptions, async (request) => {
    const pane = await paneOf(request);
    return service.runView(await deps.authenticatedOwner(request), pane);
  });
  app.post("/api/panes/:id/freelance-copilot/run/start", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const owner = await deps.authenticatedOwner(request);
    const started = await service.startRun(owner, pane.id);
    let kickoffSent = false;
    if (started.kickoff && deps.kickoff) {
      await deps.kickoff(pane, started.run);
      await service.markKickoff(owner, started.run.id);
      kickoffSent = true;
    }
    await deps.audit(request, "freelance_copilot.run.start", pane.id, { runId: started.run.id, kickoffSent });
    return { ...(await service.runView(owner, pane)), kickoffSent };
  });
  for (const action of ["pause", "stop"] as const) {
    app.post(`/api/panes/:id/freelance-copilot/run/${action}`, routeOptions, async (request) => {
      const pane = await paneOf(request);
      const owner = await deps.authenticatedOwner(request);
      const run = action === "pause" ? await service.pauseRun(owner, pane.id) : await service.stopRun(owner, pane.id);
      await deps.audit(request, `freelance_copilot.run.${action}`, pane.id, { runId: run.id });
      return service.runView(owner, pane);
    });
  }
  app.post("/api/panes/:id/freelance-copilot/briefs", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const brief = await service.createBrief(await deps.authenticatedOwner(request), pane, parseBody(freelanceBriefSchema, request.body ?? {}));
    await deps.audit(request, "freelance_copilot.brief.create", brief.id, { leadId: brief.leadId });
    return { brief };
  });
  app.get("/api/freelance-copilot/events", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    return { events: await service.listEvents(owner, parseQuery(freelanceEventListQuerySchema, request.query ?? {})) };
  });
  app.post("/api/panes/:id/freelance-copilot/answer", routeOptions, async (request) => {
    const pane = await paneOf(request);
    return service.answerQuestion(await deps.authenticatedOwner(request), pane, parseBody(freelanceQuestionAnswerSchema, request.body ?? {}));
  });

  // ---- leads -------------------------------------------------------------------------------------
  app.get("/api/freelance-copilot/leads", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const raw = parseQuery(z.object({ status: z.string().max(200).optional(), channel: freelanceChannelSchema.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).strict(), request.query ?? {});
    return { leads: await service.listLeads(owner, { status: list(raw.status)?.map((entry) => freelanceLeadStatusSchema.parse(entry)), channel: raw.channel, limit: raw.limit }) };
  });
  app.get("/api/freelance-copilot/leads/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    return service.leadDetail(owner, parseQuery(z.object({ id: freelanceLeadIdSchema }).strict(), request.params).id);
  });
  app.post("/api/freelance-copilot/leads", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const result = await service.addLead(owner, await optionalPane(request), parseBody(freelanceLeadCreateSchema, request.body ?? {}), "USER");
    await deps.audit(request, "freelance_copilot.lead.create", result.lead.id, { channel: result.lead.channel, duplicate: result.duplicate });
    return result;
  });
  app.post("/api/freelance-copilot/leads/:id/decide", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: freelanceLeadIdSchema }).strict(), request.params);
    const input = parseBody(freelanceLeadDecisionSchema, request.body ?? {});
    const lead = await service.decideLead(owner, await optionalPane(request), params.id, input);
    await deps.audit(request, "freelance_copilot.lead.decide", lead.id, { decision: input.decision, contractValue: input.contractValue ?? null });
    return { lead };
  });

  // ---- messages and reviews ----------------------------------------------------------------------
  app.post("/api/freelance-copilot/messages/:id/review", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: freelanceMessageIdSchema }).strict(), request.params);
    const input = parseBody(freelanceMessageReviewDecisionSchema, request.body ?? {});
    const message = await service.decideReview(owner, await optionalPane(request), params.id, input);
    await deps.audit(request, "freelance_copilot.review.decide", message.id, { decision: input.decision, channel: message.channel });
    return { message };
  });
  app.post("/api/freelance-copilot/messages/:id/retry", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: freelanceMessageIdSchema }).strict(), request.params);
    const message = await service.retryMessage(owner, await optionalPane(request), params.id);
    await deps.audit(request, "freelance_copilot.message.retry", message.id, { channel: message.channel });
    return { message };
  });

  // ---- accounts, mailbox, funnel -----------------------------------------------------------------
  app.get("/api/freelance-copilot/accounts", routeOptions, async (request) => ({ accounts: await service.listAccounts(await deps.authenticatedOwner(request)) }));
  app.post("/api/freelance-copilot/accounts", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const account = await service.updateAccount(owner, await optionalPane(request), parseBody(freelanceAccountUpdateSchema, request.body ?? {}), "USER");
    await deps.audit(request, "freelance_copilot.account.update", account.channel, { status: account.status });
    return { account };
  });
  app.get("/api/freelance-copilot/mailbox", routeOptions, async (request) => service.mailboxStatus(await deps.authenticatedOwner(request)));
  app.put("/api/freelance-copilot/mailbox", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(freelanceMailboxInputSchema, request.body ?? {});
    const status = await service.connectMailbox(owner, input);
    await deps.audit(request, "freelance_copilot.mailbox.connect", owner, { host: input.host, user: input.user });
    return status;
  });
  app.delete("/api/freelance-copilot/mailbox", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const removed = await service.disconnectMailbox(owner);
    await deps.audit(request, "freelance_copilot.mailbox.disconnect", owner);
    return { removed };
  });
  app.get("/api/freelance-copilot/funnel", routeOptions, async (request) => service.funnel(await deps.authenticatedOwner(request)));

  // ---- rules -------------------------------------------------------------------------------------
  app.get("/api/freelance-copilot/rules", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const raw = parseQuery(z.object({ status: z.string().max(100).optional() }).strict(), request.query ?? {});
    return { rules: await service.listRules(owner, list(raw.status)?.map((entry) => z.enum(FREELANCE_RULE_STATUSES).parse(entry))) };
  });
  app.post("/api/freelance-copilot/rules", routeOptions, async (request) => {
    const rule = await service.proposeRule(await deps.authenticatedOwner(request), null, parseBody(freelanceRuleProposalSchema, request.body ?? {}), "USER");
    await deps.audit(request, "freelance_copilot.rule.create", rule.id, { channel: rule.channel });
    return { rule };
  });
  app.post("/api/freelance-copilot/rules/:id/decide", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: freelanceRuleIdSchema }).strict(), request.params);
    const input = parseBody(freelanceRuleDecisionSchema, request.body ?? {});
    const rule = await service.decideRule(owner, await optionalPane(request), params.id, input.decision);
    await deps.audit(request, "freelance_copilot.rule.decide", rule.id, { decision: input.decision });
    return { rule };
  });

  // ---- memory ------------------------------------------------------------------------------------
  app.get("/api/freelance-copilot/memory", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const query = parseQuery(freelanceMemoryQuerySchema, { ...raw, ...(raw.kinds ? { kinds: list(raw.kinds)!.map((kind) => freelanceMemoryKindSchema.parse(kind)) } : {}) });
    return { memories: await service.listMemory(owner, query) };
  });
  app.post("/api/freelance-copilot/memory", routeOptions, async (request) => {
    return { memory: await service.rememberMemory(await deps.authenticatedOwner(request), parseBody(freelanceMemoryCreateSchema, request.body ?? {}), "USER") };
  });
  app.patch("/api/freelance-copilot/memory/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: freelanceMemoryIdSchema }).strict(), request.params);
    const memory = await service.updateMemory(owner, params.id, parseBody(freelanceMemoryUpdateSchema, request.body ?? {}));
    if (!memory) throw new SpaceNotFoundError(`Memory ${params.id} was not found.`);
    return { memory };
  });
  app.delete("/api/freelance-copilot/memory/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: freelanceMemoryIdSchema }).strict(), request.params);
    return { forgotten: await service.forgetMemory(owner, params.id) };
  });
}
