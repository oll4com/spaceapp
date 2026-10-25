import type {} from "../request-context.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  securityAnswerSchema, securityBriefCreateSchema, securityCopilotPaneMetadataSchema, securityEventIdSchema, securityFindingIdSchema, securityFindingUpdateSchema,
  securityMemoryCreateSchema, securityMemoryIdSchema, securityMemoryKindSchema, securityMemoryUpdateSchema, securityReviewDecisionSchema, type Pane
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { SecurityCopilotService } from "./service.js";

export interface SecurityCopilotRouteDependencies {
  store: Pick<SpaceStore, "getPane">;
  routeOptions: Record<string, unknown>;
  /** Resolves the signed-in owner; throws the API's 401 error when absent. */
  authenticatedOwner(request: FastifyRequest): Promise<string>;
  assertPaneAccess(request: FastifyRequest, pane: Pane): Promise<void>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
}

const paneIdSchema = z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/);
// Not strict: the item routes carry their id next to the pane id.
const paneParamsSchema = z.object({ id: paneIdSchema });

/** Operator routes of the Security Copilot pane: settings, state, briefs, answers, reviews, findings, memory and the run (Nous calls the same). */
export function registerSecurityCopilotRoutes(app: FastifyInstance, service: SecurityCopilotService, deps: SecurityCopilotRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  const base = "/api/panes/:id/security-copilot";

  async function paneOf(request: FastifyRequest): Promise<{ owner: string; pane: Pane }> {
    const owner = await deps.authenticatedOwner(request);
    const pane = await deps.store.getPane(parseQuery(paneParamsSchema, request.params).id);
    await deps.assertPaneAccess(request, pane);
    if (pane.mode !== "SECURITY_COPILOT") throw new SpaceConflictError("This belongs to a Security Copilot pane.");
    return { owner, pane };
  }
  const param = (request: FastifyRequest, name: string, schema: z.ZodType<string>): string => (parseQuery(z.object({ id: paneIdSchema, [name]: schema }).strict(), request.params) as Record<string, string>)[name]!;

  app.get(`${base}/settings`, routeOptions, async (request) => ({ metadata: service.metadata((await paneOf(request)).pane) }));
  app.put(`${base}/settings`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const metadata = await service.updateSettings(owner, pane, parseBody(securityCopilotPaneMetadataSchema, request.body ?? {}));
    await deps.audit(request, "security_copilot.settings.update", pane.id, { paused: metadata.settings.paused, autonomy: metadata.settings.autonomy, excludedHosts: metadata.settings.excludedHosts.length });
    return { metadata };
  });
  // Everything the pane shows in one read.
  app.get(`${base}/state`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const [run, summary, hosts, findings, actions, events] = await Promise.all([service.runView(owner, pane), service.summary(owner), service.hostList(owner),
      service.findings(owner, { limit: 300 }), service.actions(owner, { limit: 50 }), service.events(owner, pane, 100)]);
    return { metadata: service.metadata(pane), run, summary, hosts, findings, actions, events };
  });
  app.post(`${base}/briefs`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const created = await service.addBrief(owner, pane, parseBody(securityBriefCreateSchema, request.body ?? {}).text, "OPERATOR");
    await deps.audit(request, "security_copilot.brief.create", created.brief.id, { paneId: pane.id, kickoffSent: created.kickoffSent });
    return created;
  });
  app.post(`${base}/questions/:questionId/answer`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const questionId = param(request, "questionId", securityEventIdSchema);
    const question = await service.answer(owner, pane, questionId, parseBody(securityAnswerSchema, request.body ?? {}).answer, "OPERATOR");
    await deps.audit(request, "security_copilot.question.answer", questionId, { paneId: pane.id });
    return { question };
  });
  // A held change waits for a person: this route (the rail) or the Nous decision card after the operator's yes.
  app.post(`${base}/reviews/:reviewId/decide`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const reviewId = param(request, "reviewId", securityEventIdSchema);
    const input = parseBody(securityReviewDecisionSchema, request.body ?? {});
    const decided = await service.decideReview(owner, pane, reviewId, input);
    await deps.audit(request, "security_copilot.review.decide", reviewId, { paneId: pane.id, approve: input.approve });
    return decided;
  });
  app.patch(`${base}/findings/:findingId`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const findingId = param(request, "findingId", securityFindingIdSchema);
    const input = parseBody(z.object({ status: z.enum(["NEW", "TRIAGING", "FIXING", "FIXED", "MITIGATED", "NOT_AFFECTED", "ACCEPTED"]), note: securityFindingUpdateSchema.shape.note }).strict(), request.body ?? {});
    const finding = await service.updateFinding(owner, findingId, input, "OPERATOR");
    await deps.audit(request, "security_copilot.finding.update", findingId, { paneId: pane.id, status: input.status });
    return { finding };
  });
  app.get(`${base}/memory`, routeOptions, async (request) => {
    const { owner } = await paneOf(request);
    const query = parseQuery(z.object({ query: z.string().max(300).optional(), kind: securityMemoryKindSchema.optional() }).strict(), request.query);
    return { memories: await service.recall(owner, { query: query.query, kinds: query.kind ? [query.kind] : undefined, limit: 200 }) };
  });
  app.post(`${base}/memory`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const memory = await service.remember(owner, parseBody(securityMemoryCreateSchema, request.body ?? {}), "USER");
    await deps.audit(request, "security_copilot.memory.create", memory.id, { paneId: pane.id, kind: memory.kind });
    return { memory };
  });
  app.patch(`${base}/memory/:memoryId`, routeOptions, async (request) => {
    const { owner } = await paneOf(request);
    return { memory: await service.updateMemory(owner, param(request, "memoryId", securityMemoryIdSchema), parseBody(securityMemoryUpdateSchema, request.body ?? {})) };
  });
  app.delete(`${base}/memory/:memoryId`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const memoryId = param(request, "memoryId", securityMemoryIdSchema);
    const result = await service.forget(owner, memoryId);
    await deps.audit(request, "security_copilot.memory.delete", memoryId, { paneId: pane.id });
    return result;
  });
  app.get(`${base}/run`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    return service.runView(owner, pane);
  });
  for (const action of ["start", "pause", "stop"] as const) {
    app.post(`${base}/run/${action}`, routeOptions, async (request) => {
      const { owner, pane } = await paneOf(request);
      const view = await service.setRun(owner, pane, action);
      await deps.audit(request, `security_copilot.run.${action}`, pane.id, { kickoffSent: view.kickoffSent });
      return view;
    });
  }
  // "Check now": one watch pass (stable runs it every 30 minutes; dev only on this button).
  app.post(`${base}/watch`, routeOptions, async (request) => {
    const { pane } = await paneOf(request);
    const result = await service.watch();
    await deps.audit(request, "security_copilot.watch", pane.id, result);
    return result;
  });
}
