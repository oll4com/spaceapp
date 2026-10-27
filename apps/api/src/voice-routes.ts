import type {} from "./request-context.js";
import { createHash } from "node:crypto";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { WebSocket as WsClient } from "ws";
import { z } from "zod";
import {
  type AuthUser, inferProviderFromModel, type LiveAudioProviderId, openAiModelsResponseSchema, type Room,
  voiceRealtimeDelegateRequestSchema, voiceRealtimeDelegateResponseSchema, voiceRealtimeSessionRequestSchema
} from "@space/contracts";
import { SpaceFeatureDisabledError, type SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import type { DecisionsService } from "./decisions-service.js";
import { sendApiError } from "./http-errors.js";
import { isVoiceDailyBudgetExceeded, summarizeVoiceDelegationCosts } from "./live-cost-accounting.js";
import { routeLiveDelegation } from "./live-jev-delegation.js";
import { readStagedUpload, withStagedUploads } from "./multipart-upload.js";
import { recordAudit } from "./request-audit.js";
import { parseBody } from "./route-parsing.js";
import { sniffImageMime } from "./upload-media.js";
import type { SetupOwnerVoiceRuntime } from "./setup-owner-voice-runtime.js";
import type { SetupVoiceCredentials } from "./setup-voice-credentials.js";
import { buildVoiceTranscriptionSettings } from "./voice-settings.js";
import {
  createVoiceAttachmentResponse, createVoiceDelegateResponse,
  fetchOpenAiModels, getLiveAudioProvidersStatus, getLocalVoiceProviderStatus
} from "./voice-transcription.js";
import { bridgeFishVoice } from "./fish-voice-bridge.js";
import { relayVoiceSockets, voiceProxyLimits, VoiceProxyTickets } from "./voice-ws-proxy.js";

/**
 * Voice transcription settings, local voice sessions, realtime calls, delegation, costs, triage, policy and the
 * voice WebSocket proxy; the parent retains authentication, CSRF, errors and rate limits.
 */
export function registerVoiceRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  decisionsService: DecisionsService;
  store: SpaceStore;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  websocketRouteOptions: Pick<RouteShorthandOptions, "config"> & { websocket: true };
  assertRoomAccess: (roomId: string, user: AuthUser | null | undefined) => Promise<Room>;
  /** The owner's encrypted Live connections saved in First Setup; the server's own keys stay the fallback. */
  setupOwnerVoiceRuntime: SetupOwnerVoiceRuntime;
  setupVoiceCredentials: SetupVoiceCredentials;
}) {
  const { config, decisionsService, store, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions, assertRoomAccess, setupOwnerVoiceRuntime, setupVoiceCredentials } = options;
  app.get("/api/voice/transcription/settings", defaultRouteRateLimitOptions, async () => buildVoiceTranscriptionSettings(config));
  app.get("/api/voice/local/status", defaultRouteRateLimitOptions, async () => getLocalVoiceProviderStatus(config));
  app.post("/api/voice/local/sessions", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user || request.user.automationScope || request.user.proofScope === "READ_ONLY") return sendApiError(reply, 403, "VOICE_OWNER_REQUIRED", "An authenticated interactive owner is required.");
    try {
      return await setupOwnerVoiceRuntime.localSession(request.user.id, (request.body as Record<string, unknown>) || {});
    } catch (error) {
      return sendApiError(reply, 502, "LOCAL_VOICE_PROVIDER_FAILED", error instanceof Error ? error.message : "Local voice provider failed.");
    }
  });
  app.get("/api/voice/openai-models", defaultRouteRateLimitOptions, async () => {
    const models = await fetchOpenAiModels(config);
    return openAiModelsResponseSchema.parse({ models });
  });
  app.get("/api/voice/providers", defaultRouteRateLimitOptions, async (request) => {
    return request.user ? setupOwnerVoiceRuntime.status(request.user.id) : getLiveAudioProvidersStatus(config);
  });
  // --- WebSocket Proxy for Voice Live sessions ---
  // The browser cannot connect directly to external WebSocket endpoints (Google, Vercel)
  // from within the LAN. This proxy relays the connection through the Space API server.
  const pendingVoiceWsSessions = new VoiceProxyTickets();
  const activeVoiceProxies = new Set<() => void>();
  app.addHook("preClose", async () => {
    pendingVoiceWsSessions.clear();
    for (const stop of activeVoiceProxies) stop();
    activeVoiceProxies.clear();
  });
  app.post("/api/voice/realtime/calls", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user || request.user.automationScope || request.user.proofScope === "READ_ONLY") return sendApiError(reply, 403, "VOICE_OWNER_REQUIRED", "An authenticated interactive owner is required.");
    const origin = `${request.protocol}://${request.host}`;
    // The public Space URL is terminated by the web/Apache proxy before this
    // request reaches the API.  In that path the proxy can preserve the
    // browser Origin while the API's protocol/host view still reflects the
    // internal hop (for example http://127.0.0.1:4910).  Accept only the
    // configured public UI origin in addition to the derived same-origin
    // value; never accept an arbitrary forwarded Origin.
    const requestOrigin = request.headers.origin?.trim() || origin;
    let configuredOrigin: string | null = null;
    try { configuredOrigin = new URL(config.browserEvidenceTargetOrigin).origin; } catch {}
    if (requestOrigin !== origin && requestOrigin !== configuredOrigin) {
        return sendApiError(reply, 403, "VOICE_ORIGIN_INVALID", "Voice sessions require a same-origin request.");
    }
    const input = parseBody(voiceRealtimeSessionRequestSchema, request.body);
    const provider: LiveAudioProviderId = input.provider || inferProviderFromModel(input.model);
    if (provider === "openai" && (await setupVoiceCredentials.resolve(request.user.id, provider))?.source !== "OWNER") {
      const settings = buildVoiceTranscriptionSettings(config);
      if (!settings.enabled) {
        throw new SpaceFeatureDisabledError("VOICE_TRANSCRIPTION_DISABLED", settings.statusReason);
      }
    }
    const defaultModel = provider === "google"
      ? "gemini-3.8-live"
      : provider === "amazon"
        ? "amazon.nova-2-sonic-v1:0"
        : provider === "local"
          ? "local-qwen3-greek"
          : provider === "fish"
            ? "drama-3"
            : config.voiceTranscriptionModel || "gpt-live-1";
    const model = input.model?.trim() || defaultModel;
    try {
      const result = await setupOwnerVoiceRuntime.call(request.user.id, {
        provider,
        transport: input.transport,
        offerSdp: input.offerSdp,
        model,
        language: input.language,
        delay: input.delay ?? config.voiceTranscriptionDelay,
        voice: input.voice ?? (provider === "google" ? "Aoede" : provider === "amazon" ? "en-US-Jenny" : config.voiceTranscriptionVoice),
        opening: input.opening,
        prompt: input.prompt,
        delegatedModel: input.delegatedModel,
        delegatedType: input.delegatedType,
        delegatedReasoningEffort: input.delegatedReasoningEffort,
        delegatedWebSearch: input.delegatedWebSearch,
        delegatedPrompt: input.delegatedPrompt,
        tools: input.tools,
        safetyIdentifier: request.user ? createHash("sha256").update(`space:${request.user.id}`).digest("hex") : null
      });

      // If the provider returned an external WebSocket URL (Google, Vercel, Amazon),
      // create a proxy session so the browser connects to Space API which relays to the provider.
      if (result.websocketUrl && (provider === "google" || provider === "vercel" || provider === "amazon" || provider === "fish")) {
        const proxySessionId = pendingVoiceWsSessions.create({
          ownerId: request.user.id,
          // Bind the one-shot ticket to the browser's validated Origin.  On
          // the public path this differs from the API's internal derived
          // origin, and the subsequent WebSocket upgrade must use the same
          // browser value or it is rejected as session_not_found.
          origin: requestOrigin,
          wsUrl: result.websocketUrl,
          token: result.token,
          subprotocols: provider === "vercel" && result.token ? ["ai-gateway-realtime.v1", `ai-gateway-auth.${result.token}`] : undefined,
          provider
        });
        result.websocketUrl = `/api/voice/ws-proxy/${proxySessionId}`;
        // These credentials are only needed by the server-side relay.
        delete result.token;
        request.log.info({ proxySessionId, provider, event: "voice_ws_proxy_created" }, "Created voice WS proxy session");
      }

      await recordAudit(store, request, {
        action: "voice.realtime.call",
        targetType: "voice_realtime_session",
        targetId: request.requestIdForSpace,
        metadata: {
          provider,
          model,
          language: input.language,
          delay: input.delay ?? config.voiceTranscriptionDelay,
          voice: input.voice ?? config.voiceTranscriptionVoice
        }
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Voice Realtime call failed.";
      request.log.warn({ provider, model, requestId: request.requestIdForSpace, err: message }, "voice realtime call failed");
      return sendApiError(reply, 502, "VOICE_REALTIME_CALL_FAILED", message);
    }
  });
  app.post("/api/voice/client-error", defaultRouteRateLimitOptions, async (request) => {
    request.log.warn({ requestId: request.requestIdForSpace, event: "voice_client_error" }, "Live voice client error reported");
    return { ok: true };
  });
  const classifyLiveRequest = async (ownerId: string, input: { query: string; roomId?: string; explicitModel?: string }, room: Room | null, shortcut = false, signal?: AbortSignal) => {
    const context = room ? { id: room.id, name: room.name, description: room.description,
      panes: (await store.listPanes(room.id)).filter(pane => !pane.isClosed).slice(0, 16)
        .map(pane => ({ id: pane.id, title: pane.title, runtimeId: pane.terminalRuntimeId, status: pane.status,
          configuredModelId: pane.modelId, reasoningEffort: pane.reasoningEffort })) } : null;
    const request = { ownerId, roomId: room?.id ?? "", query: input.query, explicitModel: input.explicitModel,
      context, contextRevision: createHash("sha256").update(JSON.stringify(context)).digest("hex"),
      policyRevision: createHash("sha256").update(JSON.stringify(config.liveModelPolicy)).digest("hex") };
    return shortcut ? decisionsService.classifyLiveRead(request, signal) : decisionsService.classifyLiveIntent(request);
  };
  app.post("/api/voice/realtime/delegate", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user || request.user.automationScope || request.user.proofScope === "READ_ONLY") {
      return sendApiError(reply, 403, "VOICE_OWNER_REQUIRED", "An authenticated interactive owner is required.");
    }
    const input = parseBody(voiceRealtimeDelegateRequestSchema, request.body);
    const room = input.roomId ? await assertRoomAccess(input.roomId, request.user) : null;
    const dailyBudget = config.liveModelPolicy.dailyBudgetUsd;
    if (dailyBudget != null) {
      const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
      const summary = summarizeVoiceDelegationCosts(await store.listAuditEvents(), request.user.id, sinceMs);
      if (isVoiceDailyBudgetExceeded(summary, dailyBudget)) {
        return sendApiError(reply, 429, "VOICE_DAILY_BUDGET_EXCEEDED", "The configured daily voice delegation budget has been reached.");
      }
    }
    try {
      const result = await routeLiveDelegation({ enabled: config.liveJevAccelerationEnabled, roomId: room?.id, tools: input.tools,
        classify: signal => classifyLiveRequest(request.user!.id, input, room, true, signal),
        delegate: signal => createVoiceDelegateResponse(config, input, signal) });
      try {
        await recordAudit(store, request, {
          action: "voice.realtime.delegate",
          targetType: "voice_delegate",
          targetId: request.requestIdForSpace,
          metadata: { telemetry: result.telemetry ?? null, roomId: input.roomId ?? null }
        });
      } catch (auditError) {
        request.log.warn({ requestId: request.requestIdForSpace, error: auditError instanceof Error ? auditError.message : "audit_failed" }, "voice delegation audit persistence failed");
      }
      request.log.info({ hasToolCall: Boolean(result.toolCall), hasMessage: Boolean(result.message), telemetry: result.telemetry ?? null }, "voice realtime delegate resolved");
      return voiceRealtimeDelegateResponseSchema.parse(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Voice delegation failed.";
      request.log.warn({ requestId: request.requestIdForSpace }, "voice delegation failed");
      return sendApiError(reply, 502, "VOICE_DELEGATION_FAILED", message);
    }
  });
  app.get("/api/voice/realtime/costs", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user || request.user.automationScope || request.user.proofScope === "READ_ONLY") {
      return sendApiError(reply, 403, "VOICE_OWNER_REQUIRED", "An authenticated interactive owner is required.");
    }
    const sinceRaw = typeof (request.query as { since?: unknown })?.since === "string" ? (request.query as { since: string }).since : null;
    const sinceMs = sinceRaw ? Date.parse(sinceRaw) : Date.now() - 24 * 60 * 60 * 1000;
    const events = await store.listAuditEvents();
    const summary = summarizeVoiceDelegationCosts(events, request.user.id, Number.isFinite(sinceMs) ? sinceMs : Date.now() - 24 * 60 * 60 * 1000);
    return { since: new Date(Number.isFinite(sinceMs) ? sinceMs : Date.now() - 24 * 60 * 60 * 1000).toISOString(), ...summary,
      dailyBudgetUsd: config.liveModelPolicy.dailyBudgetUsd,
      remainingBudgetUsd: config.liveModelPolicy.dailyBudgetUsd == null || summary.knownCostCalls === 0 ? null : Math.max(0, config.liveModelPolicy.dailyBudgetUsd - summary.estimatedCostUsd) };
  });
  // Jev is an optional, low-cost classifier only. It never authorizes a tool,
  // selects an unallowlisted model, or replaces the provider delegate.
  app.post("/api/voice/realtime/triage", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user || request.user.automationScope || request.user.proofScope === "READ_ONLY") {
      return sendApiError(reply, 403, "VOICE_OWNER_REQUIRED", "An authenticated interactive owner is required.");
    }
    const input = parseBody(z.object({ query: z.string().trim().min(1).max(5000), roomId: z.string().min(1).max(120).optional(), explicitModel: z.string().max(200).optional() }).strict(), request.body);
    const room = input.roomId ? await assertRoomAccess(input.roomId, request.user) : null;
    const result = await classifyLiveRequest(request.user.id, input, room);
    request.log.info({ event: "live_jev_triage", available: result.available, latencyMs: result.latencyMs, cacheHit: result.cacheHit, intent: result.intent, complexity: result.complexity, toolFamily: result.toolFamily }, "Live intent classified");
    return result;
  });
  // The catalog is operator configuration, not a hard-coded price list. An
  // empty catalog is an honest response and leaves provider selection to the
  // explicit user/session choice.
  app.get("/api/voice/realtime/policy", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user || request.user.automationScope || request.user.proofScope === "READ_ONLY") {
      return sendApiError(reply, 403, "VOICE_OWNER_REQUIRED", "An authenticated interactive owner is required.");
    }
    return config.liveModelPolicy;
  });
  app.get("/api/voice/ws-proxy/:sessionId", defaultWebsocketRateLimitOptions, (clientSocket, request) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    if (!request.user || request.user.automationScope || request.user.proofScope === "READ_ONLY") { clientSocket.close(4403, "voice_owner_required"); return; }
    const origin = request.headers.origin || `${request.protocol}://${request.host}`;
    const session = pendingVoiceWsSessions.take(sessionId, request.user.id, origin);
    if (!session) {
      clientSocket.close(4404, "session_not_found");
      return;
    }
    if (session.provider === "fish") {
      const stop = bridgeFishVoice(clientSocket, { apiKey: session.token ?? "", onClose: (metadata) => {
        activeVoiceProxies.delete(stop);
        request.log.info({ sessionId, provider: session.provider, ...metadata, event: "voice_ws_proxy_closed" }, "Voice relay closed");
      } });
      activeVoiceProxies.add(stop);
      return;
    }
    try {
      const upstream = new WsClient(session.wsUrl, session.subprotocols || [], {
        maxPayload: voiceProxyLimits.maxFrameBytes,
        handshakeTimeout: voiceProxyLimits.connectTimeoutMs,
        ...(session.token && !session.subprotocols?.length ? { headers: { Authorization: `Bearer ${session.token}` } } : {})
      });
      const stop = relayVoiceSockets(clientSocket, upstream, { onClose: (metadata) => {
        activeVoiceProxies.delete(stop);
        request.log.info({ sessionId, provider: session.provider, ...metadata, event: "voice_ws_proxy_closed" }, "Voice relay closed");
      } });
      activeVoiceProxies.add(stop);
    } catch {
      clientSocket.close(1011, "voice_upstream_unavailable");
    }
  });
}

