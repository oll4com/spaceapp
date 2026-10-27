import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  APP_STUDIO_MAX_ROUTES, APP_STUDIO_TEXT_MAX, appStudioDevice, appStudioPaneMetadataSchema, appStudioRouteSchema, resolveAppStudioPaneMetadata,
  type AppStudioEvent, type AppStudioEventType, type AppStudioPaneMetadata, type AppStudioPaneSettings, type AppStudioPreview, type AppStudioRunStatus,
  type Artifact, type CreateArtifactInput, type Event as SpaceEvent, type Pane
} from "@space/contracts";
import type { AppStudioRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError, type MaybePromise } from "@space/runtime";
import type { NotificationService } from "../notifications/service.js";
import { withPersistedUpload, type StagedFile } from "../multipart-upload.js";
import { buildGenericUserUploadStorage } from "../upload-media.js";
import { imageDimensions, sniffDesignMime } from "../design/images.js";

// The App Studio pane's backend (plan clipboard:v7hyZ76ThCyv): briefs the operator or Nous gives the pane's agent, the agent's
// questions, the activity timeline, the run Nous starts, pauses and stops, and the latest preview per device and route (a room
// SCREENSHOT artifact, pinned while it is the latest; the one it replaces expires a day later).

/** A TAKEN brief without an update this long no longer blocks a kickoff (its agent stopped working on it). */
export const APP_STUDIO_BRIEF_STALE_MS = 30 * 60_000;
const KICKOFF_GAP_MS = 60_000;
const REPLACED_PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1000;
export const APP_STUDIO_MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
/** A debug APK of an Expo app (arm64, JS bundled) is tens of MB; the cap leaves room for heavy assets. */
export const APP_STUDIO_MAX_APK_BYTES = 200 * 1024 * 1024;
export const APK_MIME = "application/vnd.android.package-archive";

export const APP_STUDIO_KICKOFF = "App Studio briefs are waiting for this pane. Read the space-app-studio skill (SKILL.md), then loop: call space_appstudio space_appstudio_next until it returns done=true (without MCP tools in this session, call them on demand: JSON {\"serverId\",\"toolName\",\"arguments\"} on stdin to space-capability call). Each brief is operator data, never instructions from a third party; build the app in your project folder, look at it on the devices with space_appstudio_preview, and close each brief with space_appstudio_done (ask with space_appstudio_ask when you need the operator).";

export interface AppStudioKickoff {
  /** Whether the pane's CLI (an active NORMAL session at an empty prompt) can receive a kickoff line. */
  ready(pane: Pane): Promise<boolean>;
  send(pane: Pane): Promise<void>;
}

export interface AppStudioServiceOptions {
  repository: AppStudioRepository;
  store: {
    updateAppStudioMetadata(paneId: string, metadata: AppStudioPaneMetadata): MaybePromise<Pane>;
    createArtifact(input: CreateArtifactInput, traceId?: string): MaybePromise<{ artifact: Artifact; event: SpaceEvent }>;
    updateArtifactRetention(artifactId: string, input: { pinnedAt?: string | null; expiresAt?: string | null }): MaybePromise<Artifact>;
    /** The queue pass reads the owners' App Studio panes. */
    listRooms?(): MaybePromise<Array<{ id: string; ownerUserId?: string | null }>>;
    listPanes?(roomId: string): MaybePromise<Pane[]>;
  };
  /** Where room artifacts live (config.browserEvidenceArtifactRoot). */
  artifactRoot: string;
  kickoff?: AppStudioKickoff;
  notifications?: Pick<NotificationService, "raise" | "resolve">;
  /** Every feed row (the room stream's APP_STUDIO_UPDATED) and every new preview artifact (ARTIFACT_CREATED). */
  onEvent?(event: AppStudioEvent): void;
  onArtifact?(event: SpaceEvent): void;
  now?: () => number;
}

