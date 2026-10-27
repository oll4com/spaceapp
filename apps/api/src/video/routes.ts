import type {} from "../request-context.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  VIDEO_ASSET_DESCRIPTION_MAX, VIDEO_ASSET_KINDS, VIDEO_REQUEST_STATUSES, VIDEO_TABS, videoAssetIdSchema, videoFormatRefSchema, videoJobIdSchema, videoPaneMetadataSchema,
  videoRequestCreateSchema, videoRequestIdSchema, youtubeDownloadSettingsSchema, type DesignAssetMadeBy, type Pane
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import { withStagedUploads } from "../multipart-upload.js";
import type { VideoService } from "./service.js";

export interface VideoRouteDependencies {
  store: Pick<SpaceStore, "getPane" | "getUserSettings">;
  routeOptions: Record<string, unknown>;
  /** Resolves the signed-in owner; throws the API's 401 error when absent. */
  authenticatedOwner(request: FastifyRequest): Promise<string>;
  assertPaneAccess(request: FastifyRequest, pane: Pane): Promise<void>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** Where uploads are staged and stored (the artifact root). */
  artifactRoot: string;
  /** The Studio's source upload cap (config.videoSourceMaxBytes; nginx allows 500 MB). */
  sourceMaxBytes: number;
}

const paneIdSchema = z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/);
const paneParamsSchema = z.object({ id: paneIdSchema });
const requestParamsSchema = z.object({ id: paneIdSchema, requestId: videoRequestIdSchema }).strict();
const assetParamsSchema = z.object({ id: paneIdSchema, assetId: videoAssetIdSchema }).strict();
const jobParamsSchema = z.object({ id: paneIdSchema, jobId: videoJobIdSchema }).strict();
const fileParamsSchema = z.object({ id: paneIdSchema, artifactId: z.string().regex(/^artifact:[A-Za-z0-9_-]{6,80}$/) }).strict();
const MUSIC_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** What a video shows and says; the agent routes require it on every output and upload. */
export const videoDescriptionSchema = z.string().trim().min(1).max(VIDEO_ASSET_DESCRIPTION_MAX);
const OPERATOR_MADE_BY: DesignAssetMadeBy = { by: "OPERATOR", runtimeId: null, model: null };
export const videoAssetQuerySchema = z.object({
  formatId: videoFormatRefSchema.optional(),
  kind: z.enum(VIDEO_ASSET_KINDS).optional(),
  requestId: videoRequestIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200)
}).strict();
export const videoMusicSearchSchema = z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).optional() }).strict();
export const videoMusicFetchSchema = z.object({ url: z.string().url().max(2000).refine((url) => url.startsWith("https://"), "Only https."), title: z.string().trim().max(200).optional(), artist: z.string().trim().max(200).optional(),
  attribution: z.string().trim().min(1).max(1000) }).strict();
const deliverBodySchema = z.object({ assetIds: z.array(videoAssetIdSchema).max(32).optional(), message: z.string().trim().max(2000).nullable().optional() }).strict();
const assetQuery = (filter: z.infer<typeof videoAssetQuerySchema>) => ({ formatId: filter.formatId, kinds: filter.kind ? [filter.kind] : undefined, requestId: filter.requestId, limit: filter.limit });