/** Realtime voice attachments; the parent retains authentication, CSRF, errors and rate limits. */
export function registerVoiceAttachmentRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { config, store, routeOptions: defaultRouteRateLimitOptions } = options;
  app.post("/api/voice/realtime/attachments", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.isMultipart()) {
      return sendApiError(reply, 400, "BAD_REQUEST", "Live attachments must use multipart/form-data.");
    }
    let model = "gpt-4o-mini";
    let prompt = "";
    let provider = "";
    return withStagedUploads(request, config.browserEvidenceArtifactRoot, {
      maxFiles: 1, fileBytes: 10 * 1024 * 1024,
      onField(name, value) {
        if (typeof value !== "string") return;
        if (name === "model") model = value.trim().slice(0, 120) || model;
        if (name === "prompt") prompt = value.slice(0, 10000);
        if (name === "provider") provider = value.trim().slice(0, 60);
      }
    }, async uploads => {
      const upload = uploads[0]!;
      const mimeType = upload.declaredMimeType;
      if (!["image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain"].includes(mimeType)) {
        return sendApiError(reply, 422, "UNSUPPORTED_MEDIA_TYPE", "Only images, PDF, and plain text attachments are supported.");
      }
      if (mimeType.startsWith("image/") && sniffImageMime(upload.sample) !== mimeType) {
        return sendApiError(reply, 422, "UNSUPPORTED_MEDIA_TYPE", "Uploaded image bytes do not match the declared image type.");
      }
      const file = { buffer: await readStagedUpload(config.browserEvidenceArtifactRoot, upload), mimeType, filename: upload.filename };
      try {
        const result = await createVoiceAttachmentResponse(config, { ...file, model, prompt, provider });
        await recordAudit(store, request, {
          action: "voice.realtime.attachment",
          targetType: "voice_realtime_attachment",
          targetId: request.requestIdForSpace,
          metadata: { mimeType: file.mimeType, byteSize: file.buffer.byteLength, model }
        });
        return result;
      } catch (err) {
        return sendApiError(reply, 502, "VOICE_ATTACHMENT_FAILED", err instanceof Error ? err.message : "Attachment analysis failed.");
      }
    });
  });
}
