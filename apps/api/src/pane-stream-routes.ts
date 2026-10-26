import { countsAsOperatorInput, createBrowserControlActivity } from "./browser-control-activity.js";
import { dirname, join } from "node:path";
import type {} from "./request-context.js";
import type {} from "@fastify/websocket";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  browserFrameWebSocketServerMessageSchema, browserStreamModeSchema, browserStreamTicketResponseSchema,
  browserStreamWebSocketClientMessageSchema, browserStreamWebSocketServerMessageSchema, idSchema,
  type PaneBrowserSessionResponse, vncPresetListResponseSchema
} from "@space/contracts";
import { SpaceConflictError, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { operatorBrowserActor } from "./browser-actors.js";
import { BrowserControlHeldError } from "./browser-errors.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import { createBrowserLiveSender } from "./browser-live-sender.js";
import type { SpaceApiConfig } from "./config.js";
import { assertBrowserPaneCompatible, getPaneById } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseQuery } from "./route-parsing.js";
import { assertSafeVncTarget, pipeVncStream } from "./vnc-proxy.js";

const browserFrameQuerySchema = z.object({
  sessionId: idSchema,
  token: z.string().min(24).max(512).optional()
});

const browserStreamQuerySchema = browserFrameQuerySchema.required({ token: true }).extend({
  frameAck: z.enum(["1"]).optional(),
  mode: browserStreamModeSchema.default("AUTO")
});

const browserAudioQuerySchema = browserFrameQuerySchema.required({ token: true });

const vncStreamQuerySchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535)
});

function closeBrowserSocketWithSetupError(
  socket: { readyState: number; send(data: string): void; close(code?: number, reason?: string): void },
  message: string
) {
  if (socket.readyState !== 1) return;
  socket.send(
    JSON.stringify(
      browserFrameWebSocketServerMessageSchema.parse({
        type: "error",
        code: "BROWSER_FRAME_STREAM_UNAVAILABLE",
        message
      })
    )
  );
  socket.close(1008, "Browser frame stream unavailable");
}

const browserStreamMaxMessageBytes = 64 * 1024;

const browserStreamMaxQueuedInputs = 256;

function browserStreamMessageText(raw: unknown): string | null {
  if (typeof raw === "string") {
    return Buffer.byteLength(raw, "utf8") <= browserStreamMaxMessageBytes ? raw : null;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.byteLength <= browserStreamMaxMessageBytes ? raw.toString("utf8") : null;
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength <= browserStreamMaxMessageBytes ? Buffer.from(raw).toString("utf8") : null;
  }
  if (Array.isArray(raw) && raw.every((part) => Buffer.isBuffer(part))) {
    const byteLength = raw.reduce((total, part) => total + part.byteLength, 0);
    return byteLength <= browserStreamMaxMessageBytes ? Buffer.concat(raw).toString("utf8") : null;
  }
  if (ArrayBuffer.isView(raw)) {
    return raw.byteLength <= browserStreamMaxMessageBytes
      ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8")
      : null;
  }
  return null;
}

function browserInputAckError(error: unknown): { code: string; message: string } {
  if (error instanceof BrowserControlHeldError) {
    return { code: "BROWSER_CONTROL_HELD", message: "Browser control is held by another actor." };
  }
  if (error instanceof SpaceConflictError) {
    return { code: "BROWSER_INPUT_CONFLICT", message: "Browser input requires an active matching control lease." };
  }
  if (error instanceof SpaceNotFoundError) {
    return { code: "BROWSER_SESSION_NOT_FOUND", message: "The active browser session was not found." };
  }
  if (error instanceof SpaceFeatureDisabledError) {
    return { code: "BROWSER_INPUT_UNAVAILABLE", message: "Browser input is temporarily unavailable." };
  }
  return { code: "BROWSER_INPUT_FAILED", message: "Browser input could not be dispatched." };
}

function sendBrowserStreamMessage(
  socket: { readyState: number; bufferedAmount: number; send(data: string): void },
  message: unknown
): void {
  if (socket.readyState !== 1 || socket.bufferedAmount > 8 * 1024 * 1024) return;
  try {
    socket.send(JSON.stringify(browserStreamWebSocketServerMessageSchema.parse(message)));
  } catch {
    // A closing socket must not poison the ordered browser input queue.
  }
}

