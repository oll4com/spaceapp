import type {} from "../request-context.js";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  VIDEO_CAPTION_STYLES, VIDEO_FILTERS, VIDEO_REFRAME_MODES, VIDEO_TECHNIQUES, VIDEO_TRANSITIONS, VIDEO_TTS_ENGINES, VIDEO_TTS_LANGUAGES, videoAssetIdSchema, videoJobIdSchema,
  videoReframeSchema, videoRequestCreateSchema, videoRequestIdSchema, videoTechniqueSchema, videoTimelineSchema, videoTtsEngineSchema, type DesignAssetMadeBy, type Pane
} from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { withStagedUploads } from "../multipart-upload.js";
import { videoAssetQuerySchema, videoDescriptionSchema, videoMusicFetchSchema, videoMusicSearchSchema } from "./routes.js";
import type { VideoService } from "./service.js";

// Agent-facing routes of the Video pane, reached with the pane-scoped CLI bridge token. Requester routes serve every CLI pane of
// a room with an owner (it asks for a video and waits for it); worker routes serve only the CLI session of a Video pane.
export const cliVideoPathPrefix = "/api/cli/video/";

interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface VideoAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims; runtimeId?: string | null } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** Where uploads are staged (the artifact root). */
  uploadRoot: string;
}

const requestParamsSchema = z.object({ id: videoRequestIdSchema }).strict();
const jobParamsSchema = z.object({ id: videoJobIdSchema }).strict();
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** The model the editor declares it runs (e.g. claude-opus-5-5): mandatory on every file it makes. */
const madeByModelSchema = z.string().trim().min(1).max(120);
const artifactIdSchema = z.string().regex(/^artifact:[A-Za-z0-9_-]{6,80}$/);
const selection = { requestId: videoRequestIdSchema.optional(), sourceArtifactIds: z.array(artifactIdSchema).max(8).optional(), sourceIndex: z.number().int().min(0).max(7).optional() };
const languageTag = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/);