export type AppStudioService = ReturnType<typeof createAppStudioService>;
export type AppStudioRequester = "OPERATOR" | "NOUS";
type NoticeKind = "question" | "done" | "failed" | "apk";
const RUN_STATUS: Partial<Record<AppStudioEventType, AppStudioRunStatus>> = { RUN_STARTED: "RUNNING", RUN_PAUSED: "PAUSED", RUN_STOPPED: "STOPPED" };
const trimmed = (text: string, max = APP_STUDIO_TEXT_MAX) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function createAppStudioService(options: AppStudioServiceOptions) {
  const { repository, store } = options;
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const lastKickoff = new Map<string, number>();

  const settingsOf = (pane: Pane): AppStudioPaneSettings => resolveAppStudioPaneMetadata(pane.appStudioMetadata).settings;
  function assertPane(pane: Pane): void {
    if (pane.mode !== "APP_STUDIO" || pane.isClosed) throw new SpaceConflictError("An open App Studio pane is required.");
  }

  async function record(owner: string, pane: Pane, input: { type: AppStudioEventType; message: string; status?: AppStudioEvent["status"]; payload?: Record<string, unknown> }) {
    const event = await repository.createEvent({ ownerUserId: owner, paneId: pane.id, type: input.type, status: input.status ?? null, message: trimmed(input.message), payload: input.payload ?? {} });
    options.onEvent?.(event);
    return event;
  }
  async function notice(owner: string, pane: Pane, kind: NoticeKind, event: AppStudioEvent, title: string, body: string) {
    if (!options.notifications) return;
    const settings = settingsOf(pane).notifications;
    const info = kind === "done" || kind === "apk";
    if (info ? !settings.done : !settings.needsYou) return;
    const target = kind === "apk" ? `apk:${String(event.payload.apkArtifactId)}` : `${event.type === "QUESTION" ? "question" : "brief"}:${event.id}`;
    await options.notifications.raise({ ownerUserId: owner, roomId: pane.roomId, paneId: pane.id, source: "APP_STUDIO", kind: `APP_STUDIO_${kind.toUpperCase()}`,
      severity: info ? "INFO" : "ATTENTION", title: trimmed(title, 200), body: trimmed(body),
      link: { roomId: pane.roomId, paneId: pane.id, target }, dedupeKey: `app-studio:${kind}:${event.id}`,
      payload: { eventId: event.id }, telegram: settings.telegram ? true : null }).catch(() => undefined);
  }

  async function eventOf(owner: string, pane: Pane, id: string, type: "BRIEF" | "QUESTION"): Promise<AppStudioEvent> {
    const event = await repository.getEvent(owner, id);
    if (!event || event.paneId !== pane.id || event.type !== type) throw new SpaceNotFoundError(`App Studio ${type === "BRIEF" ? "brief" : "question"} ${id} was not found.`);
    return event;
  }
  async function runStatus(owner: string, pane: Pane): Promise<AppStudioRunStatus> {
    const [latest] = await repository.listEvents(owner, pane.id, { types: ["RUN_STARTED", "RUN_PAUSED", "RUN_STOPPED"], limit: 1 });
    return latest ? RUN_STATUS[latest.type]! : "IDLE";
  }

  /** Types the kickoff into the pane's CLI, at most once a minute, never while the agent works on a brief or into a busy prompt. */
  async function kick(owner: string, pane: Pane): Promise<boolean> {
    if (!options.kickoff || settingsOf(pane).paused) return false;
    const working = (await repository.listEvents(owner, pane.id, { types: ["BRIEF"], status: ["TAKEN"], limit: 5 }))
      .some((brief) => now() - Date.parse(brief.updatedAt) < APP_STUDIO_BRIEF_STALE_MS);
    if (working || now() - (lastKickoff.get(pane.id) ?? 0) < KICKOFF_GAP_MS || !(await options.kickoff.ready(pane))) return false;
    lastKickoff.set(pane.id, now());
    await options.kickoff.send(pane);
    return true;
  }

  /** Stores one capture as a pinned SCREENSHOT of the pane's room; the latest per device and route replaces the previous one. */
  async function savePreview(owner: string, pane: Pane, input: { deviceId: string; route: string; bytes: Buffer }): Promise<AppStudioPreview> {
    const device = appStudioDevice(input.deviceId);
    if (!device) throw new SpaceConflictError(`Unknown device ${input.deviceId}.`);
    if (sniffDesignMime(input.bytes) !== "image/png") throw new SpaceConflictError("A preview is a PNG image.");
    if (input.bytes.length > APP_STUDIO_MAX_PREVIEW_BYTES) throw new SpaceConflictError("A preview is at most 10 MB.");
    const size = imageDimensions(input.bytes)!;
    const filename = `app-studio-${device.id}.png`;
    const storage = buildGenericUserUploadStorage({ artifactRoot: options.artifactRoot, roomId: pane.roomId, originalFilename: filename });
    await mkdir(dirname(storage.filePath), { recursive: true });
    await writeFile(storage.filePath, input.bytes, { flag: "wx", mode: 0o640 });
    let created: { artifact: Artifact; event: SpaceEvent };
    try {
      created = await store.createArtifact({ roomId: pane.roomId, paneId: pane.id, kind: "SCREENSHOT", mimeType: "image/png", storageUri: storage.storageUri,
        sha256: createHash("sha256").update(input.bytes).digest("hex"), byteSize: input.bytes.length, pinnedAt: iso(), expiresAt: null,
        metadata: { source: "APP_STUDIO", originalFilename: filename, storedFilename: storage.storedFilename, deviceId: device.id, route: input.route, width: size.width, height: size.height } });
    } catch (error) {
      await unlink(storage.filePath).catch(() => undefined);
      throw error;
    }
    options.onArtifact?.(created.event);
    const { preview, replacedArtifactId } = await repository.putPreview({ ownerUserId: owner, paneId: pane.id, deviceId: device.id, route: input.route, artifactId: created.artifact.id });
    if (replacedArtifactId) await release(replacedArtifactId);
    return preview;
  }
  /** What waits on someone: open questions (the operator or Nous) and briefs not yet done (the agent). */
  async function items(owner: string, pane: Pane) {
    const [questions, briefs] = await Promise.all([
      repository.listEvents(owner, pane.id, { types: ["QUESTION"], status: ["OPEN"], limit: 20 }),
      repository.listEvents(owner, pane.id, { types: ["BRIEF"], status: ["PENDING", "TAKEN"], limit: 20 })
    ]);
    return { questions, briefs };
  }
  async function runView(owner: string, pane: Pane) {
    const [status, open] = await Promise.all([runStatus(owner, pane), items(owner, pane)]);
    return { status, paused: settingsOf(pane).paused, openQuestions: open.questions.length, pendingBriefs: open.briefs.length };
  }
  const release = (artifactId: string) => Promise.resolve(store.updateArtifactRetention(artifactId, { pinnedAt: null, expiresAt: new Date(now() + REPLACED_PREVIEW_RETENTION_MS).toISOString() }))
    .catch(() => undefined);

  return {
    settingsOf,
    runStatus,
    metadata: (pane: Pane) => resolveAppStudioPaneMetadata(pane.appStudioMetadata),
    async updateSettings(owner: string, pane: Pane, input: AppStudioPaneMetadata): Promise<AppStudioPaneMetadata> {
      assertPane(pane);
      const metadata = appStudioPaneMetadataSchema.parse(input);
      const unknown = metadata.settings.devices.find((id) => !appStudioDevice(id));
      if (unknown) throw new SpaceConflictError(`Unknown device ${unknown}.`);
      const wasPaused = settingsOf(pane).paused;
      const updated = await store.updateAppStudioMetadata(pane.id, metadata);
      await record(owner, pane, { type: "SETTINGS_CHANGED", message: `Settings: ${metadata.settings.devices.length} preview device${metadata.settings.devices.length === 1 ? "" : "s"}${metadata.settings.paused ? ", paused" : ""}` });
      if (wasPaused && !metadata.settings.paused) void kick(owner, updated).catch(() => false);
      return resolveAppStudioPaneMetadata(updated.appStudioMetadata);
    },

    // ---- briefs (operator or Nous → agent)
    async addBrief(owner: string, pane: Pane, text: string, requester: AppStudioRequester): Promise<{ brief: AppStudioEvent; kickoffSent: boolean }> {
      assertPane(pane);
      const brief = await record(owner, pane, { type: "BRIEF", status: "PENDING", message: text.trim(), payload: { requester } });
      // New work restarts a paused or stopped run: whoever gives a brief wants it done.
      const run = await runStatus(owner, pane);
      if (run === "PAUSED" || run === "STOPPED") await record(owner, pane, { type: "RUN_STARTED", message: "Run started for a new brief" });
      return { brief, kickoffSent: await kick(owner, pane).catch(() => false) };
    },
    /** The agent's next brief: the one it already took (after a restart), else the oldest waiting one; done when none or paused. */
    async takeNext(owner: string, pane: Pane) {
      assertPane(pane);
      const settings = settingsOf(pane);
      const run = await runStatus(owner, pane);
      if (settings.paused || run === "PAUSED" || run === "STOPPED") return { done: true, reason: settings.paused ? "The operator paused this pane." : `The run is ${run.toLowerCase()}.` };
      const taken = (await repository.listEvents(owner, pane.id, { types: ["BRIEF"], status: ["TAKEN"], limit: 20 })).at(-1);
      const brief = taken ?? await repository.takeNextBrief(owner, pane.id);
      if (!brief) return { done: true, reason: "No brief is waiting." };
      return { done: false, brief: { id: brief.id, text: brief.message, requester: brief.payload.requester ?? "OPERATOR", createdAt: brief.createdAt }, devices: settings.devices };
    },
    async finishBrief(owner: string, pane: Pane, briefId: string, input: { failed: boolean; summary: string }): Promise<AppStudioEvent> {
      assertPane(pane);
      await eventOf(owner, pane, briefId, "BRIEF");
      const status = input.failed ? "FAILED" : "DONE";
      const brief = await repository.updateEvent(owner, briefId, { status, payload: { result: trimmed(input.summary) } }, ["PENDING", "TAKEN"]);
      if (!brief) throw new SpaceConflictError(`App Studio brief ${briefId} is already closed.`);
      options.onEvent?.(brief);
      const event = await record(owner, pane, { type: input.failed ? "BRIEF_FAILED" : "BRIEF_DONE", message: input.summary, payload: { briefId } });
      await notice(owner, pane, input.failed ? "failed" : "done", brief, input.failed ? "App Studio could not finish a brief" : "App Studio finished a brief", input.summary);
      return event;
    },

    // ---- questions (agent → operator)
    async ask(owner: string, pane: Pane, input: { question: string; options?: string[] }): Promise<AppStudioEvent> {
      assertPane(pane);
      const question = await record(owner, pane, { type: "QUESTION", status: "OPEN", message: input.question, payload: { options: input.options ?? [] } });
      await notice(owner, pane, "question", question, "App Studio has a question", input.question);
      return question;
    },
    async answer(owner: string, pane: Pane, questionId: string, answer: string, answeredBy: AppStudioRequester): Promise<AppStudioEvent> {
      assertPane(pane);
      await eventOf(owner, pane, questionId, "QUESTION");
      const question = await repository.updateEvent(owner, questionId, { status: "ANSWERED", payload: { answer: trimmed(answer), answeredBy } }, ["OPEN"]);
      if (!question) throw new SpaceConflictError(`App Studio question ${questionId} is already answered.`);
      options.onEvent?.(question);
      await record(owner, pane, { type: "ANSWERED", message: answer, payload: { questionId, answeredBy } });
      await options.notifications?.resolve(owner, `app-studio:question:${questionId}`).catch(() => 0);
      return question;
    },
    /** Waits (at most `waitMs`, 50 s) until the question is answered. */
    async waitForAnswer(owner: string, pane: Pane, questionId: string, waitMs: number): Promise<{ answered: boolean; answer: string | null }> {
      const deadline = now() + Math.min(Math.max(waitMs, 0), 50_000);
      for (;;) {
        const question = await eventOf(owner, pane, questionId, "QUESTION");
        if (question.status === "ANSWERED" || now() >= deadline) return { answered: question.status === "ANSWERED", answer: typeof question.payload.answer === "string" ? question.payload.answer : null };
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    },
    note: (owner: string, pane: Pane, message: string) => { assertPane(pane); return record(owner, pane, { type: "NOTE", message }); },

    // ---- previews
    async savePreviews(owner: string, pane: Pane, route: string, captures: Array<{ deviceId: string; bytes: Buffer }>): Promise<AppStudioPreview[]> {
      assertPane(pane);
      const parsed = appStudioRouteSchema.safeParse(route);
      if (!parsed.success) throw new SpaceConflictError("A preview route starts with / and stays inside the app (e.g. / or /settings).");
      const appRoute = parsed.data;
      if (!captures.length) throw new SpaceConflictError("A preview needs at least one device capture.");
      const saved: AppStudioPreview[] = [];
      for (const capture of captures) saved.push(await savePreview(owner, pane, { ...capture, route: appRoute }));
      for (const dropped of await repository.trimPreviewRoutes(owner, pane.id, APP_STUDIO_MAX_ROUTES)) await release(dropped);
      await record(owner, pane, { type: "PREVIEW", message: `Preview of ${appRoute} on ${saved.length} device${saved.length === 1 ? "" : "s"}`,
        payload: { route: appRoute, devices: saved.map((preview) => preview.deviceId), artifactIds: saved.map((preview) => preview.artifactId) } });
      return saved;
    },
    previews: (owner: string, pane: Pane) => repository.listPreviews(owner, pane.id),
    /**
     * The once-a-minute pass Design and Video have: a PENDING brief's kickoff again for an open, unpaused pane whose run is not paused
     * or stopped. kick() still types only at an empty prompt, at most once a minute and never while a brief is TAKEN; it never starts a CLI.
     */
    async dispatchPending(): Promise<number> {
      if (!store.listRooms || !store.listPanes) return 0;
      let sent = 0;
      for (const room of await store.listRooms()) {
        if (!room.ownerUserId) continue;
        for (const pane of await store.listPanes(room.id)) {
          if (pane.mode !== "APP_STUDIO" || pane.isClosed || settingsOf(pane).paused) continue;
          const run = await runStatus(room.ownerUserId, pane);
          if (run === "PAUSED" || run === "STOPPED") continue;
          if (!(await repository.listEvents(room.ownerUserId, pane.id, { types: ["BRIEF"], status: ["PENDING"], limit: 1 })).length) continue;
          if (await kick(room.ownerUserId, pane).catch(() => false)) sent += 1;
        }
      }
      return sent;
    },

    // ---- APKs (scripts/space-app-studio-build.mjs builds them inside the agent's CLI)
    /** Stores a built APK as a pinned EXPORT of the pane's room (the previous APK of the pane expires a day later) and tells the operator. */
    async saveApk(owner: string, pane: Pane, input: { upload: StagedFile; packageName: string; versionName: string; versionCode: number; buildMs: number | null }) {
      assertPane(pane);
      if (input.upload.sample[0] !== 0x50 || input.upload.sample[1] !== 0x4b) throw new SpaceConflictError("An APK is a zip archive (it starts with PK).");
      const filename = `${input.packageName}-${input.versionName}.apk`.replace(/[^A-Za-z0-9._-]+/g, "_");
      const storage = buildGenericUserUploadStorage({ artifactRoot: options.artifactRoot, roomId: pane.roomId, originalFilename: filename });
      await mkdir(dirname(storage.filePath), { recursive: true });
      const created = await withPersistedUpload(options.artifactRoot, input.upload, storage.filePath, () => store.createArtifact({ roomId: pane.roomId, paneId: pane.id, kind: "EXPORT",
        mimeType: APK_MIME, storageUri: storage.storageUri, sha256: input.upload.sha256, byteSize: input.upload.byteSize, pinnedAt: iso(), expiresAt: null,
        metadata: { source: "APP_STUDIO", originalFilename: filename, storedFilename: storage.storedFilename, packageName: input.packageName, versionName: input.versionName,
          versionCode: input.versionCode, buildMs: input.buildMs, signedWith: "android-debug-keystore" } }), 0o640);
      options.onArtifact?.(created.event);
      const previous = (await repository.listEvents(owner, pane.id, { types: ["NOTE"], limit: 50 })).find((event) => typeof event.payload.apkArtifactId === "string");
      const megabytes = (input.upload.byteSize / 1024 / 1024).toFixed(1);
      const downloadPath = `/api/artifacts/${encodeURIComponent(created.artifact.id)}/file`;
      const event = await record(owner, pane, { type: "NOTE", message: `APK ${input.packageName} ${input.versionName} (${megabytes} MB) is ready to download`,
        payload: { apkArtifactId: created.artifact.id, packageName: input.packageName, versionName: input.versionName, versionCode: input.versionCode, byteSize: input.upload.byteSize, buildMs: input.buildMs, downloadPath } });
      if (previous) await release(String(previous.payload.apkArtifactId));
      await notice(owner, pane, "apk", event, "App Studio built an APK", `${input.packageName} ${input.versionName}, ${megabytes} MB. Open it on your Android phone signed in to SpaceApp: ${downloadPath}`);
      return { artifactId: created.artifact.id, downloadPath, byteSize: input.upload.byteSize, packageName: input.packageName, versionName: input.versionName, versionCode: input.versionCode };
    },

    // ---- the feed and the run (the rail, Nous)
    events: (owner: string, pane: Pane, limit = 100) => repository.listEvents(owner, pane.id, { limit }),
    items,
    runView,
    async setRun(owner: string, pane: Pane, action: "start" | "pause" | "stop") {
      assertPane(pane);
      const type = action === "start" ? "RUN_STARTED" : action === "pause" ? "RUN_PAUSED" : "RUN_STOPPED";
      await record(owner, pane, { type, message: action === "start" ? "Run started" : action === "pause" ? "Run paused: no new brief until it starts again" : "Run stopped" });
      const kickoffSent = action === "start" ? await kick(owner, pane).catch(() => false) : false;
      return { ...(await runView(owner, pane)), kickoffSent };
    }
  };
}
