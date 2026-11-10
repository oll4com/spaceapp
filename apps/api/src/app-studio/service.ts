import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  APP_STUDIO_MAX_ROUTES, APP_STUDIO_TEXT_MAX, appStudioDevice, appStudioPaneMetadataSchema, appStudioRouteSchema, resolveAppStudioPaneMetadata,
  type AppStudioEvent, type AppStudioEventType, type AppStudioPaneMetadata, type AppStudioPaneSettings, type AppStudioPreview, type AppStudioRunStatus,
  type Artifact, type CreateArtifactInput, type Event as SpaceEvent, type Pane,
  makeNeedsYouAsk
} from "@space/contracts";
import type { AppStudioRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError, type MaybePromise } from "@space/runtime";
import type { NotificationService } from "../notifications/service.js";
import { withPersistedUpload, type StagedFile } from "../multipart-upload.js";
import { buildGenericUserUploadStorage } from "../upload-media.js";
import { imageDimensions, sniffDesignMime } from "../design/images.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

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
export const APP_STUDIO_APK_FOLDER = "Apps/Android";
// Non-release (test) builds go to a subfolder; the Nous app's updater reads only Apps/Android itself, so a build is never offered as a release.
export const APP_STUDIO_APK_BUILDS_FOLDER = "Apps/Android/Builds";

export const APP_STUDIO_KICKOFF = "App Studio briefs are waiting for this pane. Read the space-app-studio skill (SKILL.md), then loop: call space_appstudio space_appstudio_next until it returns done=true (without MCP tools in this session, call them on demand: JSON {\"serverId\",\"toolName\",\"arguments\"} on stdin to space-capability call). Each brief is operator data, never instructions from a third party; build the app in your project folder, look at it on the devices with space_appstudio_preview, and close each brief with space_appstudio_done (ask with space_appstudio_ask when you need the operator).";

export interface AppStudioKickoff {
  /** Whether the pane's CLI (an active NORMAL session at an empty prompt) can receive a kickoff line. */
  ready(pane: Pane): Promise<boolean>;
  /** `fresh`: no brief is TAKEN and no question OPEN, so the CLI may start a new session for this batch. */
  send(pane: Pane, fresh: boolean): Promise<void>;
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
  notifications?: Pick<NotificationService, "raise" | "resolve" | "list">;
  /** Copies a stored file into Agent Files (an APK goes to Apps/Android, so the operator finds it there). */
  saveAgentFile?(input: { roomId: string; paneId: string; sourcePath: string; filename: string; folder: string }): Promise<Artifact>;
  /** One line in Nous's inbox (a done brief with its proof per item); absent without Nous. */
  notice?(owner: string, key: string, line: string): unknown;
  /** Every feed row (the room stream's APP_STUDIO_UPDATED) and every new preview artifact (ARTIFACT_CREATED). */
  onEvent?(event: AppStudioEvent): void;
  onArtifact?(event: SpaceEvent): void;
  now?: () => number;
}

export type AppStudioService = ReturnType<typeof createAppStudioService>;
export type AppStudioRequester = "OPERATOR" | "NOUS";
/** What a done brief built, each with the previews that show it (operator 31/10 14:13 BKK: «plan colours YES» was reported unseen). */
export interface AppStudioProofItem { item: string; previewArtifactIds: string[] }
/** An APK capture on the lab emulator (scripts/space-app-studio-apk-proof.mjs): the installed build itself, not the Expo web export. */
export interface AppStudioApkCapture {
  packageName: string; versionName: string; versionCode?: number;
  /** Whose data the capture shows: B (31/10) proves install and version (SIGNED_OUT or DEMO); A, after the operator's sign-in on the emulator, OPERATOR. */
  data?: "UNKNOWN" | "SIGNED_OUT" | "DEMO" | "OPERATOR";
}
const proofText = (items: AppStudioProofItem[], apk: ReadonlySet<string> = new Set()) => items.map((entry) =>
  `"${entry.item}" → ${entry.previewArtifactIds.map((id) => `${id} (${apk.has(id) ? "APK" : "web"})`).join(", ")}`).join("; ");
