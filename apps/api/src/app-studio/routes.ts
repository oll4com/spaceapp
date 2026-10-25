import type {} from "../request-context.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { appStudioAnswerSchema, appStudioBriefCreateSchema, appStudioEventIdSchema, appStudioPaneMetadataSchema, type Pane } from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { AppStudioService } from "./service.js";

export interface AppStudioRouteDependencies {
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
// Not strict: the question routes carry their id next to the pane id.
const paneParamsSchema = z.object({ id: paneIdSchema });
const questionParamsSchema = z.object({ id: paneIdSchema, questionId: appStudioEventIdSchema }).strict();

/** Operator routes of the App Studio pane: settings, the state the pane shows, briefs, answers and the run (Nous calls the same). */
export function registerAppStudioRoutes(app: FastifyInstance, service: AppStudioService, deps: AppStudioRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;

  async function paneOf(request: FastifyRequest): Promise<{ owner: string; pane: Pane }> {
    const owner = await deps.authenticatedOwner(request);
    const pane = await deps.store.getPane(parseQuery(paneParamsSchema, request.params).id);
    await deps.assertPaneAccess(request, pane);
    if (pane.mode !== "APP_STUDIO") throw new SpaceConflictError("This belongs to an App Studio pane.");
    return { owner, pane };
  }

  app.get("/api/panes/:id/app-studio/settings", routeOptions, async (request) => {
    const { pane } = await paneOf(request);
    return { metadata: service.metadata(pane) };
  });
  app.put("/api/panes/:id/app-studio/settings", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const metadata = await service.updateSettings(owner, pane, parseBody(appStudioPaneMetadataSchema, request.body ?? {}));
    await deps.audit(request, "app_studio.settings.update", pane.id, { paused: metadata.settings.paused, devices: metadata.settings.devices });
    return { metadata };
  });
  // Everything the pane shows in one read: settings, run, the latest previews and the feed.
  app.get("/api/panes/:id/app-studio/state", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const [run, previews, events] = await Promise.all([service.runView(owner, pane), service.previews(owner, pane), service.events(owner, pane, 100)]);
    return { metadata: service.metadata(pane), run, previews, events };
  });
  app.post("/api/panes/:id/app-studio/briefs", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const created = await service.addBrief(owner, pane, parseBody(appStudioBriefCreateSchema, request.body ?? {}).text, "OPERATOR");
    await deps.audit(request, "app_studio.brief.create", created.brief.id, { paneId: pane.id, kickoffSent: created.kickoffSent });
    return created;
  });
  app.post("/api/panes/:id/app-studio/questions/:questionId/answer", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const { questionId } = parseQuery(questionParamsSchema, request.params);
    const question = await service.answer(owner, pane, questionId, parseBody(appStudioAnswerSchema, request.body ?? {}).answer, "OPERATOR");
    await deps.audit(request, "app_studio.question.answer", questionId, { paneId: pane.id });
    return { question };
  });
  app.get("/api/panes/:id/app-studio/run", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    return service.runView(owner, pane);
  });
  for (const action of ["start", "pause", "stop"] as const) {
    app.post(`/api/panes/:id/app-studio/run/${action}`, routeOptions, async (request) => {
      const { owner, pane } = await paneOf(request);
      const view = await service.setRun(owner, pane, action);
      await deps.audit(request, `app_studio.run.${action}`, pane.id, { kickoffSent: view.kickoffSent });
      return view;
    });
  }
}
