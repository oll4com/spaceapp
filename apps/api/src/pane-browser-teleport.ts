import type {} from "./request-context.js";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import type { BrowserHostActorContext } from "@space/browser-host";
import { browserRuntimeInputSchema, browserViewportDimensionsSchema, type BrowserSessionViewport, type BrowserViewportDimensions, type Pane } from "@space/contracts";
import { SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { operatorBrowserActor } from "./browser-actors.js";
import { countsAsOperatorInput, type BrowserControlActivity } from "./browser-control-activity.js";
import { uploadBrowserFiles } from "./browser-file-upload.js";
import { pageFocusEditable } from "./browser-page-readout.js";
import type { BrowserSessionManager } from "./browser-sessions.js";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";
import { assertBrowserPaneCompatible, getActiveBrowserSessionForPane, getPaneById } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";

/**
 * Teleport (operator 13/11 nous_msg:6d87d2a6, 3bbf77d1): the Nous app shows a pane browser full screen and drives it with real touch.
 * While teleported the pane is a phone (mobile viewport, mobile UA, touch: setViewport "mobile"); closing puts its old viewport back.
 * Frames are the pane's own screencast (only changed frames, sized for a phone by screencastFor), handed out by a long poll because the
 * phone reaches the API only through its request channel; inputs are the dock's own runtime inputs, a batch per request.
 */

/** The Nous app gives up on a request after 8 s: a poll answers well before. */
const TELEPORT_POLL_MS = 4_000;
/** No poll and no input for this long: the phone left (app closed, screen off), so the pane gets its viewport back. */
const TELEPORT_IDLE_MS = 30_000;
const PHONE_SIZE = { width: 390, height: 844 };
/**
 * Captcha mode (operator 14/11 nous_msg:6345d547): a slider challenge reads the drag's timing, so a batch that carries the phone's own
 * timestamps (`at`, ms) plays with the gaps the finger made, at least this far behind it so the network's jitter never bunches them up.
 */
const REPLAY_DELAY_MS = 120;
/** A reCAPTCHA challenge is 400 CSS px plus its border (nous_msg:f93235c0): a narrower phone gets a page this wide, the same shape, scaled to its screen. */
const MIN_PHONE_WIDTH = 412;
export const roomyPhone = (size: BrowserViewportDimensions): BrowserViewportDimensions => size.width >= MIN_PHONE_WIDTH ? size
  : { width: MIN_PHONE_WIDTH, height: Math.min(1600, Math.round((size.height * MIN_PHONE_WIDTH) / size.width)) };

type Manager = Pick<BrowserSessionManager, "getActive" | "setViewport" | "captureFrame" | "activatePage" | "startFrameStream" | "dispatchInput">;
interface Shown { sequence: number; data: Buffer; mimeType: string; width: number; height: number; capturedAt: string }
/** A pane's timed inputs: they play one after another; `low`/`high` are the current touch's least and most delay on the way (arrival - at). */
/** A held frame poll; `viewer` is the phone or browser it came from. */
interface Waiter { viewer: string; after: number; done(): void }
interface Replay { chain: Promise<void>; offset: number; low: number; high: number; failure: unknown }
interface Hub {
  pane: Pane;
  actor: BrowserHostActorContext;
  sessionId: string;
  /** The viewport to put back; null when the pane was already a phone. */
  restore: { viewport: BrowserSessionViewport; dimensions?: BrowserViewportDimensions } | null;
  size: BrowserViewportDimensions | null;
  frame: Shown | null;
  sequence: number;
  waiters: Set<Waiter>;
  /** Each viewer's newest frame handed out. */
  served: Map<string, number>;
  stream: { stop(): Promise<void> } | null;
  idle?: ReturnType<typeof setTimeout>;
  unview(): void;
}

export function registerPaneBrowserTeleportRoutes(app: FastifyInstance, options: {
  config: Pick<SpaceApiConfig, "browserSessionsProfileRoot">;
  store: SpaceStore;
  browserSessionManager: Manager;
  controlActivity: Pick<BrowserControlActivity, "view" | "noteUse" | "noteInput">;
  nous: { current: { attachmentPath(request: FastifyRequest, id: string): Promise<string> } | null };
  routeOptions: Pick<RouteShorthandOptions, "config">;
  /** Whether the pane's focused element takes typing (null: unknown); tests replace it. */
  focusEditable?: (pane: Pane) => Promise<boolean | null>;
}) {
  const { config, store, browserSessionManager: browsers, controlActivity, routeOptions } = options;
  const focusEditable = options.focusEditable ?? (async (pane: Pane) => pageFocusEditable({ config, pane, session: await getActiveBrowserSessionForPane(store, pane) }));
  // shortcut: teleports live in this API process; a restart mid-teleport leaves the pane a phone until the next teleport closes. Upgrade when the API runs more than one process.
  const hubs = new Map<string, Hub>();
  const replays = new Map<string, Replay>();
  // A viewer's lanes all ask after its last shown frame, so a frame one lane took is not given to its other lanes too (Captcha mode, operator 14/11
  // nous_msg:6345d547: half a fast page's answers were twins the phone decrypted for nothing). after=0 is a viewer starting over.
  const floor = (hub: Hub, viewer: string, after: number) => (after === 0 ? 0 : Math.max(after, hub.served.get(viewer) ?? 0));
  // A new frame wakes one waiting poll per viewer; the rest stay held for the next frames instead of all answering at once (twins or empty).
  const wake = (hub: Hub) => {
    const woken = new Set<string>();
    for (const waiter of [...hub.waiters]) {
      if (woken.has(waiter.viewer) || hub.sequence <= floor(hub, waiter.viewer, waiter.after)) continue;
      woken.add(waiter.viewer);
      waiter.done();
    }
  };
  const arm = (hub: Hub) => {
    clearTimeout(hub.idle);
    hub.idle = setTimeout(() => void end(hub.pane.id, "teleport-idle"), TELEPORT_IDLE_MS);
    hub.idle.unref?.();
  };

  async function end(paneId: string, traceId: string): Promise<void> {
    const hub = hubs.get(paneId);
    if (!hub) return;
    hubs.delete(paneId);
    replays.delete(paneId);
    clearTimeout(hub.idle);
    hub.unview();
    for (const waiter of [...hub.waiters]) waiter.done();
    await hub.stream?.stop().catch(() => undefined);
    if (!hub.restore) return;
    // Only the phone viewport this teleport set goes back: not another session's, nor a viewport someone chose since.
    const active = await browsers.getActive(hub.pane).catch(() => null);
    if (active?.session.sessionId !== hub.sessionId || active.session.viewport !== "mobile") return;
    await browsers.setViewport(hub.pane, hub.restore.viewport, traceId, hub.actor, hub.restore.dimensions)
      .catch((error: unknown) => app.log.warn({ err: error, paneId }, "A teleported browser could not get its viewport back."));
  }

  async function open(pane: Pane, active: NonNullable<Awaited<ReturnType<Manager["getActive"]>>>, actor: BrowserHostActorContext): Promise<Hub> {
    if (!browsers.startFrameStream) throw new SpaceFeatureDisabledError("BROWSER_STREAM_UNAVAILABLE", "Realtime browser streaming is unavailable on this runtime.");
    const { session } = active;
    const hub: Hub = { pane, actor, sessionId: session.sessionId, size: null, frame: null, sequence: 0, waiters: new Set(), served: new Map(), stream: null,
      restore: session.viewport === "mobile" ? null : { viewport: session.viewport, ...(active.viewportDimensions ? { dimensions: active.viewportDimensions } : {}) },
      unview: controlActivity.view(pane.id) };
    hubs.set(pane.id, hub);
    try {
      const stream = await browsers.startFrameStream(session.sessionId, "REALTIME", (frame) => {
        const size = (frame.metadata.viewportDimensions as BrowserViewportDimensions | undefined) ?? hub.size ?? PHONE_SIZE;
        hub.frame = { sequence: ++hub.sequence, data: frame.data, mimeType: frame.mimeType, width: size.width, height: size.height, capturedAt: frame.capturedAt };
        wake(hub);
      }, { focused: true });
      // Closed while the stream started.
      if (hubs.get(pane.id) !== hub) await stream.stop().catch(() => undefined);
      else {
        hub.stream = stream;
        // The host connection dropped and took the stream: end the hub (TELEPORT_OFF) instead of serving its last frame.
        void stream.ended?.then(() => { if (hubs.get(pane.id) === hub) void end(pane.id, "teleport-transport"); });
      }
    } catch (error) {
      await end(pane.id, "teleport-open");
      throw error;
    }
    return hub;
  }

  app.addHook("onClose", async () => { await Promise.allSettled([...hubs.keys()].map((paneId) => end(paneId, "teleport-close"))); });

  app.post("/api/panes/:id/browser/teleport", routeOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(z.object({ on: z.boolean(), dimensions: browserViewportDimensionsSchema.optional(), pageId: z.string().min(1).max(200).optional() }).strict(), request.body ?? {});
    const pane = await getPaneById(store, params.id);
    assertBrowserPaneCompatible(pane);
    const traceId = request.requestIdForSpace;
    let viewportDimensions: BrowserViewportDimensions | null = null;
    if (!input.on) await end(pane.id, traceId);
    else {
      const active = await browsers.getActive(pane);
      if (!active || active.session.status === "CLOSED") throw new SpaceNotFoundError(`Active browser session for pane ${pane.id} was not found.`);
      const actor = operatorBrowserActor(request);
      if (hubs.get(pane.id) && hubs.get(pane.id)?.sessionId !== active.session.sessionId) await end(pane.id, traceId);
      const hub = hubs.get(pane.id) ?? await open(pane, active, actor);
      try {
        if (input.pageId && input.pageId !== active.session.activePageId) {
          if (!browsers.activatePage) throw new SpaceFeatureDisabledError("BROWSER_PAGES_UNAVAILABLE", "Browser page management is unavailable on this runtime.");
          await browsers.activatePage(pane, input.pageId, traceId, actor);
        }
        // An agent's lease refuses this as it refuses the dock: the phone shows the conflict, nothing is taken over.
        const dimensions = input.dimensions && roomyPhone(input.dimensions);
        const response = await browsers.setViewport(pane, "mobile", traceId, actor, dimensions);
        hub.size = response.viewportDimensions ?? dimensions ?? hub.size;
        viewportDimensions = hub.size;
      } catch (error) {
        await end(pane.id, traceId);
        throw error;
      }
      arm(hub);
    }
    await recordAudit(store, request, { action: "pane.browser.teleport", targetType: "pane", targetId: pane.id, metadata: { roomId: pane.roomId, on: input.on } });
    return { on: input.on, viewportDimensions };
  });

  app.get("/api/panes/:id/browser/teleport/frame", routeOptions, async (request, reply) => {
    const params = parseQuery(idParamSchema, request.params);
    const query = parseQuery(z.object({ after: z.coerce.number().int().min(0).default(0) }).strict(), request.query);
    const hub = hubs.get(params.id);
    if (!hub) return sendApiError(reply, 409, "TELEPORT_OFF", "This browser is not teleported.");
    arm(hub);
    const viewer = `${request.user?.id ?? ""} ${request.mobileDevice?.id ?? request.appSession ?? "web"}`;
    if (!(hub.frame && hub.frame.sequence > floor(hub, viewer, query.after))) {
      await new Promise<void>((resolve) => {
        const waiter: Waiter = { viewer, after: query.after, done: () => { clearTimeout(timer); hub.waiters.delete(waiter); resolve(); } };
        const timer = setTimeout(waiter.done, TELEPORT_POLL_MS);
        hub.waiters.add(waiter);
      });
    }
    if (hubs.get(params.id) !== hub) return sendApiError(reply, 409, "TELEPORT_OFF", "This browser is not teleported.");
    if (!hub.frame) {
      // A still page sends no screencast frame: the first picture is a screenshot.
      const shot = (await browsers.captureFrame(hub.sessionId)).screenshotDataUrl;
      const size = hub.size ?? PHONE_SIZE;
      if (shot && !hub.frame) hub.frame = { sequence: ++hub.sequence, data: Buffer.from(shot.slice(shot.indexOf(",") + 1), "base64"), mimeType: "image/png", ...size, capturedAt: new Date().toISOString() };
    } else if (hub.frame.sequence <= query.after && (await store.getActivePaneBrowserSession(params.id))?.sessionId !== hub.sessionId) {
      // The browser restarted under the teleport: its stream is gone, the phone opens the new one.
      await end(params.id, request.requestIdForSpace);
      return sendApiError(reply, 409, "TELEPORT_OFF", "This browser restarted; open it again.");
    }
    // After the 4 s wait a frame already handed out comes again: a lost answer costs at most that.
    const frame = hub.frame && hub.frame.sequence > query.after ? hub.frame : null;
    if (frame) hub.served.set(viewer, Math.max(hub.served.get(viewer) ?? 0, frame.sequence));
    return { frame: frame ? { ...frame, data: frame.data.toString("base64") } : null };
  });

  app.post("/api/panes/:id/browser/teleport/input", routeOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(z.object({ inputs: z.array(browserRuntimeInputSchema).min(1), at: z.array(z.number().finite()).optional() }).strict()
      .refine((body) => !body.at || body.at.length === body.inputs.length, { message: "at needs one timestamp per input.", path: ["at"] }), request.body ?? {});
    const pane = await getPaneById(store, params.id);
    assertBrowserPaneCompatible(pane);
    const { dispatchInput } = browsers;
    if (!dispatchInput) throw new SpaceFeatureDisabledError("BROWSER_STREAM_UNAVAILABLE", "Realtime browser input is unavailable on this runtime.");
    const hub = hubs.get(pane.id);
    if (hub) arm(hub);
    const actor = operatorBrowserActor(request);
    const note = (item: (typeof input.inputs)[number]) => {
      if (!countsAsOperatorInput(item)) return;
      controlActivity.noteUse(pane.id);
      controlActivity.noteInput(item.leaseId);
    };
    const replay = replays.get(pane.id);
    if (!input.at) {
      // Untimed batches never overtake a timed one still playing.
      await replay?.chain;
      // In order, as the dock's socket sends them: a touch's move never overtakes its start.
      for (const [index, item] of input.inputs.entries()) {
        note(item);
        await dispatchInput(pane, item, `${request.requestIdForSpace}:${index}`, actor);
      }
      // A tap that ends here says whether it left a text field focused, so the phone opens or closes its keyboard like a phone browser
      // (operator 20/11 nous_msg:115184c7). shortcut: timed (Captcha mode) batches answer before they play, so they never say; add it if a captcha needs typing.
      const last = input.inputs.at(-1);
      const editable = last?.type === "TOUCH" && last.eventType === "touchEnd" ? await focusEditable(pane).catch(() => null) : null;
      return { ok: true, dispatched: input.inputs.length, ...(editable === null ? {} : { editable }) };
    }
    // shortcut: a failed timed input drops the rest of what was queued and the next batch answers its error; upgrade if the app must retry a gesture.
    if (replay?.failure) {
      const { failure } = replay;
      replay.failure = null;
      throw failure;
    }
    const timeline = replay ?? { chain: Promise.resolve(), offset: 0, low: Infinity, high: -Infinity, failure: null };
    replays.set(pane.id, timeline);
    const { at } = input;
    for (const [index, item] of input.inputs.entries()) {
      note(item);
      const stamp = at[index]!;
      const lag = Date.now() - stamp;
      // Each touch gets its own timeline, as far behind the finger as the last touch's delays spread (a slow link carries a round
      // trip of moves per request), never less than the jitter margin: then no move of it arrives after its time.
      const lead = (item.type === "TOUCH" && item.eventType === "touchStart") || timeline.low === Infinity ? Math.max(REPLAY_DELAY_MS, timeline.high - timeline.low) : null;
      if (lead !== null) timeline.low = timeline.high = lag;
      else [timeline.low, timeline.high] = [Math.min(timeline.low, lag), Math.max(timeline.high, lag)];
      const traceId = `${request.requestIdForSpace}:${index}`;
      timeline.chain = timeline.chain.then(async () => {
        if (timeline.failure || replays.get(pane.id) !== timeline) return;
        const now = Date.now();
        if (lead !== null) timeline.offset = now - stamp + lead;
        // A move that still came late shifts the rest, so their gaps hold.
        timeline.offset = Math.max(timeline.offset, now - stamp);
        // A finger held longer than a teleport lives outlives it: the wait is bounded by the idle close.
        const wait = Math.min(stamp + timeline.offset - now, TELEPORT_IDLE_MS);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (replays.get(pane.id) !== timeline) return;
        // Chrome answers a touch once the page handled it, about one per frame it renders (45 ms measured 14/11): a finger faster than
        // that plays slower, every move still in order (dispatches overlapped could reorder, each first reads its session and lease).
        await dispatchInput(pane, item, traceId, actor).catch((error: unknown) => { timeline.failure = error; });
      });
    }
    return { ok: true, dispatched: input.inputs.length, timed: true };
  });

  // The phone's gallery or camera into the page's file input: the photo is a Nous attachment the app uploaded first.
  app.post("/api/panes/:id/browser/teleport/upload", routeOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(z.object({ attachmentId: z.string().min(1).max(200), index: z.number().int().min(0).optional() }).strict(), request.body ?? {});
    const pane = await getPaneById(store, params.id);
    assertBrowserPaneCompatible(pane);
    const nous = options.nous.current;
    if (!nous) throw new SpaceFeatureDisabledError("NOUS_UNAVAILABLE", "Nous is not running here, so the phone's files cannot reach the browser.");
    const path = await nous.attachmentPath(request, input.attachmentId);
    const result = await uploadBrowserFiles({ config, pane, session: await getActiveBrowserSessionForPane(store, pane), paths: [path], ...(input.index === undefined ? {} : { index: input.index }) });
    await recordAudit(store, request, { action: "pane.browser.teleport.upload", targetType: "pane", targetId: pane.id,
      metadata: { roomId: pane.roomId, attachmentId: input.attachmentId, fileInputs: result.fileInputs } });
    return { uploaded: result.uploaded, fileInputs: result.fileInputs, index: result.index };
  });
}