/** Operator routes of the Video pane: settings and view, sources, the library, requests, jobs and music. */
export function registerVideoRoutes(app: FastifyInstance, service: VideoService, deps: VideoRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;

  async function paneOf(request: FastifyRequest): Promise<{ owner: string; pane: Pane }> {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(paneParamsSchema, request.params);
    const pane = await deps.store.getPane(params.id);
    await deps.assertPaneAccess(request, pane);
    if (pane.mode !== "VIDEO") throw new SpaceConflictError("This belongs to a Video pane.");
    return { owner, pane };
  }

  app.get("/api/video/formats", routeOptions, async (request) => {
    await deps.authenticatedOwner(request);
    return { formats: service.formats() };
  });
  app.get("/api/panes/:id/video/settings", routeOptions, async (request) => {
    const { pane } = await paneOf(request);
    return { metadata: service.metadata(pane) };
  });
  app.put("/api/panes/:id/video/settings", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const metadata = await service.updateSettings(owner, pane, parseBody(videoPaneMetadataSchema, request.body ?? {}));
    await deps.audit(request, "video.settings.update", pane.id, { requestAutonomy: metadata.settings.requestAutonomy, paused: metadata.settings.paused, technique: metadata.settings.technique });
    return { metadata };
  });
  app.put("/api/panes/:id/video/view", routeOptions, async (request) => {
    const { pane } = await paneOf(request);
    const input = parseBody(z.object({
      tab: z.enum(VIDEO_TABS).nullable().default(null), requestId: videoRequestIdSchema.nullable().default(null),
      assetId: videoAssetIdSchema.nullable().default(null), sourceArtifactId: z.string().regex(/^artifact:[A-Za-z0-9_-]{6,80}$/).nullable().default(null)
    }).strict(), request.body ?? {});
    return { view: await service.updateView(pane, input) };
  });
  // The pinned tools' status (Setup tab, `space-admin-action video-tools-status`): what is installed under the tools dir, never a path to install.
  app.get("/api/video/tools", routeOptions, async (request) => {
    await deps.authenticatedOwner(request);
    return { tools: await service.toolsStatus() };
  });

  // ---- sources ----------------------------------------------------------------------------------
  // A video the operator drops into the Studio (or an audio track): stored as Media of the pane's room, typed by its bytes.
  app.post("/api/panes/:id/video/sources", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const fields: Record<string, string> = {};
    const added = await withStagedUploads(request, deps.artifactRoot, { maxFiles: 1, fileBytes: deps.sourceMaxBytes, fields: 4, onField: (name, value) => { if (typeof value === "string") fields[name] = value; } },
      async (uploads) => {
        const input = parseBody(z.object({ label: z.string().trim().min(1).max(200).optional(), description: videoDescriptionSchema.optional(), requestId: videoRequestIdSchema.optional() }).strict(), fields);
        return service.addSource(owner, pane, { path: uploads[0]!.sourcePath, filename: uploads[0]!.filename, kind: "UPLOAD", label: input.label ?? null, description: input.description ?? null, madeBy: OPERATOR_MADE_BY, requestId: input.requestId ?? null });
      });
    await deps.audit(request, "video.source.upload", added.asset.id, { mimeType: added.asset.mimeType, bytes: added.asset.durationSec });
    return added;
  });

  // ---- the library ------------------------------------------------------------------------------
  app.get("/api/panes/:id/video/assets", routeOptions, async (request) => {
    const { owner } = await paneOf(request);
    return { assets: await service.listAssets(owner, assetQuery(parseQuery(videoAssetQuerySchema, request.query ?? {}))) };
  });
  app.delete("/api/panes/:id/video/assets/:assetId", routeOptions, async (request) => {
    const params = parseQuery(assetParamsSchema, request.params);
    const { owner } = await paneOf(request);
    await service.deleteAsset(owner, params.assetId);
    await deps.audit(request, "video.asset.delete", params.assetId);
    return { deleted: true };
  });

  // Any video or audio file the Studio shows (a source, an output, a room Media file), named by its artifact.
  app.post("/api/panes/:id/video/files/:artifactId/agent-file", routeOptions, async (request) => {
    const params = parseQuery(fileParamsSchema, request.params);
    const { owner, pane } = await paneOf(request);
    const saved = await service.saveToAgentFiles(owner, pane, params.artifactId);
    await deps.audit(request, "video.file.agent_file", params.artifactId, { agentFileId: saved.artifact.id, folder: saved.folder, alreadyThere: saved.alreadyThere });
    return saved;
  });
  app.delete("/api/panes/:id/video/files/:artifactId", routeOptions, async (request) => {
    const params = parseQuery(fileParamsSchema, request.params);
    const { owner, pane } = await paneOf(request);
    const deleted = await service.deleteFile(owner, pane, params.artifactId);
    await deps.audit(request, "video.file.delete", params.artifactId, deleted);
    return { deleted: true, ...deleted };
  });

  // ---- music ------------------------------------------------------------------------------------
  app.post("/api/panes/:id/video/music/search", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    return service.musicSearch(owner, pane, parseBody(videoMusicSearchSchema, request.body ?? {}));
  });
  app.post("/api/panes/:id/video/music/fetch", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const fetched = await service.musicFetch(owner, pane, { ...parseBody(videoMusicFetchSchema, request.body ?? {}), madeBy: OPERATOR_MADE_BY });
    await deps.audit(request, "video.music.fetch", (fetched.asset as { id?: string })?.id ?? null);
    return fetched;
  });
  // A track from the operator's own library (MP3 or WAV): its credits are whatever they say.
  app.post("/api/panes/:id/video/music", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const fields: Record<string, string> = {};
    const added = await withStagedUploads(request, deps.artifactRoot, { maxFiles: 1, fileBytes: MUSIC_UPLOAD_MAX_BYTES, fields: 4, onField: (name, value) => { if (typeof value === "string") fields[name] = value; } },
      async (uploads) => {
        const input = parseBody(z.object({ label: z.string().trim().min(1).max(200).optional(), credits: z.string().trim().max(1000).optional() }).strict(), fields);
        return service.addSource(owner, pane, { path: uploads[0]!.sourcePath, filename: uploads[0]!.filename, kind: "MUSIC", label: input.label ?? null, description: input.label ?? uploads[0]!.filename, credits: input.credits ?? null, madeBy: OPERATOR_MADE_BY });
      });
    await deps.audit(request, "video.music.upload", added.asset.id, { mimeType: added.asset.mimeType });
    return added;
  });

  // ---- jobs -------------------------------------------------------------------------------------
  app.get("/api/panes/:id/video/jobs/:jobId", routeOptions, async (request) => {
    const params = parseQuery(jobParamsSchema, request.params);
    const { owner } = await paneOf(request);
    return { job: service.job(owner, params.jobId) };
  });

  // ---- requests ---------------------------------------------------------------------------------
  app.get("/api/panes/:id/video/requests", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const query = parseQuery(z.object({ status: z.enum(VIDEO_REQUEST_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict(), request.query ?? {});
    // This pane's requests and the ones no Video pane has taken yet.
    const requests = (await service.listRequests(owner, { status: query.status ? [query.status] : undefined, limit: query.limit }))
      .filter((entry) => entry.videoPaneId === pane.id || entry.videoPaneId === null);
    return { requests };
  });
  // The Studio's "Make": the operator's own request for this pane, worked by its editor.
  app.post("/api/panes/:id/video/requests", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const input = parseBody(videoRequestCreateSchema, request.body ?? {});
    const created = await service.createRequest(owner, { kind: "OPERATOR", roomId: pane.roomId, label: "You" }, { ...input, videoPaneId: input.videoPaneId ?? pane.id });
    await deps.audit(request, "video.request.create", created.request.id, { formats: created.request.formatIds, sources: created.request.sources.length });
    return created;
  });
  app.get("/api/panes/:id/video/requests/:requestId", routeOptions, async (request) => {
    const params = parseQuery(requestParamsSchema, request.params);
    const { owner } = await paneOf(request);
    return { ...(await service.request(owner, params.requestId)), events: await service.events(owner, { requestId: params.requestId, limit: 100 }) };
  });
  for (const action of ["approve", "deliver"] as const) {
    app.post(`/api/panes/:id/video/requests/:requestId/${action}`, routeOptions, async (request) => {
      const params = parseQuery(requestParamsSchema, request.params);
      const { owner } = await paneOf(request);
      const delivered = await service.approve(owner, params.requestId, parseBody(deliverBodySchema, request.body ?? {}));
      await deps.audit(request, `video.request.${action}`, params.requestId, { assets: delivered.assets.length });
      return delivered;
    });
  }
  app.post("/api/panes/:id/video/requests/:requestId/cancel", routeOptions, async (request) => {
    const params = parseQuery(requestParamsSchema, request.params);
    const { owner } = await paneOf(request);
    const cancelled = await service.cancel(owner, params.requestId, "you");
    await deps.audit(request, "video.request.cancel", params.requestId);
    return cancelled;
  });
  app.post("/api/panes/:id/video/requests/:requestId/answer", routeOptions, async (request) => {
    const params = parseQuery(requestParamsSchema, request.params);
    const { owner, pane } = await paneOf(request);
    const answered = await service.answer(owner, params.requestId, parseBody(z.object({ answer: z.string().trim().min(1).max(2000) }).strict(), request.body ?? {}).answer);
    await deps.audit(request, "video.request.answer", params.requestId);
    void service.autostart(owner, pane);
    return answered;
  });
  app.get("/api/panes/:id/video/events", routeOptions, async (request) => {
    const { owner, pane } = await paneOf(request);
    const query = parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).strict(), request.query ?? {});
    return { events: await service.events(owner, { paneId: pane.id, limit: query.limit }) };
  });

  // ---- the YouTube pane's Download -----------------------------------------------------------------
  // The video on screen at full resolution into the Video library (a source for the Video pane); the server builds the URL from the id.
  async function youtubePaneOf(request: FastifyRequest): Promise<{ owner: string; pane: Pane }> {
    const owner = await deps.authenticatedOwner(request);
    const pane = await deps.store.getPane(parseQuery(paneParamsSchema, request.params).id);
    await deps.assertPaneAccess(request, pane);
    if (pane.mode !== "YOUTUBE") throw new SpaceConflictError("Downloading a video requires a YouTube pane.");
    return { owner, pane };
  }
  app.post("/api/panes/:id/youtube/download", routeOptions, async (request) => {
    const { owner, pane } = await youtubePaneOf(request);
    const input = parseBody(z.object({ videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/), title: z.string().trim().max(200).optional(), rightsConfirmed: z.literal(true) }).strict(), request.body ?? {});
    // Settings → YouTube pane: the Agent Files folder and the resolution (defaults: MEDIA/YouTube, the best YouTube has).
    const settings = youtubeDownloadSettingsSchema.parse((await deps.store.getUserSettings(owner)).youtubeDownload ?? {});
    const job = await service.download(owner, pane, { videoId: input.videoId, title: input.title || `YouTube ${input.videoId}`, madeBy: OPERATOR_MADE_BY, ...settings });
    await deps.audit(request, "video.youtube.download", pane.id, { videoId: input.videoId, jobId: job.id });
    return { job };
  });
  app.get("/api/panes/:id/youtube/download/:jobId", routeOptions, async (request) => {
    const params = parseQuery(jobParamsSchema, request.params);
    const { owner } = await youtubePaneOf(request);
    // Answers when the download ends or after 20 s, so the pane asks again without polling every few seconds.
    return { job: await service.waitJob(owner, params.jobId, 20_000) };
  });

  // A request from another pane the operator works in (Marketing Copilot's "Make video", the Live pane), routed to their Video pane.
  app.post("/api/video/requests", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(videoRequestCreateSchema.extend({ fromPaneId: paneIdSchema }).strict(), request.body ?? {});
    const { fromPaneId, ...create } = input;
    const from = await deps.store.getPane(fromPaneId);
    await deps.assertPaneAccess(request, from);
    const created = await service.createRequest(owner, { kind: "OPERATOR", paneId: from.id, roomId: from.roomId, label: `You, from ${from.title}`.slice(0, 120) }, create);
    await deps.audit(request, "video.request.create", created.request.id, { fromPaneId: from.id, formats: created.request.formatIds, callback: created.request.callback?.kind ?? null });
    return created;
  });
}
