import type {} from "../request-context.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DESIGN_IMAGE_ENGINES, DESIGN_NETWORKS, DESIGN_REQUEST_STATUSES, DESIGN_TABS, designAssetIdSchema, designBrandKitIdSchema, designBrandKitInputSchema, designFormatRefSchema,
  designPaneMetadataSchema, designRequestCreateSchema, designRequestIdSchema, designTemplateIdSchema, type Pane
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { DesignService } from "./service.js";

export interface DesignRouteDependencies {
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
// Not strict: the request and asset routes carry their id next to the pane id.
const paneParamsSchema = z.object({ id: paneIdSchema });
const requestParamsSchema = z.object({ id: paneIdSchema, requestId: designRequestIdSchema }).strict();
const assetParamsSchema = z.object({ id: paneIdSchema, assetId: designAssetIdSchema }).strict();
const kitParamsSchema = z.object({ id: designBrandKitIdSchema }).strict();
const artifactId = z.string().regex(/^artifact:[A-Za-z0-9_-]{6,80}$/);
const params = z.record(z.string().max(40), z.unknown()).refine((value) => Object.keys(value).length <= 20 && JSON.stringify(value).length <= 8000, "Template fields are limited.");

export const designRenderBodySchema = z.object({
  templateId: designTemplateIdSchema,
  formatId: designFormatRefSchema,
  params: params.optional(),
  backgroundAssetId: designAssetIdSchema.nullable().optional(),
  screenshotArtifactId: artifactId.nullable().optional(),
  brandKitId: designBrandKitIdSchema.nullable().optional(),
  output: z.enum(["png", "jpeg", "webp"]).optional(),
  requestId: designRequestIdSchema.nullable().optional(),
  label: z.string().trim().min(1).max(200).nullable().optional()
}).strict();
export const designGenerateBodySchema = z.object({
  engine: z.enum(DESIGN_IMAGE_ENGINES).exclude(["TEMPLATE"]),
  prompt: z.string().trim().min(1).max(4000),
  formatId: designFormatRefSchema,
  referenceArtifactIds: z.array(artifactId).max(3).optional(),
  requestId: designRequestIdSchema.nullable().optional(),
  label: z.string().trim().min(1).max(200).nullable().optional()
}).strict();
export const designVariantsBodySchema = z.object({
  formatIds: z.array(designFormatRefSchema).max(8).optional(),
  params: params.optional(),
  requestId: designRequestIdSchema.nullable().optional()
}).strict();
export const designAssetQuerySchema = z.object({
  network: z.enum(DESIGN_NETWORKS).optional(),
  formatId: designFormatRefSchema.optional(),
  brandKitId: designBrandKitIdSchema.optional(),
  requestId: designRequestIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200)
}).strict();
const deliverBodySchema = z.object({ assetIds: z.array(designAssetIdSchema).max(32).optional(), message: z.string().trim().max(2000).nullable().optional() }).strict();