/**
 * Browser pane frame/stream/audio sockets with their tickets, VNC presets and the VNC stream; moved verbatim, the
 * parent retains authentication, CSRF, errors and rate limits.
 */
export function registerPaneStreamRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  browserSessionManager: BrowserSessionManagerWithHostHealth;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  websocketRouteOptions: Pick<RouteShorthandOptions, "config"> & { websocket: true };
}) {
  const { config, store, browserSessionManager, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions } = options;
  // Operator input per control lease; returned so the browser routes and the CLI bridge share it (idle release, agent reclaim).
  const controlActivity = createBrowserControlActivity(undefined,
    process.env.VITEST === "true" ? null : join(dirname(config.browserEvidenceArtifactRoot), "browser-agents.json"));
  app.get("/api/panes/:id/browser/frames", defaultWebsocketRateLimitOptions, (socket, request) => {
    void (async () => {
      const params = parseQuery(idParamSchema, request.params);
      const query = parseQuery(browserFrameQuerySchema.required({ token: true }), request.query);
      const pane = await getPaneById(store, params.id);
      assertBrowserPaneCompatible(pane);
      const session = await store.getPaneBrowserSession(query.sessionId);
      if (!session || session.paneId !== pane.id || !session.isActive) {
        throw new SpaceNotFoundError(`Browser session ${query.sessionId} was not found.`);
      }
      if (!browserSessionManager.acceptFrameTicket(pane.id, session.sessionId, query.token)) {
        throw new SpaceFeatureDisabledError("BROWSER_FRAME_TOKEN_INVALID", "Browser frame stream token is invalid or expired.");
      }
      if (socket.readyState !== 1) return;
      socket.send(
        JSON.stringify(
          browserFrameWebSocketServerMessageSchema.parse({
            type: "ready",
            paneId: pane.id,
            sessionId: session.sessionId
          })
        )
      );
      let streaming = true;
      const stop = () => {
        streaming = false;
      };
      socket.on("close", stop);
      while (streaming && socket.readyState === 1) {
        const frame = await browserSessionManager.captureFrame(session.sessionId);
        if (socket.readyState !== 1) break;
        socket.send(
          JSON.stringify(browserFrameWebSocketServerMessageSchema.parse({ type: "frame", frame })),
          { compress: false }
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    })().catch((error: unknown) => {
      closeBrowserSocketWithSetupError(socket, error instanceof Error ? error.message : "Browser frame stream setup failed.");
    });
  });
  app.post("/api/panes/:id/browser/stream-ticket", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    assertBrowserPaneCompatible(pane);
    const session = await store.getActivePaneBrowserSession(pane.id);
    if (!session) throw new SpaceNotFoundError(`Active browser session for pane ${pane.id} was not found.`);
    return browserStreamTicketResponseSchema.parse({
      websocket: browserSessionManager.issueFrameTicket(
        pane.id,
        session.sessionId,
        config.browserSessionsTokenTtlMs
      )
    });
  });
  app.get("/api/panes/:id/browser/stream", defaultWebsocketRateLimitOptions, (socket, request) => {
    void (async () => {
      const params = parseQuery(idParamSchema, request.params);
      const query = parseQuery(browserStreamQuerySchema, request.query);
      const pane = await getPaneById(store, params.id);
      assertBrowserPaneCompatible(pane);
      const session = await store.getPaneBrowserSession(query.sessionId);
      if (!session || session.paneId !== pane.id || !session.isActive) {
        throw new SpaceNotFoundError(`Browser session ${query.sessionId} was not found.`);
      }
      if (!browserSessionManager.acceptFrameTicket(pane.id, session.sessionId, query.token)) {
        throw new SpaceFeatureDisabledError("BROWSER_FRAME_TOKEN_INVALID", "Browser stream token is invalid or expired.");
      }
      const startFrameStream = browserSessionManager.startFrameStream?.bind(browserSessionManager);
      const dispatchInput = browserSessionManager.dispatchInput?.bind(browserSessionManager);
      if (!startFrameStream || !dispatchInput) {
        throw new SpaceFeatureDisabledError("BROWSER_STREAM_UNAVAILABLE", "Realtime browser streaming is unavailable on this runtime.");
      }
      const sender = createBrowserLiveSender(socket, query.frameAck === "1");
      socket.once("close", () => sender.stop());
      const stream = await startFrameStream(session.sessionId, query.mode, (frame) => {
        sender.present(frame.data, frame.metadata.viewportDimensions as { width: number; height: number } | undefined);
      }, { focused: true });
      if (socket.readyState !== 1) {
        await stream.stop();
        return;
      }
      let queuedInputs = 0;
      let inputQueue = Promise.resolve();
      const actor = operatorBrowserActor(request);
      socket.on("message", (raw, isBinary) => {
        const text = isBinary ? null : browserStreamMessageText(raw);
        if (text === null) {
          sendBrowserStreamMessage(socket, {
            type: "error",
            code: "BROWSER_STREAM_INPUT_INVALID",
            message: "Browser stream input must be valid bounded JSON text."
          });
          return;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(text);
        } catch {
          sendBrowserStreamMessage(socket, {
            type: "error",
            code: "BROWSER_STREAM_INPUT_INVALID",
            message: "Browser stream input must be valid bounded JSON text."
          });
          return;
        }
        const parsed = browserStreamWebSocketClientMessageSchema.safeParse(decoded);
        if (!parsed.success) {
          sendBrowserStreamMessage(socket, {
            type: "error",
            code: "BROWSER_STREAM_INPUT_INVALID",
            message: "Browser stream input did not match the required contract."
          });
          return;
        }
        if (parsed.data.type === "frameAck") {
          if (query.frameAck === "1") sender.acknowledge();
          return;
        }
        if (queuedInputs >= browserStreamMaxQueuedInputs) {
          sendBrowserStreamMessage(socket, {
            type: "error",
            code: "BROWSER_STREAM_INPUT_OVERLOADED",
            message: "Browser stream input is temporarily overloaded."
          });
          return;
        }
        const message = parsed.data;
        queuedInputs += 1;
        inputQueue = inputQueue.then(async () => {
          const startedAt = Date.now();
          try {
            if ("leaseId" in message.input && typeof message.input.leaseId === "string" && countsAsOperatorInput(message.input)) controlActivity.noteInput(message.input.leaseId);
            await dispatchInput(
              pane,
              message.input,
              `${request.requestIdForSpace}:${message.requestId}`,
              actor
            );
            sendBrowserStreamMessage(socket, {
              type: "inputAck",
              requestId: message.requestId,
              ok: true,
              serverDurationMs: Math.min(300_000, Date.now() - startedAt)
            });
          } catch (error) {
            sendBrowserStreamMessage(socket, {
              type: "inputAck",
              requestId: message.requestId,
              ok: false,
              serverDurationMs: Math.min(300_000, Date.now() - startedAt),
              error: browserInputAckError(error)
            });
          }
        }).finally(() => {
          queuedInputs -= 1;
        });
      });
      sendBrowserStreamMessage(socket, {
        type: "ready",
        paneId: pane.id,
        sessionId: session.sessionId,
        streamId: stream.id,
        encoding: "image/jpeg",
        requestedMode: stream.profile.requestedMode,
        resolvedMode: stream.profile.resolvedMode,
        framesPerSecond: stream.profile.framesPerSecond
      });
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        void stream.stop().catch(() => undefined);
      };
      socket.once("close", stop);
      socket.once("error", stop);
    })().catch((error: unknown) => {
      closeBrowserSocketWithSetupError(socket, error instanceof Error ? error.message : "Browser binary stream setup failed.");
    });
  });
  app.post("/api/panes/:id/browser/audio-ticket", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    assertBrowserPaneCompatible(pane);
    const session = await store.getActivePaneBrowserSession(pane.id);
    if (!session) throw new SpaceNotFoundError(`Active browser session for pane ${pane.id} was not found.`);
    return browserStreamTicketResponseSchema.parse({
      websocket: browserSessionManager.issueAudioTicket(
        pane.id,
        session.sessionId,
        config.browserSessionsTokenTtlMs
      )
    });
  });
  app.get("/api/panes/:id/browser/audio", defaultWebsocketRateLimitOptions, (socket, request) => {
    void (async () => {
      const params = parseQuery(idParamSchema, request.params);
      const query = parseQuery(browserAudioQuerySchema, request.query);
      const pane = await getPaneById(store, params.id);
      assertBrowserPaneCompatible(pane);
      const session = await store.getPaneBrowserSession(query.sessionId);
      if (!session || session.paneId !== pane.id || !session.isActive) {
        throw new SpaceNotFoundError(`Browser session ${query.sessionId} was not found.`);
      }
      if (!browserSessionManager.acceptAudioTicket(pane.id, session.sessionId, query.token)) {
        throw new SpaceFeatureDisabledError("BROWSER_AUDIO_TOKEN_INVALID", "Browser audio token is invalid or expired.");
      }
      const startAudioStream = browserSessionManager.startAudioStream?.bind(browserSessionManager);
      if (!startAudioStream) {
        throw new SpaceFeatureDisabledError("BROWSER_AUDIO_UNAVAILABLE", "Browser audio streaming is unavailable on this runtime.");
      }
      const stream = await startAudioStream(session.sessionId, (chunk) => {
        if (socket.readyState !== 1 || socket.bufferedAmount > 8 * 1024 * 1024) return;
        // Raw PCM silence still costs 1.5 Mbit/s on far links; the player restarts its clock after a gap.
        if (!chunk.data.some((byte) => byte !== 0)) return;
        socket.send(chunk.data, { binary: true, compress: false });
      });
      if (socket.readyState !== 1) {
        await stream.stop();
        return;
      }
      sendBrowserStreamMessage(socket, {
        type: "audioReady",
        paneId: pane.id,
        sessionId: session.sessionId,
        streamId: stream.id,
        encoding: "pcm_s16le",
        sampleRate: stream.sampleRate,
        channels: stream.channels
      });
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        void stream.stop().catch(() => undefined);
      };
      socket.once("close", stop);
      socket.once("error", stop);
    })().catch((error: unknown) => {
      closeBrowserSocketWithSetupError(socket, error instanceof Error ? error.message : "Browser audio stream setup failed.");
    });
  });
  app.get("/api/vnc-presets", defaultRouteRateLimitOptions, async () => {
    return vncPresetListResponseSchema.parse({ presets: config.vncPresets });
  });
  app.get("/api/panes/:id/vnc/stream", defaultWebsocketRateLimitOptions, (socket, request) => {
    void (async () => {
      const params = parseQuery(idParamSchema, request.params);
      const query = parseQuery(vncStreamQuerySchema, request.query);
      const pane = await getPaneById(store, params.id);
      if (pane.mode !== "VNC") {
        throw new SpaceConflictError(`Pane ${pane.id} is ${pane.mode}; VNC streams require VNC panes.`);
      }
      assertSafeVncTarget(query.host);
      await pipeVncStream(socket, query.host, query.port);
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "VNC stream setup failed.";
      if (socket.readyState === 1) socket.close(1011, message.slice(0, 120));
    });
  });
  return controlActivity;
}

