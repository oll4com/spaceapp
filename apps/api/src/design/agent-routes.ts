import type {} from "../request-context.js";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DESIGN_ENGINE_LABELS, DESIGN_TEMPLATE_IDS, DESIGN_TEMPLATE_LABELS, designAssetIdSchema, designFormatRefSchema, designRequestCreateSchema, designRequestIdSchema,
  type DesignAssetMadeBy, type Pane
} from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { readStagedUpload, withStagedUploads } from "../multipart-upload.js";
import { designAssetQuerySchema, designDescriptionSchema, designGenerateBodySchema, designRenderBodySchema } from "./routes.js";
import type { DesignService } from "./service.js";

// Agent-facing routes of the Design pane, reached with the pane-scoped CLI bridge token. Requester routes serve every CLI pane
// of a room with an owner (it asks for a design and waits for it); worker routes serve only the CLI session of a Design pane.
export const cliDesignPathPrefix = "/api/cli/design/";

interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface DesignAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane">;
  routeOptions: Record<string, unknown>;
  /** `runtimeId` is the calling CLI session's runtime, as the bridge resolved it. */
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims; runtimeId?: string | null } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** Where uploads are staged (the artifact root). */
  uploadRoot: string;
}

const requestParamsSchema = z.object({ id: designRequestIdSchema }).strict();
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** The model the designer declares it runs (e.g. claude-opus-5-5): mandatory on every design it makes. */
const madeByModelSchema = z.string().trim().min(1).max(120);