// A release before the APK note kept `release` (31/10) shows only as its release signing.
const isReleaseNote = (payload: Record<string, unknown>) => typeof payload.apkArtifactId === "string" && ("release" in payload ? payload.release === true : payload.signedWith === "release");
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
    const event = await repository.createEvent({ ownerUserId: owner, paneId: pane.id, type: input.type, status: input.status ?? null, message: input.message, payload: input.payload ?? {} });
    options.onEvent?.(event);
    return event;
  }
  async function notice(owner: string, pane: Pane, kind: NoticeKind, event: AppStudioEvent, title: string, body: string) {
    if (!options.notifications) return;
    const settings = settingsOf(pane).notifications;
    const info = kind === "done" || kind === "apk";
    if (info ? !settings.done : !settings.needsYou) return;
    const target = kind === "apk" ? `apk:${String(event.payload.apkArtifactId)}` : `${event.type === "QUESTION" ? "question" : "brief"}:${event.id}`;
    // Operator 31/10 17:31 BKK (12 stale briefs closed FAILED in 3 minutes = 12 pop-ups): failures fold into one card per pane, alerted once;
    // the newest failure refreshes it with how many briefs failed since it was raised.
    const [folded] = kind === "failed" ? await options.notifications.list(owner, { status: "WAITING", dedupeKey: `app-studio:failed:${pane.id}`, limit: 1 }).catch(() => []) : [];
    const earlier = folded?.payload.failedBriefs;
    const failedBriefs = kind === "failed" ? [...(Array.isArray(earlier) ? earlier.map(String) : []), event.id] : [];
    const many = failedBriefs.length > 1 ? failedBriefs.length : 0;
    await options.notifications.raise({ ownerUserId: owner, roomId: pane.roomId, paneId: pane.id, source: "APP_STUDIO", kind: `APP_STUDIO_${kind.toUpperCase()}`,
      severity: info ? "INFO" : "ATTENTION", title: trimmed(many ? `App Studio could not finish ${many} briefs` : title, 200),
      body: trimmed(many ? `${many} briefs failed since this card was raised; the newest: ${body}` : body),
      link: { roomId: pane.roomId, paneId: pane.id, target }, dedupeKey: kind === "failed" ? `app-studio:failed:${pane.id}` : `app-studio:${kind}:${event.id}`,
      payload: { eventId: event.id, ...(kind === "failed" ? { failedBriefs } : {}), ...(kind === "question" ? { ask: makeNeedsYouAsk(body, { kind: "COPILOT_QUESTION", copilot: "APP_STUDIO", questionId: event.id },
        Array.isArray(event.payload.options) ? event.payload.options.map(String) : [], typeof event.payload.recommended === "string" ? event.payload.recommended : null) } : {}) }, telegram: settings.telegram ? true : null }).catch(() => undefined);
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

  /**
   * Types the kickoff into the pane's CLI, at most once a minute, only at an empty prompt: that, not a TAKEN brief's age, keeps it out of
   * the agent's turn (31/10: a parked TAKEN brief held Alex/Emma's waiting briefs).
   */
  async function kick(owner: string, pane: Pane): Promise<boolean> {
    if (!options.kickoff || settingsOf(pane).paused) return false;
    if (now() - (lastKickoff.get(pane.id) ?? 0) < KICKOFF_GAP_MS || !(await options.kickoff.ready(pane))) return false;
    lastKickoff.set(pane.id, now());
    const open = await items(owner, pane);
    await options.kickoff.send(pane, !open.questions.length && !open.briefs.some((brief) => brief.status === "TAKEN"));
    return true;
  }

  /** Stores one capture as a pinned SCREENSHOT of the pane's room; the latest per device and route replaces the previous one. */
  async function savePreview(owner: string, pane: Pane, input: { deviceId: string; route: string; bytes: Buffer; apk?: AppStudioApkCapture }): Promise<AppStudioPreview> {
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
        metadata: { source: "APP_STUDIO", originalFilename: filename, storedFilename: storage.storedFilename, deviceId: device.id, route: input.route, width: size.width, height: size.height,
          capturedFrom: input.apk ? "APK" : "WEB", ...(input.apk ?? {}) } });
    } catch (error) {
      await unlink(storage.filePath).catch(() => undefined);
      throw error;
    }
    options.onArtifact?.(created.event);
    const { preview, replacedArtifactId } = await repository.putPreview({ ownerUserId: owner, paneId: pane.id, deviceId: device.id, route: input.route, artifactId: created.artifact.id });
    if (replacedArtifactId) await release(replacedArtifactId);
    return preview;
  }
  /**
   * Why a brief cannot be DONE with these items: each item needs at least one of this pane's current previews captured after the
   * brief was TAKEN (`payload.takenAt`; a brief taken before it was kept, or never taken, counts from its last change). Null: proven.
   */
  async function proofProblem(owner: string, pane: Pane, brief: AppStudioEvent, items: AppStudioProofItem[] | undefined): Promise<string | null> {
    const how = "capture each changed screen with space_appstudio_preview, look at the PNGs, then call space_appstudio_done again with items [{item, previewArtifactIds}].";
    if (!items?.length) return `A brief is done only with proof: name each thing it asked for with the preview ids that show it; ${how}`;
    const takenAt = typeof brief.payload.takenAt === "string" ? brief.payload.takenAt : brief.updatedAt;
    const previews = new Map((await repository.listPreviews(owner, pane.id)).map((preview) => [preview.artifactId, preview]));
    for (const entry of items) {
      if (!entry.previewArtifactIds.length) return `"${entry.item}" has no preview; ${how}`;
      for (const id of entry.previewArtifactIds) {
        const preview = previews.get(id);
        if (!preview) return `"${entry.item}": ${id} is not one of this pane's current previews (a newer capture of the same phone and screen replaces it); ${how}`;
        if (Date.parse(preview.capturedAt) < Date.parse(takenAt)) return `"${entry.item}": ${id} was captured ${preview.capturedAt}, before this brief was taken (${takenAt}), so it cannot show the change; ${how}`;
      }
    }
    return null;
  }
  /** Briefs DONE since the pane's last release APK that carry no proof (closed before the gate, 31/10); none means a release may build. */
  async function unprovenBriefs(owner: string, pane: Pane): Promise<Array<{ briefId: string; text: string; doneAt: string }>> {
    const [notes, done] = await Promise.all([repository.listEvents(owner, pane.id, { types: ["NOTE"] }),
      repository.listEvents(owner, pane.id, { types: ["BRIEF"], status: ["DONE"] })]);
    const since = notes.find((note) => isReleaseNote(note.payload))?.createdAt ?? "";
    return done.filter((brief) => brief.updatedAt > since && !(Array.isArray(brief.payload.items) && brief.payload.items.length))
      .map((brief) => ({ briefId: brief.id, text: trimmed(brief.message, 120), doneAt: brief.updatedAt }));
  }
  const releaseRefusal = (unproven: Awaited<ReturnType<typeof unprovenBriefs>>) => `A release build needs proof for every brief done since the last release; `
    + `${unproven.length} ha${unproven.length === 1 ? "s" : "ve"} none: ${unproven.map((brief) => `${brief.briefId} "${brief.text}"`).join("; ")}. For each, capture its screens with `
    + "space_appstudio_preview, look at them, and call space_appstudio_done {briefId, summary, items} again; or build a test build (release false).";
  /**
   * Nous decision 31/10 (B, plan clipboard:VWt5sAXmYwgI): a release needs that exact build installed and opened on the lab emulator, an APK
   * preview of the package and version (space-app-studio-apk-proof.mjs). A (the operator's data) plugs in by also asking `data` OPERATOR here.
   */
  async function apkProven(owner: string, pane: Pane, packageName: string, versionName: string): Promise<boolean> {
    return (await repository.listEvents(owner, pane.id, { types: ["PREVIEW"] }))
      .some((event) => event.payload.source === "APK" && event.payload.packageName === packageName && event.payload.versionName === versionName);
  }
  const apkRefusal = (packageName: string, versionName: string) => `A release of ${packageName} ${versionName} needs that version installed and opened on the lab `
    + `emulator first: node ${SPACE_INSTALL_ROOT}/scripts/space-app-studio-apk-proof.mjs <app dir> --routes / (it builds the same source for x86_64, installs it, `
    + "checks the installed version and files the capture as an APK preview). Nothing was released.";
  /** What waits on someone: open questions (the operator or Nous) and briefs not yet done (the agent). */
  async function items(owner: string, pane: Pane) {
    const [questions, briefs] = await Promise.all([
      repository.listEvents(owner, pane.id, { types: ["QUESTION"], status: ["OPEN"] }),
      repository.listEvents(owner, pane.id, { types: ["BRIEF"], status: ["PENDING", "TAKEN"] })
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
    /** The agent's next brief: the oldest waiting one, else the one it already took (after a restart); done when none or paused. */
    async takeNext(owner: string, pane: Pane) {
      assertPane(pane);
      const settings = settingsOf(pane);
      const run = await runStatus(owner, pane);
      if (settings.paused || run === "PAUSED" || run === "STOPPED") return { done: true, reason: settings.paused ? "The operator paused this pane." : `The run is ${run.toLowerCase()}.` };
      // The oldest PENDING brief first, else the one the agent took (touched when it rested 30 minutes, a restart): a TAKEN brief never hides
      // waiting ones (2/11 Cleo/Iris: a brief worked on for hours came back first once 30 minutes untouched, 7 PENDING briefs waited 4 hours).
      const fresh = await repository.takeNextBrief(owner, pane.id);
      // When it was taken, kept apart from updatedAt (serving a resumed brief touches it): the done gate's proof is captured after it.
      const stamped = fresh ? await repository.updateEvent(owner, fresh.id, { status: "TAKEN", payload: { takenAt: fresh.updatedAt } }, ["TAKEN"]) : null;
      const taken = fresh ? undefined : (await repository.listEvents(owner, pane.id, { types: ["BRIEF"], status: ["TAKEN"] })).at(-1);
      const resumed = taken && now() - Date.parse(taken.updatedAt) >= APP_STUDIO_BRIEF_STALE_MS ? await repository.updateEvent(owner, taken.id, { status: "TAKEN" }, ["TAKEN"]) : null;
      const brief = stamped ?? fresh ?? resumed ?? taken;
      if (!brief) return { done: true, reason: "No brief is waiting." };
      return { done: false, brief: { id: brief.id, text: brief.message, requester: brief.payload.requester ?? "OPERATOR", createdAt: brief.createdAt }, devices: settings.devices };
    },
    /**
     * Closes a brief. DONE needs proof per item (operator 31/10 14:13 BKK); a brief DONE before the gate takes its proof later the same
     * way, so a release can build (`unprovenBriefs`). FAILED needs none.
     */
    async finishBrief(owner: string, pane: Pane, briefId: string, input: { failed: boolean; summary: string; items?: AppStudioProofItem[] }): Promise<AppStudioEvent> {
      assertPane(pane);
      const current = await eventOf(owner, pane, briefId, "BRIEF");
      const items = input.failed ? undefined : input.items;
      if (!input.failed) {
        const problem = await proofProblem(owner, pane, current, items);
        if (problem) throw new SpaceConflictError(`App Studio brief ${briefId} is not done: ${problem}`);
      }
      const proven = current.status === "DONE" && !input.failed && !Array.isArray(current.payload.items);
      const status = input.failed ? "FAILED" : "DONE";
      const brief = await repository.updateEvent(owner, briefId, { status, payload: { ...(proven ? {} : { result: trimmed(input.summary) }), ...(items ? { items } : {}) } },
        proven ? ["DONE"] : ["PENDING", "TAKEN"]);
      if (!brief) throw new SpaceConflictError(`App Studio brief ${briefId} is already closed.`);
      options.onEvent?.(brief);
      if (proven) return record(owner, pane, { type: "NOTE", message: `Proof added to brief ${briefId}: ${proofText(items!)}`, payload: { briefId, items } });
      const event = await record(owner, pane, { type: input.failed ? "BRIEF_FAILED" : "BRIEF_DONE", message: input.summary, payload: { briefId, ...(items ? { items } : {}) } });
      const proof = items ? `\nProof (previews): ${proofText(items)}` : "";
      await notice(owner, pane, input.failed ? "failed" : "done", brief, input.failed ? "App Studio could not finish a brief" : "App Studio finished a brief", `${input.summary}${proof}`);
      if (items) {
        // RCA 31/10 16:13 BKK («Όλες αυτές οι φωτογραφίες είναι από το web app»): web captures were relayed as proof of the installed app.
        const apk = new Set((await repository.listEvents(owner, pane.id, { types: ["PREVIEW"] })).filter((event) => event.payload.source === "APK")
          .flatMap((event) => Array.isArray(event.payload.artifactIds) ? event.payload.artifactIds.map(String) : []));
        const webOnly = items.filter((entry) => !entry.previewArtifactIds.some((id) => apk.has(id))).map((entry) => `"${entry.item}"`);
        await Promise.resolve(options.notice?.(owner, `app-studio-done:${briefId}`, `App Studio ${pane.paneName ?? pane.title} (${pane.id}) finished brief ${briefId}: `
          + `${trimmed(input.summary.replace(/\s+/g, " "), 300)} Proof per item: ${proofText(items, apk)}. Open them with space_look {artifactId}. `
          + (webOnly.length ? `${webOnly.join(", ")} ${webOnly.length === 1 ? "has" : "have"} only web captures (the app's Expo web export with the pane's data), never the APK on his phone: `
            + `say exactly that, or have the pane capture the installed build on the lab emulator (node ${SPACE_INSTALL_ROOT}/scripts/space-app-studio-apk-proof.mjs) before you tell the operator it is in a build.`
            : "Each item has a capture of the APK itself on the lab emulator; check that it shows the operator's data (signed in, or his real-data snapshot) before you tell him."))).catch(() => undefined);
      }
      return event;
    },
    /** Refuses a release build while a brief done since the last release has no proof (the build script asks before Gradle). */
    async assertReleaseProven(owner: string, pane: Pane, apk?: { packageName: string; versionName: string }): Promise<void> {
      assertPane(pane);
      const unproven = await unprovenBriefs(owner, pane);
      if (unproven.length) throw new SpaceConflictError(releaseRefusal(unproven));
      if (apk && !(await apkProven(owner, pane, apk.packageName, apk.versionName))) throw new SpaceConflictError(apkRefusal(apk.packageName, apk.versionName));
    },

    // ---- questions (agent → operator)
    async ask(owner: string, pane: Pane, input: { question: string; options?: string[]; recommended?: string }): Promise<AppStudioEvent> {
      assertPane(pane);
      const question = await record(owner, pane, { type: "QUESTION", status: "OPEN", message: input.question,
        payload: { options: input.options ?? [], ...(input.recommended ? { recommended: input.recommended } : {}) } });
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
    async savePreviews(owner: string, pane: Pane, route: string, captures: Array<{ deviceId: string; bytes: Buffer }>, apk?: AppStudioApkCapture): Promise<AppStudioPreview[]> {
      assertPane(pane);
      const parsed = appStudioRouteSchema.safeParse(route);
      if (!parsed.success) throw new SpaceConflictError("A preview route starts with / and stays inside the app (e.g. / or /settings).");
      const appRoute = parsed.data;
      if (!captures.length) throw new SpaceConflictError("A preview needs at least one device capture.");
      const saved: AppStudioPreview[] = [];
      for (const capture of captures) saved.push(await savePreview(owner, pane, { ...capture, route: appRoute, ...(apk ? { apk } : {}) }));
      for (const dropped of await repository.trimPreviewRoutes(owner, pane.id, APP_STUDIO_MAX_ROUTES)) await release(dropped);
      await record(owner, pane, { type: "PREVIEW", message: `Preview of ${appRoute} on ${saved.length} device${saved.length === 1 ? "" : "s"}${apk ? ` (APK ${apk.packageName} ${apk.versionName} on the lab emulator)` : ""}`,
        payload: { route: appRoute, devices: saved.map((preview) => preview.deviceId), artifactIds: saved.map((preview) => preview.artifactId), ...(apk ? { source: "APK", ...apk } : {}) } });
      return saved;
    },
    previews: (owner: string, pane: Pane) => repository.listPreviews(owner, pane.id),
    /**
     * The once-a-minute pass Design and Video have: a PENDING brief's kickoff again for an open, unpaused pane whose run is not paused
     * or stopped. kick() still types only at an empty prompt, at most once a minute; it never starts a CLI.
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
    async saveApk(owner: string, pane: Pane, input: { upload: StagedFile; packageName: string; versionName: string; versionCode: number; buildMs: number | null;
      signedWith?: "android-debug-keystore" | "release"; release?: boolean }) {
      assertPane(pane);
      if (input.upload.sample[0] !== 0x50 || input.upload.sample[1] !== 0x4b) throw new SpaceConflictError("An APK is a zip archive (it starts with PK).");
      const unproven = await unprovenBriefs(owner, pane);
      if (input.release && unproven.length) throw new SpaceConflictError(releaseRefusal(unproven));
      if (input.release && !(await apkProven(owner, pane, input.packageName, input.versionName))) throw new SpaceConflictError(apkRefusal(input.packageName, input.versionName));
      const filename = `${input.packageName}-${input.versionName}.apk`.replace(/[^A-Za-z0-9._-]+/g, "_");
      const storage = buildGenericUserUploadStorage({ artifactRoot: options.artifactRoot, roomId: pane.roomId, originalFilename: filename });
      await mkdir(dirname(storage.filePath), { recursive: true });
      const created = await withPersistedUpload(options.artifactRoot, input.upload, storage.filePath, () => store.createArtifact({ roomId: pane.roomId, paneId: pane.id, kind: "EXPORT",
        mimeType: APK_MIME, storageUri: storage.storageUri, sha256: input.upload.sha256, byteSize: input.upload.byteSize, pinnedAt: iso(), expiresAt: null,
        metadata: { source: "APP_STUDIO", originalFilename: filename, storedFilename: storage.storedFilename, packageName: input.packageName, versionName: input.versionName,
          versionCode: input.versionCode, buildMs: input.buildMs, signedWith: input.signedWith ?? "android-debug-keystore" } }), 0o640);
      options.onArtifact?.(created.event);
      // The operator's copy in Agent Files (operator 30/10: never only a Media link); a failed copy is said, the build stays.
      const app = input.packageName.split(".").at(-1)!;
      const agentFileName = `${app[0]!.toUpperCase()}${app.slice(1)}-Android-${input.versionName}.apk`.replace(/[^A-Za-z0-9._-]+/g, "_");
      // Only a release the agent marks goes to Apps/Android, which the Nous app's updater reads; any other build goes to the Builds subfolder it ignores (space_memory:b5146b7c).
      const folder = input.release ? APP_STUDIO_APK_FOLDER : APP_STUDIO_APK_BUILDS_FOLDER;
      const agentFile = options.saveAgentFile ? await options.saveAgentFile({ roomId: pane.roomId, paneId: pane.id, sourcePath: storage.filePath, filename: agentFileName, folder })
        .catch((error: unknown) => ({ failed: error instanceof Error ? error.message : String(error) })) : null;
      const agentFileId = agentFile && "id" in agentFile ? agentFile.id : null;
      const where = input.release ? "Apps / Android" : "Apps / Android / Builds";
      const filed = agentFileId ? ` In Agent Files › ${where} as ${agentFileName}.` : agentFile && "failed" in agentFile ? ` Not copied to Agent Files: ${agentFile.failed}` : "";
      const previous = (await repository.listEvents(owner, pane.id, { types: ["NOTE"] })).find((event) => typeof event.payload.apkArtifactId === "string");
      const megabytes = (input.upload.byteSize / 1024 / 1024).toFixed(1);
      const downloadPath = `/api/artifacts/${encodeURIComponent(created.artifact.id)}/file`;
      const event = await record(owner, pane, { type: "NOTE", message: `APK ${input.packageName} ${input.versionName} (${megabytes} MB) is ready to download`,
        payload: { apkArtifactId: created.artifact.id, packageName: input.packageName, versionName: input.versionName, versionCode: input.versionCode, byteSize: input.upload.byteSize, buildMs: input.buildMs,
          signedWith: input.signedWith ?? "android-debug-keystore", release: input.release === true, downloadPath, agentFileId } });
      if (previous) await release(String(previous.payload.apkArtifactId));
      await notice(owner, pane, "apk", event, "App Studio built an APK", `${input.packageName} ${input.versionName}, ${megabytes} MB.${filed} Open it on your Android phone signed in to SpaceApp: ${downloadPath}`);
      return { artifactId: created.artifact.id, downloadPath, agentFileId, byteSize: input.upload.byteSize, packageName: input.packageName, versionName: input.versionName, versionCode: input.versionCode,
        ...(input.release ? {} : { unproven }) };
    },

    // ---- the feed and the run (the rail, Nous)
    events: (owner: string, pane: Pane, limit = 100) => repository.listEvents(owner, pane.id, { limit }),
    /** Every brief of the pane, any age (the brief watch; until 31/10 it read the newest 40 events and missed older waiting briefs). */
    briefs: (owner: string, pane: Pane) => repository.listEvents(owner, pane.id, { types: ["BRIEF"] }),
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
