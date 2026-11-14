import type {} from "./request-context.js";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import type { BrowserHostActorContext } from "@space/browser-host";
import { browserRuntimeInputSchema, browserViewportDimensionsSchema, type BrowserSessionViewport, type BrowserViewportDimensions, type Pane } from "@space/contracts";
import { SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { operatorBrowserActor } from "./browser-actors.js";
import { countsAsOperatorInput, type BrowserControlActivity } from "./browser-control-activity.js";
import { uploadBrowserFiles } from "./browser-file-upload.js";
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

type Manager = Pick<BrowserSessionManager, "getActive" | "setViewport" | "captureFrame" | "activatePage" | "startFrameStream" | "dispatchInput">;
interface Shown { sequence: number; data: Buffer; mimeType: string; width: number; height: number; capturedAt: string }
interface Hub {
  pane: Pane;
  actor: BrowserHostActorContext;
  sessionId: string;
  /** The viewport to put back; null when the pane was already a phone. */
  restore: { viewport: BrowserSessionViewport; dimensions?: BrowserViewportDimensions } | null;
  size: BrowserViewportDimensions | null;
  frame: Shown | null;
  sequence: number;
  waiters: Set<() => void>;
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
}) {
  const { config, store, browserSessionManager: browsers, controlActivity, routeOptions } = options;
  // shortcut: teleports live in this API process; a restart mid-teleport leaves the pane a phone until the next teleport closes. Upgrade when the API runs more than one process.
  const hubs = new Map<string, Hub>();
  const wake = (hub: Hub) => { for (const waiter of [...hub.waiters]) waiter(); };
  const arm = (hub: Hub) => {
    clearTimeout(hub.idle);
    hub.idle = setTimeout(() => void end(hub.pane.id, "teleport-idle"), TELEPORT_IDLE_MS);
    hub.idle.unref?.();
  };

  async function end(paneId: string, traceId: string): Promise<void> {
    const hub = hubs.get(paneId);
    if (!hub) return;
    hubs.delete(paneId);
    clearTimeout(hub.idle);
    hub.unview();
    wake(hub);
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
    const hub: Hub = { pane, actor, sessionId: session.sessionId, size: null, frame: null, sequence: 0, waiters: new Set(), stream: null,
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
      else hub.stream = stream;
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
        const response = await browsers.setViewport(pane, "mobile", traceId, actor, input.dimensions);
        hub.size = response.viewportDimensions ?? input.dimensions ?? hub.size;
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
    if (!(hub.frame && hub.frame.sequence > query.after)) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); hub.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, TELEPORT_POLL_MS);
        hub.waiters.add(done);
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
    const frame = hub.frame && hub.frame.sequence > query.after ? hub.frame : null;
    return { frame: frame ? { ...frame, data: frame.data.toString("base64") } : null };
  });

  app.post("/api/panes/:id/browser/teleport/input", routeOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(z.object({ inputs: z.array(browserRuntimeInputSchema).min(1) }).strict(), request.body ?? {});
    const pane = await getPaneById(store, params.id);
    assertBrowserPaneCompatible(pane);
    if (!browsers.dispatchInput) throw new SpaceFeatureDisabledError("BROWSER_STREAM_UNAVAILABLE", "Realtime browser input is unavailable on this runtime.");
    const hub = hubs.get(pane.id);
    if (hub) arm(hub);
    const actor = operatorBrowserActor(request);
    // In order, as the dock's socket sends them: a touch's move never overtakes its start.
    for (const [index, item] of input.inputs.entries()) {
      if (countsAsOperatorInput(item)) {
        controlActivity.noteUse(pane.id);
        controlActivity.noteInput(item.leaseId);
      }
      await browsers.dispatchInput(pane, item, `${request.requestIdForSpace}:${index}`, actor);
    }
    return { ok: true, dispatched: input.inputs.length };
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