export function registerVideoAgentRoutes(app: FastifyInstance, service: VideoService, deps: VideoAgentRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  type Bridge = { owner: string; pane: Pane; runtimeId: string | null };

  async function context(request: FastifyRequest, reply: FastifyReply, worker: boolean): Promise<Bridge | null> {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return null;
    const room = await deps.store.getRoom(bridge.claims.roomId);
    if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; ask for videos from a pane of a signed-in operator's room.");
    const pane = await deps.store.getPane(bridge.claims.paneId);
    if (worker && pane.mode !== "VIDEO") throw new SpaceConflictError("Video worker tools belong to the CLI session of a Video pane; other panes use space_video_request.");
    return { owner: room.ownerUserId, pane, runtimeId: bridge.runtimeId ?? null };
  }
  const madeBy = (bridge: Bridge, model: string): DesignAssetMadeBy => ({ by: "AGENT", runtimeId: bridge.runtimeId, model });
  function handle(method: "get" | "post", path: string, worker: boolean, handler: (bridge: Bridge, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
    app[method](`${cliVideoPathPrefix}${path}`, routeOptions, async (request, reply) => {
      const bridge = await context(request, reply, worker);
      if (!bridge) return reply;
      return handler(bridge, request, reply);
    });
  }
  /** A requester sees its own requests; the Video pane sees every request of the owner. */
  async function visibleRequest(bridge: Bridge, id: string) {
    const view = await service.request(bridge.owner, id);
    if (bridge.pane.mode !== "VIDEO" && view.request.requester.paneId !== bridge.pane.id) throw new SpaceNotFoundError(`Video request ${id} was not found.`);
    return view;
  }

  // ---- requester tools (any CLI pane) ------------------------------------------------------------
  handle("get", "formats", false, async () => ({
    formats: service.formats(), techniques: VIDEO_TECHNIQUES, reframe: VIDEO_REFRAME_MODES, transitions: VIDEO_TRANSITIONS, filters: VIDEO_FILTERS, captions: VIDEO_CAPTION_STYLES,
    tts: { engines: VIDEO_TTS_ENGINES, languages: VIDEO_TTS_LANGUAGES }
  }));
  handle("post", "requests", false, async ({ owner, pane }, request) => {
    const input = parseBody(videoRequestCreateSchema, request.body ?? {});
    const created = await service.createRequest(owner, { kind: "PANE", paneId: pane.id, roomId: pane.roomId, label: (pane.paneName ? `${pane.paneName} (${pane.title})` : pane.title).slice(0, 120) }, input);
    await deps.audit(request, "video.request.create", created.request.id, { paneId: pane.id, formats: created.request.formatIds, videoPaneId: created.videoPaneId });
    return created;
  });
  handle("get", "requests/:id", false, async (bridge, request) => visibleRequest(bridge, parseQuery(requestParamsSchema, request.params).id));
  handle("post", "requests/:id/wait", false, async (bridge, request) => {
    const { id } = parseQuery(requestParamsSchema, request.params);
    await visibleRequest(bridge, id);
    return service.waitForRequest(bridge.owner, id, parseBody(z.object({ waitMs: z.number().int().min(0).max(50_000).default(30_000) }).strict(), request.body ?? {}).waitMs);
  });
  // An asset's bytes (space_video_asset_file): the editor reads the owner's assets of its own room; a requester only what its own delivered requests carry.
  handle("get", "assets/:id/file", false, async ({ owner, pane }, request, reply) => {
    const { id } = parseQuery(z.object({ id: videoAssetIdSchema }), request.params);
    if (pane.mode !== "VIDEO") {
      const delivered = await service.listRequests(owner, { requesterPaneId: pane.id, status: ["DELIVERED"], limit: 100 });
      if (!delivered.some((row) => row.resultAssetIds.includes(id))) throw new SpaceNotFoundError(`Video asset ${id} is not in a delivered request of this pane.`);
    }
    const { asset, path } = await service.assetFile(owner, id, pane.mode === "VIDEO" ? pane.roomId : undefined);
    const info = await stat(path).catch(() => { throw new SpaceNotFoundError(`The file of video asset ${id} is gone.`); });
    await deps.audit(request, "video.asset.file", asset.id, { paneId: pane.id });
    return reply.type(asset.mimeType).header("content-length", String(info.size)).header("cache-control", "no-store").send(createReadStream(path));
  });

  // ---- worker tools (the Video pane's CLI) -------------------------------------------------------
  handle("post", "next", true, async ({ owner, pane }) => service.takeNext(owner, pane));
  handle("post", "fetch", true, async (bridge, request) => {
    const input = parseBody(z.object({ requestId: videoRequestIdSchema, sourceIndex: z.number().int().min(0).max(7), maxDurationSec: z.number().min(1).max(3600).optional(), madeByModel: madeByModelSchema }).strict(), request.body ?? {});
    return { job: await service.fetch(bridge.owner, bridge.pane, { ...input, madeBy: madeBy(bridge, input.madeByModel) }) };
  });
  handle("post", "probe", true, async ({ owner, pane }, request) => ({ job: await service.probe(owner, pane, parseBody(z.object(selection).strict(), request.body ?? {})) }));
  handle("post", "transcribe", true, async ({ owner, pane }, request) => ({ job: await service.transcribe(owner, pane, parseBody(z.object({ ...selection, language: languageTag.nullable().optional() }).strict(), request.body ?? {})) }));
  handle("post", "analyze", true, async ({ owner, pane }, request) => ({ job: await service.analyze(owner, pane, parseBody(z.object({ ...selection, technique: videoTechniqueSchema.optional(), reframe: videoReframeSchema.optional(),
    wordsPath: z.string().max(1000).nullable().optional(), silenceDb: z.number().min(-60).max(0).optional(), minSilenceSec: z.number().min(0.1).max(10).optional(), sceneThreshold: z.number().min(1).max(100).optional() }).strict(), request.body ?? {})) }));
  handle("post", "assemble", true, async (bridge, request) => {
    const { madeByModel, ...input } = parseBody(z.object({ ...selection, timeline: videoTimelineSchema, wordsPath: z.string().max(1000).nullable().optional(), analysisPath: z.string().max(1000).nullable().optional(),
      description: videoDescriptionSchema, label: z.string().trim().min(1).max(200).optional(), parentAssetId: videoAssetIdSchema.optional(), madeByModel: madeByModelSchema }).strict(), request.body ?? {});
    const job = await service.assemble(bridge.owner, bridge.pane, { ...input, madeBy: madeBy(bridge, madeByModel) });
    await deps.audit(request, "video.assemble", job.id, { paneId: bridge.pane.id, outputs: input.timeline.outputs.map((output) => output.formatId), requestId: input.requestId ?? null });
    return { job };
  });
  handle("post", "tts", true, async (bridge, request) => {
    const { madeByModel, ...input } = parseBody(z.object({ text: z.string().trim().min(1).max(8000), engine: videoTtsEngineSchema.optional(), voice: z.string().trim().max(60).nullable().optional(), language: languageTag.optional(),
      requestId: videoRequestIdSchema.optional(), label: z.string().trim().min(1).max(200).optional(), madeByModel: madeByModelSchema }).strict(), request.body ?? {});
    return { job: await service.tts(bridge.owner, bridge.pane, { ...input, madeBy: madeBy(bridge, madeByModel) }) };
  });
  handle("post", "music/search", true, async ({ owner, pane }, request) => service.musicSearch(owner, pane, parseBody(videoMusicSearchSchema, request.body ?? {})));
  handle("post", "music/fetch", true, async (bridge, request) => {
    const { madeByModel, ...input } = parseBody(videoMusicFetchSchema.extend({ madeByModel: madeByModelSchema }).strict(), request.body ?? {});
    return service.musicFetch(bridge.owner, bridge.pane, { ...input, madeBy: madeBy(bridge, madeByModel) });
  });
  handle("get", "jobs/:id", true, async ({ owner }, request) => ({ job: service.job(owner, parseQuery(jobParamsSchema, request.params).id) }));
  handle("post", "jobs/:id/wait", true, async ({ owner }, request) => ({ job: await service.waitJob(owner, parseQuery(jobParamsSchema, request.params).id,
    parseBody(z.object({ waitMs: z.number().int().min(0).max(300_000).default(120_000) }).strict(), request.body ?? {}).waitMs) }));
  handle("get", "assets", true, async ({ owner }, request) => {
    const query = parseQuery(videoAssetQuerySchema, request.query ?? {});
    return { assets: await service.listAssets(owner, { formatId: query.formatId, kinds: query.kind ? [query.kind] : undefined, requestId: query.requestId, limit: query.limit }) };
  });
  // A file the agent made in the pane (a HyperFrames MP4, a title card PNG, a track): typed by its bytes, never by its name.
  handle("post", "assets", true, async (bridge, request) => {
    const { owner, pane } = bridge;
    const fields: Record<string, string> = {};
    const added = await withStagedUploads(request, deps.uploadRoot, { maxFiles: 1, fileBytes: MAX_UPLOAD_BYTES, fields: 8, onField: (name, value) => { if (typeof value === "string") fields[name] = value; } },
      async (uploads) => {
        const input = z.object({ label: z.string().trim().min(1).max(200).optional(), requestId: videoRequestIdSchema.optional(), description: videoDescriptionSchema, madeByModel: madeByModelSchema }).strict().parse(fields);
        return service.addSource(owner, pane, { path: uploads[0]!.sourcePath, filename: uploads[0]!.filename, kind: "UPLOAD", label: input.label ?? null, description: input.description, requestId: input.requestId ?? null, madeBy: madeBy(bridge, input.madeByModel) });
      });
    await deps.audit(request, "video.asset.upload", added.asset.id, { paneId: pane.id, mimeType: added.asset.mimeType });
    return added;
  });
  handle("post", "ask", true, async ({ owner, pane }, request) => {
    const input = parseBody(z.object({ requestId: videoRequestIdSchema, question: z.string().trim().min(1).max(2000) }).strict(), request.body ?? {});
    return service.ask(owner, pane, input.requestId, input.question);
  });
  handle("post", "deliver", true, async ({ owner, pane }, request) => {
    const input = parseBody(z.object({ requestId: videoRequestIdSchema, assetIds: z.array(videoAssetIdSchema).min(1).max(32), message: z.string().trim().max(2000).optional() }).strict(), request.body ?? {});
    const delivered = await service.deliver(owner, pane, input.requestId, input);
    await deps.audit(request, "video.request.deliver", input.requestId, { paneId: pane.id, status: delivered.request.status, assets: input.assetIds.length });
    return delivered;
  });
  handle("post", "fail", true, async ({ owner, pane }, request) => {
    const input = parseBody(z.object({ requestId: videoRequestIdSchema, reason: z.string().trim().min(1).max(2000) }).strict(), request.body ?? {});
    return service.fail(owner, pane, input.requestId, input.reason);
  });
}