/** Operator routes of the Design pane: settings and view, the Studio's render and generate, the library, requests and brand kits. */
export function registerDesignRoutes(app: FastifyInstance, service: DesignService, deps: DesignRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;

  async function paneOf(request: FastifyRequest): Promise<{ owner: string; pane: Pane }> {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(paneParamsSchema, request.params);
    const pane = await deps.store.getPane(params.id);
    await deps.assertPaneAccess(request, pane);
    if (pane.mode !== "DESIGN") throw new SpaceConflictError("This belongs to a Design pane.");
    return { owner, pane };
  }

  app.get("/api/design/formats", routeOptions, async (request) => {
    await deps.authenticatedOwner(request);
    return { formats: service.formats() };
  });

  app.get("/api/panes/:id/design/settings", routeOptions, async (request) => {
    const { pane } = await paneOf(request);
    return { metadata: service.metadata(pane) };
  });
  app.put("/api/panes/:id/design/settings", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const metadata = await service.updateSettings(owner, pane, parseBody(designPaneMetadataSchema, request.body ?? {}));
    await deps.audit(request, "design.settings.update", pane.id, { requestAutonomy: metadata.settings.requestAutonomy, paused: metadata.settings.paused, defaultEngine: metadata.settings.defaultEngine });
    return { metadata };
  });
  app.put("/api/panes/:id/design/view", routeOptions, async (request) => {
    const { pane } = await paneOf(request);
    const input = parseBody(z.object({
      tab: z.enum(DESIGN_TABS).nullable().default(null), requestId: designRequestIdSchema.nullable().default(null),
      assetId: designAssetIdSchema.nullable().default(null), formatId: designFormatRefSchema.nullable().default(null)
    }).strict(), request.body ?? {});
    return { view: await service.updateView(pane, input) };
  });

  // ---- the Studio -------------------------------------------------------------------------------
  app.post("/api/panes/:id/design/render", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const input = parseBody(designRenderBodySchema, request.body ?? {});
    const asset = await service.render(owner, pane, input);
    await deps.audit(request, "design.render", asset.id, { templateId: input.templateId, formatId: input.formatId });
    return { asset };
  });
  app.post("/api/panes/:id/design/generate", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const input = parseBody(designGenerateBodySchema, request.body ?? {});
    const generated = await service.generateImage(owner, pane, input);
    await deps.audit(request, "design.generate", generated.asset.id, { engine: input.engine, formatId: input.formatId, model: generated.asset.model });
    return generated;
  });

  // ---- the library ------------------------------------------------------------------------------
  app.get("/api/panes/:id/design/assets", routeOptions, async (request) => {
    const { owner } = await paneOf(request);
    return { assets: await service.listAssets(owner, parseQuery(designAssetQuerySchema, request.query ?? {})) };
  });
  app.post("/api/panes/:id/design/assets/:assetId/variants", routeOptions, async (request) => {
    const params = parseQuery(assetParamsSchema, request.params);
    const { owner, pane } = await paneOf(request);
    const assets = await service.variants(owner, pane, params.assetId, parseBody(designVariantsBodySchema, request.body ?? {}));
    await deps.audit(request, "design.variants", params.assetId, { count: assets.length });
    return { assets };
  });
  app.delete("/api/panes/:id/design/assets/:assetId", routeOptions, async (request) => {
    const params = parseQuery(assetParamsSchema, request.params);
    const { owner } = await paneOf(request);
    await service.deleteAsset(owner, params.assetId);
    await deps.audit(request, "design.asset.delete", params.assetId);
    return { deleted: true };
  });

  // ---- requests ---------------------------------------------------------------------------------
  app.get("/api/panes/:id/design/requests", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const query = parseQuery(z.object({ status: z.enum(DESIGN_REQUEST_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict(), request.query ?? {});
    // This pane's requests and the ones no Design pane has taken yet.
    const requests = (await service.listRequests(owner, { status: query.status ? [query.status] : undefined, limit: query.limit }))
      .filter((entry) => entry.designPaneId === pane.id || entry.designPaneId === null);
    return { requests };
  });
  app.post("/api/panes/:id/design/requests", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const input = parseBody(designRequestCreateSchema, request.body ?? {});
    const created = await service.createRequest(owner, { kind: "OPERATOR", roomId: pane.roomId, label: "You" }, { ...input, designPaneId: input.designPaneId ?? pane.id });
    await deps.audit(request, "design.request.create", created.request.id, { formats: created.request.formatIds });
    return created;
  });
  app.get("/api/panes/:id/design/requests/:requestId", routeOptions, async (request) => {
    const params = parseQuery(requestParamsSchema, request.params);
    const { owner } = await paneOf(request);
    return { ...(await service.request(owner, params.requestId)), events: await service.events(owner, { requestId: params.requestId, limit: 100 }) };
  });
  for (const action of ["approve", "deliver"] as const) {
    app.post(`/api/panes/:id/design/requests/:requestId/${action}`, routeOptions, async (request) => {
      const params = parseQuery(requestParamsSchema, request.params);
      const { owner } = await paneOf(request);
      const delivered = await service.approve(owner, params.requestId, parseBody(deliverBodySchema, request.body ?? {}));
      await deps.audit(request, `design.request.${action}`, params.requestId, { assets: delivered.assets.length });
      return delivered;
    });
  }
  app.post("/api/panes/:id/design/requests/:requestId/cancel", routeOptions, async (request) => {
    const params = parseQuery(requestParamsSchema, request.params);
    const { owner } = await paneOf(request);
    const cancelled = await service.cancel(owner, params.requestId, "you");
    await deps.audit(request, "design.request.cancel", params.requestId);
    return cancelled;
  });
  app.post("/api/panes/:id/design/requests/:requestId/answer", routeOptions, async (request) => {
    const params = parseQuery(requestParamsSchema, request.params);
    const { owner, pane } = await paneOf(request);
    const answered = await service.answer(owner, params.requestId, parseBody(z.object({ answer: z.string().trim().min(1).max(2000) }).strict(), request.body ?? {}).answer);
    await deps.audit(request, "design.request.answer", params.requestId);
    void service.autostart(owner, pane);
    return answered;
  });
  app.get("/api/panes/:id/design/events", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const query = parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).strict(), request.query ?? {});
    return { events: await service.events(owner, { paneId: pane.id, limit: query.limit }) };
  });

  // A request from another pane the operator works in (Marketing Copilot's "Make graphic"), routed to their Design pane.
  app.post("/api/design/requests", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(designRequestCreateSchema.extend({ fromPaneId: paneIdSchema }).strict(), request.body ?? {});
    const { fromPaneId, ...create } = input;
    const from = await deps.store.getPane(fromPaneId);
    await deps.assertPaneAccess(request, from);
    const created = await service.createRequest(owner, { kind: "OPERATOR", paneId: from.id, roomId: from.roomId, label: `You, from ${from.title}`.slice(0, 120) }, create);
    await deps.audit(request, "design.request.create", created.request.id, { fromPaneId: from.id, formats: created.request.formatIds, callback: created.request.callback?.kind ?? null });
    return created;
  });

  // ---- brand kits -------------------------------------------------------------------------------
  app.get("/api/design/brand-kits", routeOptions, async (request) => ({ brandKits: await service.brandKits(await deps.authenticatedOwner(request)) }));
  app.post("/api/design/brand-kits", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const kit = await service.createBrandKit(owner, parseBody(designBrandKitInputSchema, request.body ?? {}));
    await deps.audit(request, "design.brand_kit.create", kit.id, { name: kit.name });
    return { brandKit: kit };
  });
  app.put("/api/design/brand-kits/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(kitParamsSchema, request.params);
    const kit = await service.updateBrandKit(owner, params.id, parseBody(designBrandKitInputSchema.partial().strict(), request.body ?? {}));
    await deps.audit(request, "design.brand_kit.update", kit.id, { name: kit.name });
    return { brandKit: kit };
  });
  app.delete("/api/design/brand-kits/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(kitParamsSchema, request.params);
    await service.deleteBrandKit(owner, params.id);
    await deps.audit(request, "design.brand_kit.delete", params.id);
    return { deleted: true };
  });
}