/** Browser pane single frame and session stop; the parent retains authentication, CSRF, errors and rate limits. */
export function registerPaneBrowserFrameRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  browserSessionManager: BrowserSessionManagerWithHostHealth;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  youtubeSessionStarts: Map<string, Promise<PaneBrowserSessionResponse>>;
  youtubeAccountOperations: Map<string, Promise<unknown>>;
}) {
  const { store, browserSessionManager, routeOptions: defaultRouteRateLimitOptions, youtubeSessionStarts,
    youtubeAccountOperations } = options;
  app.get("/api/panes/:id/browser/frame", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const query = parseQuery(browserFrameQuerySchema, request.query);
    const pane = await getPaneById(store, params.id);
    assertBrowserPaneCompatible(pane);
    const session = await store.getPaneBrowserSession(query.sessionId);
    if (!session || session.paneId !== pane.id || !session.isActive) {
      throw new SpaceNotFoundError(`Browser session ${query.sessionId} was not found.`);
    }
    return browserSessionManager.captureFrame(session.sessionId);
  });
  app.post("/api/panes/:id/browser/stop", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    assertBrowserPaneCompatible(pane);
    if (pane.mode === "YOUTUBE") {
      await youtubeAccountOperations.get(pane.id)?.catch(() => undefined);
      await youtubeSessionStarts.get(pane.id)?.catch(() => undefined);
    }
    if (pane.mode !== "YOUTUBE" || await store.getActivePaneBrowserSession(pane.id)) {
      await browserSessionManager.stopPane(pane.id, request.requestIdForSpace, operatorBrowserActor(request));
    }
    await recordAudit(store, request, {
      action: "pane.browser.stop",
      targetType: "pane",
      targetId: pane.id,
      metadata: { roomId: pane.roomId }
    });
    return { ok: true, paneId: pane.id };
  });
}
