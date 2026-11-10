import type {} from "../request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { APP_STUDIO_DEVICES, APP_STUDIO_TEXT_MAX, appStudioDevice, appStudioEventIdSchema, type Pane } from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import { readStagedUpload, withStagedUploads } from "../multipart-upload.js";
import { APP_STUDIO_MAX_APK_BYTES, APP_STUDIO_MAX_PREVIEW_BYTES, type AppStudioService } from "./service.js";

// Agent-facing routes of the App Studio pane, reached with the pane-scoped CLI bridge token: only the CLI session of an App
// Studio pane (space_appstudio). The preview images come from the agent's own capture inside its CLI.
export const cliAppStudioPathPrefix = "/api/cli/app-studio/";

interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface AppStudioAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** Where uploads are staged (the artifact root). */
  uploadRoot: string;
}

const idParamsSchema = z.object({ id: appStudioEventIdSchema }).strict();
const text = z.string().trim().min(1).max(APP_STUDIO_TEXT_MAX);
const apkFieldsSchema = z.object({
  packageName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/).max(200),
  versionName: z.string().trim().min(1).max(100),
  versionCode: z.coerce.number().int().min(0).max(2_100_000_000),
  buildMs: z.coerce.number().int().min(0).max(24 * 3_600_000).nullable().default(null),
  /** release: re-signed with the app's own kept Vault key (scripts/space-app-studio-build.mjs RELEASE_KEYS, Nous decision 2026-10-27). */
  signedWith: z.enum(["android-debug-keystore", "release"]).default("android-debug-keystore"),
  /** A release build is filed in Apps/Android (the Nous app's updater reads it); any other build goes to Apps/Android/Builds. Default: a test build. */
  release: z.string().optional().transform((value) => value === "true")
}).strict();

/** The installed build an emulator capture shows (fields of a preview upload with source APK). */
const apkCaptureSchema = z.object({ packageName: apkFieldsSchema.shape.packageName, versionName: z.string().trim().regex(/^[A-Za-z0-9._+-]{1,100}$/),
  versionCode: z.coerce.number().int().min(0).max(2_100_000_000).optional(), data: z.enum(["UNKNOWN", "SIGNED_OUT", "DEMO", "OPERATOR"]).default("UNKNOWN") });

