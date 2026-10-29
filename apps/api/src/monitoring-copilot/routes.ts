import type {} from "../request-context.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  monitoringAnswerSchema, monitoringBriefCreateSchema, monitoringCopilotPaneMetadataSchema, monitoringEventIdSchema, monitoringLogQuerySchema, monitoringMemoryCreateSchema,
  monitoringMemoryIdSchema, monitoringMemoryKindSchema, monitoringMemoryUpdateSchema, monitoringPromQuerySchema, monitoringReviewDecisionSchema, type Pane
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { MonitoringCopilotService } from "./service.js";

export interface MonitoringCopilotRouteDependencies {
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

/** Proof, automation and agent broker sessions never approve a held change on a host or let the copilot fix on its own: a person only. */
export function assertMonitoringPerson(request: FastifyRequest): void {
  const user = request.user;
  const principal = request.sessionPrincipal ?? user?.id ?? "";
  if (!user || user.proofScope || user.automationScope || user.brokerScope || principal.startsWith("user:operator-proof") || principal.startsWith("user:proof")) {
    throw Object.assign(new Error("Only the operator, signed in to Space, approves a change on a host or turns on Fix on its own."), { statusCode: 403 });
  }
}
// Not strict: the item routes carry their id next to the pane id.
const paneParamsSchema = z.object({ id: paneIdSchema });

/** Operator routes of the Monitoring Copilot pane: settings, state, briefs, answers, alerts, targets, queries, memory and the run (Nous calls the same). */
export function registerMonitoringCopilotRoutes(app: FastifyInstance, service: MonitoringCopilotService, deps: MonitoringCopilotRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  const base = "/api/panes/:id/monitoring-copilot";

  async function paneOf(request: FastifyRequest): Promise<{ owner: string; pane: Pane }> {
    const owner = await deps.authenticatedOwner(request);
    const pane = await deps.store.getPane(parseQuery(paneParamsSchema, request.params).id);
    await deps.assertPaneAccess(request, pane);
    if (pane.mode !== "MONITORING_COPILOT") throw new SpaceConflictError("This belongs to a Monitoring Copilot pane.");
    return { owner, pane };
  }
  const param = (request: FastifyRequest, name: string, schema: z.ZodType<string>): string => (parseQuery(z.object({ id: paneIdSchema, [name]: schema }).strict(), request.params) as Record<string, string>)[name]!;

  app.get(`${base}/settings`, routeOptions, async (request) => ({ metadata: service.metadata((await paneOf(request)).pane) }));
  app.put(`${base}/settings`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const next = parseBody(monitoringCopilotPaneMetadataSchema, request.body ?? {});
    if (next.settings.autonomy === "FULL" && service.metadata(pane).settings.autonomy !== "FULL") assertMonitoringPerson(request);
    const metadata = await service.updateSettings(owner, pane, next);
    await deps.audit(request, "monitoring_copilot.settings.update", pane.id, { paused: metadata.settings.paused, autonomy: metadata.settings.autonomy, collector: metadata.settings.collector, notifications: metadata.settings.notifications });
    return { metadata };
  });
  // Everything the pane shows in one read (targets are a separate, bounded collector read).
  app.get(`${base}/state`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const [run, summary, alerts, actions, events] = await Promise.all([service.runView(owner, pane), service.summary(owner), service.alerts(owner, { firing: false, limit: 300 }),
      service.actions(owner, { limit: 50 }), service.events(owner, pane, 150)]);
    return { metadata: service.metadata(pane), run, summary, alerts, actions, events };
  });
  app.get(`${base}/targets`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    return { targets: await service.targets(owner, pane) };
  });
  app.post(`${base}/query`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const input = parseBody(z.discriminatedUnion("engine", [
      z.object({ engine: z.literal("prometheus"), query: monitoringPromQuerySchema }).strict(),
      z.object({ engine: z.literal("loki"), query: monitoringLogQuerySchema }).strict()
    ]), request.body ?? {});
    return input.engine === "prometheus" ? service.promQuery(owner, pane, input.query) : service.logQuery(owner, pane, input.query);
  });
  app.post(`${base}/briefs`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const created = await service.addBrief(owner, pane, parseBody(monitoringBriefCreateSchema, request.body ?? {}).text, "OPERATOR");
    await deps.audit(request, "monitoring_copilot.brief.create", created.brief.id, { paneId: pane.id, kickoffSent: created.kickoffSent });
    return created;
  });
  app.post(`${base}/questions/:questionId/answer`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const questionId = param(request, "questionId", monitoringEventIdSchema);
    const question = await service.answer(owner, pane, questionId, parseBody(monitoringAnswerSchema, request.body ?? {}).answer, "OPERATOR");
    await deps.audit(request, "monitoring_copilot.question.answer", questionId, { paneId: pane.id });
    return { question };
  });
  // A held change waits for a person: this route (the rail) or the Nous decision card after the operator's yes.
  app.post(`${base}/reviews/:reviewId/decide`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const reviewId = param(request, "reviewId", monitoringEventIdSchema);
    const input = parseBody(monitoringReviewDecisionSchema, request.body ?? {});
    if (input.approve) assertMonitoringPerson(request);
    const decided = await service.decideReview(owner, pane, reviewId, input);
    await deps.audit(request, "monitoring_copilot.review.decide", reviewId, { paneId: pane.id, approve: input.approve });
    return decided;
  });
  app.get(`${base}/memory`, routeOptions, async (request) => {
    const { owner } = await paneOf(request);
    const query = parseQuery(z.object({ query: z.string().max(300).optional(), kind: monitoringMemoryKindSchema.optional() }).strict(), request.query);
    return { memories: await service.recall(owner, { query: query.query, kinds: query.kind ? [query.kind] : undefined, limit: 200 }) };
  });
  app.post(`${base}/memory`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const memory = await service.remember(owner, parseBody(monitoringMemoryCreateSchema, request.body ?? {}), "USER");
    await deps.audit(request, "monitoring_copilot.memory.create", memory.id, { paneId: pane.id, kind: memory.kind });
    return { memory };
  });
  app.patch(`${base}/memory/:memoryId`, routeOptions, async (request) => {
    const { owner } = await paneOf(request);
    return { memory: await service.updateMemory(owner, param(request, "memoryId", monitoringMemoryIdSchema), parseBody(monitoringMemoryUpdateSchema, request.body ?? {})) };
  });
  app.delete(`${base}/memory/:memoryId`, routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const memoryId = param(request, "memoryId", monitoringMemoryIdSchema);
    const result = await service.forget(owner, memoryId);
    await deps.audit(request, "monitoring_copilot.memory.delete", memoryId, { paneId: pane.id });
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
      await deps.audit(request, `monitoring_copilot.run.${action}`, pane.id, { kickoffSent: view.kickoffSent });
      return view;
    });
  }
  // "Check now": one watch pass (stable runs it every minute; dev only on this button).
  app.post(`${base}/watch`, routeOptions, async (request) => {
    const { pane } = await paneOf(request);
    const result = await service.watch();
    await deps.audit(request, "monitoring_copilot.watch", pane.id, result);
    return result;
  });
}