export function registerDesignAgentRoutes(app: FastifyInstance, service: DesignService, deps: DesignAgentRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  type Bridge = { owner: string; pane: Pane; runtimeId: string | null };

  async function context(request: FastifyRequest, reply: FastifyReply, worker: boolean): Promise<Bridge | null> {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return null;
    const room = await deps.store.getRoom(bridge.claims.roomId);
    if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; ask for designs from a pane of a signed-in operator's room.");
    const pane = await deps.store.getPane(bridge.claims.paneId);
    if (worker && pane.mode !== "DESIGN") throw new SpaceConflictError("Design worker tools belong to the CLI session of a Design pane; other panes use space_design_request.");
    return { owner: room.ownerUserId, pane, runtimeId: bridge.runtimeId ?? null };
  }
  const madeBy = (bridge: Bridge, model: string): DesignAssetMadeBy => ({ by: "AGENT", runtimeId: bridge.runtimeId, model });
  function handle(method: "get" | "post", path: string, worker: boolean, handler: (bridge: Bridge, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
    app[method](`${cliDesignPathPrefix}${path}`, routeOptions, async (request, reply) => {
      const bridge = await context(request, reply, worker);
      if (!bridge) return reply;
      return handler(bridge, request, reply);
    });
  }
  /** A requester sees its own requests; the Design pane sees every request of the owner. */
  async function visibleRequest(bridge: Bridge, id: string) {
    const view = await service.request(bridge.owner, id);
    if (bridge.pane.mode !== "DESIGN" && view.request.requester.paneId !== bridge.pane.id) throw new SpaceNotFoundError(`Design request ${id} was not found.`);
    return view;
  }

  // ---- requester tools (any CLI pane) ------------------------------------------------------------
  handle("get", "formats", false, async () => ({
    formats: service.formats(),
    engines: DESIGN_ENGINE_LABELS,
    templates: DESIGN_TEMPLATE_IDS.map((id) => ({ id, label: DESIGN_TEMPLATE_LABELS[id] }))
  }));
  handle("post", "requests", false, async ({ owner, pane }, request) => {
    const input = parseBody(designRequestCreateSchema, request.body ?? {});
    const created = await service.createRequest(owner, { kind: "PANE", paneId: pane.id, roomId: pane.roomId, label: (pane.paneName ? `${pane.paneName} (${pane.title})` : pane.title).slice(0, 120) }, input);
    await deps.audit(request, "design.request.create", created.request.id, { paneId: pane.id, formats: created.request.formatIds, designPaneId: created.designPaneId });
    return created;
  });
  handle("get", "requests/:id", false, async (bridge, request) => visibleRequest(bridge, parseQuery(requestParamsSchema, request.params).id));
  handle("post", "requests/:id/wait", false, async (bridge, request) => {
    const { id } = parseQuery(requestParamsSchema, request.params);
    await visibleRequest(bridge, id);
    return service.waitForRequest(bridge.owner, id, parseBody(z.object({ waitMs: z.number().int().min(0).max(50_000).default(30_000) }).strict(), request.body ?? {}).waitMs);
  });

  // Every agent picks a brand kit for its requests, like the operator in the Studio.
  handle("get", "brand-kits", false, async ({ owner }) => ({ brandKits: await service.brandKits(owner) }));

  // ---- worker tools (the Design pane's CLI) ------------------------------------------------------
  handle("post", "next", true, async ({ owner, pane }) => service.takeNext(owner, pane));
  handle("post", "generate", true, async (bridge, request) => {
    const { madeByModel, ...input } = parseBody(designGenerateBodySchema.extend({ madeByModel: madeByModelSchema }), request.body ?? {});
    const generated = await service.generateImage(bridge.owner, bridge.pane, { ...input, madeBy: madeBy(bridge, madeByModel) });
    await deps.audit(request, "design.generate", generated.asset.id, { paneId: bridge.pane.id, engine: input.engine, formatId: input.formatId, model: generated.asset.model });
    return generated;
  });
  handle("post", "render", true, async (bridge, request) => {
    const { madeByModel, ...input } = parseBody(designRenderBodySchema.extend({ madeByModel: madeByModelSchema }), request.body ?? {});
    return { asset: await service.render(bridge.owner, bridge.pane, { ...input, madeBy: madeBy(bridge, madeByModel) }) };
  });
  handle("get", "assets", true, async ({ owner }, request) => ({ assets: await service.listAssets(owner, parseQuery(designAssetQuerySchema, request.query ?? {})) }));
  // An asset's bytes (space_design_asset_file): the designer edits the owner's assets of its own room; a requester (an App Studio
  // pane putting an icon in its app) reads only what its own delivered requests carry.
  handle("get", "assets/:id/file", false, async ({ owner, pane }, request, reply) => {
    const { id } = parseQuery(z.object({ id: designAssetIdSchema }), request.params);
    if (pane.mode !== "DESIGN") {
      const delivered = await service.listRequests(owner, { requesterPaneId: pane.id, status: ["DELIVERED"], limit: 100 });
      if (!delivered.some((row) => row.resultAssetIds.includes(id))) throw new SpaceNotFoundError(`Design asset ${id} is not in a delivered request of this pane.`);
    }
    const { asset, path } = await service.assetFile(owner, id, pane.mode === "DESIGN" ? pane.roomId : undefined);
    const bytes = await readFile(path).catch(() => { throw new SpaceNotFoundError(`The file of design asset ${id} is gone.`); });
    await deps.audit(request, "design.asset.file", asset.id, { paneId: pane.id });
    return reply.type(asset.mimeType).header("cache-control", "no-store").send(bytes);
  });
  // A file the agent made in the pane (a HyperFrames MP4 or GIF, an edited PNG): typed by its bytes, never by its name.
  handle("post", "assets", true, async (bridge, request) => {
    const { owner, pane } = bridge;
    const fields: Record<string, string> = {};
    const asset = await withStagedUploads(request, deps.uploadRoot, { maxFiles: 1, fileBytes: MAX_UPLOAD_BYTES, fields: 8, onField: (name, value) => { if (typeof value === "string") fields[name] = value; } },
      async (uploads) => {
        const input = z.object({
          formatId: designFormatRefSchema, engine: z.enum(["MOTION", "UPLOAD"]).default("UPLOAD"), label: z.string().trim().min(1).max(200).optional(),
          prompt: z.string().trim().min(1).max(4000).optional(), requestId: designRequestIdSchema.optional(), parentAssetId: designAssetIdSchema.optional(),
          description: designDescriptionSchema, madeByModel: madeByModelSchema
        }).strict().parse(fields);
        return service.saveAsset(owner, pane, { bytes: await readStagedUpload(deps.uploadRoot, uploads[0]!), formatId: input.formatId, engine: input.engine, label: input.label ?? null,
          prompt: input.prompt ?? null, requestId: input.requestId ?? null, parentAssetId: input.parentAssetId ?? null, description: input.description,
          madeBy: madeBy(bridge, input.madeByModel) });
      });
    await deps.audit(request, "design.asset.upload", asset.id, { paneId: pane.id, mimeType: asset.mimeType, formatId: asset.formatId });
    return { asset };
  });
  handle("post", "ask", true, async ({ owner, pane }, request) => {
    const input = parseBody(z.object({ requestId: designRequestIdSchema, question: z.string().trim().min(1).max(2000) }).strict(), request.body ?? {});
    return service.ask(owner, pane, input.requestId, input.question);
  });
  handle("post", "deliver", true, async ({ owner, pane }, request) => {
    const input = parseBody(z.object({ requestId: designRequestIdSchema, assetIds: z.array(designAssetIdSchema).min(1).max(32), message: z.string().trim().max(2000).optional() }).strict(), request.body ?? {});
    const delivered = await service.deliver(owner, pane, input.requestId, input);
    await deps.audit(request, "design.request.deliver", input.requestId, { paneId: pane.id, status: delivered.request.status, assets: input.assetIds.length });
    return delivered;
  });
  handle("post", "fail", true, async ({ owner, pane }, request) => {
    const input = parseBody(z.object({ requestId: designRequestIdSchema, reason: z.string().trim().min(1).max(2000) }).strict(), request.body ?? {});
    return service.fail(owner, pane, input.requestId, input.reason);
  });
}
