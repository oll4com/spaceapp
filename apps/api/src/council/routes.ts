import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  councilAnswersInputSchema, councilApproveInputSchema, councilChangesInputSchema, councilRunIdSchema, createCouncilRunInputSchema
} from "@space/contracts";
import type { CouncilService } from "./service.js";

export interface CouncilRouteDependencies {
  routeOptions: Record<string, unknown>;
  /** The signed-in ADMIN or OPERATOR's user id; a council reads their CV and spends their model quota. */
  owner(request: FastifyRequest): Promise<string>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
}

const idParams = z.object({ id: councilRunIdSchema }).strict();

/** The Research Council dock: models, runs and the operator's decisions on a run. */
export function registerCouncilRoutes(app: FastifyInstance, service: CouncilService, deps: CouncilRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  const target = async (request: FastifyRequest) => ({ owner: await deps.owner(request), id: parseQuery(idParams, request.params).id });

  app.get("/api/council/models", routeOptions, async (request) => {
    await deps.owner(request);
    return service.models();
  });

  app.get("/api/council/runs", routeOptions, async (request) => ({ runs: await service.list(await deps.owner(request)) }));

  app.post("/api/council/runs", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    const run = await service.create(owner, parseBody(createCouncilRunInputSchema, request.body));
    return reply.code(201).send({ run });
  });

  app.get("/api/council/runs/:id", routeOptions, async (request) => {
    const { owner, id } = await target(request);
    return { run: await service.get(owner, id) };
  });

  app.post("/api/council/runs/:id/answers", routeOptions, async (request) => {
    const { owner, id } = await target(request);
    return { run: await service.answer(owner, id, parseBody(councilAnswersInputSchema, request.body).answers) };
  });

  app.post("/api/council/runs/:id/changes", routeOptions, async (request) => {
    const { owner, id } = await target(request);
    return { run: await service.requestChanges(owner, id, parseBody(councilChangesInputSchema, request.body).text) };
  });

  app.post("/api/council/runs/:id/approve", routeOptions, async (request) => {
    const { owner, id } = await target(request);
    return { run: await service.approve(owner, id, parseBody(councilApproveInputSchema, request.body ?? {})) };
  });

  app.post("/api/council/runs/:id/stop", routeOptions, async (request) => {
    const { owner, id } = await target(request);
    return { run: await service.stop(owner, id) };
  });

  app.post("/api/council/runs/:id/cancel", routeOptions, async (request) => {
    const { owner, id } = await target(request);
    return { run: await service.cancel(owner, id) };
  });

  app.post("/api/council/runs/:id/resume", routeOptions, async (request) => {
    const { owner, id } = await target(request);
    return { run: await service.resume(owner, id) };
  });

  app.post("/api/council/runs/:id/another-round", routeOptions, async (request) => {
    const { owner, id } = await target(request);
    return { run: await service.anotherRound(owner, id) };
  });

  app.post("/api/council/runs/:id/clipboard-plan", routeOptions, async (request) => {
    const { owner, id } = await target(request);
    return { run: await service.createClipboardPlan(owner, id) };
  });

  app.delete("/api/council/runs/:id", routeOptions, async (request, reply) => {
    const { owner, id } = await target(request);
    await service.remove(owner, id);
    return reply.code(204).send();
  });
}
