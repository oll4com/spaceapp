import type {} from "../request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DESIGN_ENGINE_LABELS, DESIGN_TEMPLATE_IDS, DESIGN_TEMPLATE_LABELS, designAssetIdSchema, designFormatRefSchema, designRequestCreateSchema, designRequestIdSchema, type Pane
} from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { readStagedUpload, withStagedUploads } from "../multipart-upload.js";
import { designAssetQuerySchema, designGenerateBodySchema, designRenderBodySchema } from "./routes.js";
import type { DesignService } from "./service.js";

// Agent-facing routes of the Design pane, reached with the pane-scoped CLI bridge token. Requester routes serve every CLI pane
// of a room with an owner (it asks for a design and waits for it); worker routes serve only the CLI session of a Design pane.
export const cliDesignPathPrefix = "/api/cli/design/";

interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface DesignAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** Where uploads are staged (the artifact root). */
  uploadRoot: string;
}

const requestParamsSchema = z.object({ id: designRequestIdSchema }).strict();
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function registerDesignAgentRoutes(app: FastifyInstance, service: DesignService, deps: DesignAgentRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  type Bridge = { owner: string; pane: Pane };

  async function context(request: FastifyRequest, reply: FastifyReply, worker: boolean): Promise<Bridge | null> {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return null;
    const room = await deps.store.getRoom(bridge.claims.roomId);
    if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; ask for designs from a pane of a signed-in operator's room.");
    const pane = await deps.store.getPane(bridge.claims.paneId);
    if (worker && pane.mode !== "DESIGN") throw new SpaceConflictError("Design worker tools belong to the CLI session of a Design pane; other panes use space_design_request.");
    return { owner: room.ownerUserId, pane };
  }
  function handle(method: "get" | "post", path: string, worker: boolean, handler: (bridge: Bridge, request: FastifyRequest) => Promise<unknown>) {
    app[method](`${cliDesignPathPrefix}${path}`, routeOptions, async (request, reply) => {
      const bridge = await context(request, reply, worker);
      if (!bridge) return reply;
      return handler(bridge, request);
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

  // ---- worker tools (the Design pane's CLI) ------------------------------------------------------
  handle("post", "next", true, async ({ owner, pane }) => service.takeNext(owner, pane));
  handle("post", "generate", true, async ({ owner, pane }, request) => {
    const input = parseBody(designGenerateBodySchema, request.body ?? {});
    const generated = await service.generateImage(owner, pane, input);
    await deps.audit(request, "design.generate", generated.asset.id, { paneId: pane.id, engine: input.engine, formatId: input.formatId, model: generated.asset.model });
    return generated;
  });
  handle("post", "render", true, async ({ owner, pane }, request) => ({ asset: await service.render(owner, pane, parseBody(designRenderBodySchema, request.body ?? {})) }));
  handle("get", "assets", true, async ({ owner }, request) => ({ assets: await service.listAssets(owner, parseQuery(designAssetQuerySchema, request.query ?? {})) }));
  handle("get", "brand-kits", true, async ({ owner }) => ({ brandKits: await service.brandKits(owner) }));
  // A file the agent made in the pane (a HyperFrames MP4 or GIF, an edited PNG): typed by its bytes, never by its name.
  handle("post", "assets", true, async ({ owner, pane }, request) => {
    const fields: Record<string, string> = {};
    const asset = await withStagedUploads(request, deps.uploadRoot, { maxFiles: 1, fileBytes: MAX_UPLOAD_BYTES, onField: (name, value) => { if (typeof value === "string") fields[name] = value; } },
      async (uploads) => {
        const input = z.object({
          formatId: designFormatRefSchema, engine: z.enum(["MOTION", "UPLOAD"]).default("UPLOAD"), label: z.string().trim().min(1).max(200).optional(),
          prompt: z.string().trim().min(1).max(4000).optional(), requestId: designRequestIdSchema.optional(), parentAssetId: designAssetIdSchema.optional()
        }).strict().parse(fields);
        return service.saveAsset(owner, pane, { bytes: await readStagedUpload(deps.uploadRoot, uploads[0]!), formatId: input.formatId, engine: input.engine, label: input.label ?? null,
          prompt: input.prompt ?? null, requestId: input.requestId ?? null, parentAssetId: input.parentAssetId ?? null });
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