export function registerAppStudioAgentRoutes(app: FastifyInstance, service: AppStudioService, deps: AppStudioAgentRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  type Bridge = { owner: string; pane: Pane };

  function handle(method: "get" | "post", path: string, handler: (bridge: Bridge, request: FastifyRequest) => Promise<unknown>) {
    app[method](`${cliAppStudioPathPrefix}${path}`, routeOptions, async (request, reply) => {
      const bridge = await deps.requireBridge(request, reply);
      if (!bridge) return reply;
      const room = await deps.store.getRoom(bridge.claims.roomId);
      if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; App Studio works in a signed-in operator's room.");
      const pane = await deps.store.getPane(bridge.claims.paneId);
      if (pane.mode !== "APP_STUDIO") throw new SpaceConflictError("App Studio tools belong to the CLI session of an App Studio pane.");
      return handler({ owner: room.ownerUserId, pane }, request);
    });
  }

  handle("get", "devices", async ({ pane }) => ({ devices: APP_STUDIO_DEVICES, selected: service.settingsOf(pane).devices }));
  handle("post", "next", async ({ owner, pane }) => service.takeNext(owner, pane));
  handle("post", "briefs/:id/done", async ({ owner, pane }, request) => {
    const { id } = parseQuery(idParamsSchema, request.params);
    // An empty previewArtifactIds passes here so the service's 409 names the item that lacks proof.
    const input = parseBody(z.object({ summary: text, failed: z.boolean().default(false), items: z.array(z.object({ item: z.string().trim().min(1).max(300),
      previewArtifactIds: z.array(z.string().regex(/^artifact:[A-Za-z0-9_-]{1,120}$/)).max(20) }).strict()).max(30).optional() }).strict(), request.body ?? {});
    const event = await service.finishBrief(owner, pane, id, input);
    await deps.audit(request, "app_studio.brief.done", id, { paneId: pane.id, failed: input.failed, items: input.items?.length ?? 0 });
    return { event };
  });
  // The build script asks before Gradle: a release build waits for proof on every brief done since the last release.
  // With the built APK's package and version (after Gradle), the check also asks for that version's install proof on the lab emulator.
  handle("post", "release-check", async ({ owner, pane }, request) => {
    const apk = parseBody(z.object({ packageName: apkFieldsSchema.shape.packageName, versionName: apkFieldsSchema.shape.versionName }).strict().partial(), request.body ?? {});
    await service.assertReleaseProven(owner, pane, apk.packageName && apk.versionName ? { packageName: apk.packageName, versionName: apk.versionName } : undefined);
    return { ok: true };
  });
  handle("post", "ask", async ({ owner, pane }, request) => {
    // R23-2 (31/10: 5 App Studio questions with options and no recommended one, unscorable): with options, name the one you recommend (as R20-13).
    const input = parseBody(z.object({ question: text, options: z.array(z.string().trim().min(1).max(200)).max(6).optional(), recommended: z.string().trim().min(1).max(200).optional() }).strict()
      .refine((value) => !value.recommended || (value.options ?? []).includes(value.recommended), { message: "recommended must be one of the options", path: ["recommended"] })
      .refine((value) => !value.options?.length || Boolean(value.recommended), { message: "with options, name the one you recommend (recommended): every question carries a prediction", path: ["recommended"] }),
    request.body ?? {});
    return { question: await service.ask(owner, pane, input) };
  });
  handle("post", "questions/:id/wait", async ({ owner, pane }, request) => {
    const { id } = parseQuery(idParamsSchema, request.params);
    return service.waitForAnswer(owner, pane, id, parseBody(z.object({ waitMs: z.number().int().min(0).max(50_000).default(30_000) }).strict(), request.body ?? {}).waitMs);
  });
  handle("post", "note", async ({ owner, pane }, request) => ({ event: await service.note(owner, pane, parseBody(z.object({ message: text }).strict(), request.body ?? {}).message) }));
  // One capture per device: each file's field name is its device id, the `route` field names the screen.
  // `source` APK with `packageName` and `versionName`: captures of the installed build on the lab emulator (space-app-studio-apk-proof.mjs).
  handle("post", "previews", async ({ owner, pane }, request) => {
    let route = "/";
    const fields: Record<string, string> = {};
    const previews = await withStagedUploads(request, deps.uploadRoot, { maxFiles: APP_STUDIO_DEVICES.length, fileBytes: APP_STUDIO_MAX_PREVIEW_BYTES, fields: 7,
      onField: (name, value) => { if (typeof value !== "string") return; if (name === "route") route = value; else fields[name] = value; } },
    async (uploads) => {
      const captures = [];
      for (const upload of uploads) {
        if (!appStudioDevice(upload.fieldname)) throw new SpaceConflictError(`Unknown device ${upload.fieldname}.`);
        captures.push({ deviceId: upload.fieldname, bytes: await readStagedUpload(deps.uploadRoot, upload) });
      }
      if (fields.source && fields.source !== "APK") throw new SpaceConflictError("A preview's source is APK (the lab emulator) or none (the web export).");
      const apk = fields.source === "APK" ? apkCaptureSchema.safeParse(fields) : null;
      if (apk && !apk.success) throw new SpaceConflictError("An APK capture names the installed build's packageName and versionName.");
      return service.savePreviews(owner, pane, route, captures, apk?.data);
    });
    await deps.audit(request, "app_studio.preview", pane.id, { route, devices: previews.map((preview) => preview.deviceId) });
    return { previews };
  });
  // The APK the agent built in its CLI (scripts/space-app-studio-build.mjs): its package and version as fields, then the file.
  // Six fields: packageName, versionName, versionCode, buildMs, signedWith and release (a release-signed release sends them all).
  handle("post", "apk", async ({ owner, pane }, request) => {
    const fields: Record<string, string> = {};
    const saved = await withStagedUploads(request, deps.uploadRoot, { maxFiles: 1, fileBytes: APP_STUDIO_MAX_APK_BYTES, fields: 6,
      onField: (name, value) => { if (typeof value === "string") fields[name] = value; } },
    async ([upload]) => {
      const info = apkFieldsSchema.safeParse(fields);
      if (!info.success) throw new SpaceConflictError("An APK upload names its packageName, versionName, versionCode and buildMs.");
      return service.saveApk(owner, pane, { upload: upload!, ...info.data });
    });
    await deps.audit(request, "app_studio.apk", saved.artifactId, { paneId: pane.id, packageName: saved.packageName, versionName: saved.versionName, byteSize: saved.byteSize });
    return saved;
  });
}
