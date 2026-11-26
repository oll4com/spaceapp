import type { FastifyInstance, FastifyRequest } from "fastify";
import { nousLiveRealtimeExchangeInputSchema, nousLiveRealtimeToolInputSchema, nousLiveSessionInputSchema, nousLiveTurnInputSchema, nousLiveVoiceChoiceSchema } from "@space/contracts";
import { WebSocket as WsClient } from "ws";
import type { z } from "zod";
import { voiceProxyLimits } from "../../voice-ws-proxy.js";
import { bridgeNousLive, type NousLiveRelayTickets } from "./relay.js";
import type { NousLive, NousLiveCaller } from "./service.js";

/** Nous Live's routes (plan clipboard:f5TgJ4IIJF1m): the person only, as a message to Nous is (MOBILE_ROUTE_SCOPES actPerson). */
export function registerNousLiveRoutes(app: FastifyInstance, live: NousLive, deps: {
  routeOptions: Record<string, unknown>;
  owner(request: FastifyRequest): Promise<string>;
  assertPerson(request: FastifyRequest): void;
  parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T>;
  /** The voice relay for the providers the app cannot reach itself (relay.ts); a public path, the one-use ticket is the authentication. */
  relay?: { tickets: NousLiveRelayTickets; websocketRouteOptions: Record<string, unknown> & { websocket: true }; audit(provider: string, code: number): void };
}) {
  const caller = async (request: FastifyRequest): Promise<NousLiveCaller> => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    const device = request.mobileDevice ?? null;
    return { owner, device: device?.id ?? null, ...(device ? { mobile: { device: device.id, scopes: device.scopes } } : {}) };
  };
  app.post("/api/nous/live/sessions", deps.routeOptions, async (request) => {
    deps.parseBody(nousLiveSessionInputSchema, request.body ?? {});
    return live.start(await caller(request));
  });
  app.post("/api/nous/live/turns", deps.routeOptions, async (request) => live.turn(await caller(request), deps.parseBody(nousLiveTurnInputSchema, request.body)));
  // Its voice picker (the choice is saved through PATCH /api/nous/live/voice or PATCH /api/nous/settings `liveVoice`) and realtime sessions (nous_msg:7f739948).
  app.get("/api/nous/live/voice", deps.routeOptions, async (request) => live.voiceOptions(await deps.owner(request)));
  app.patch("/api/nous/live/voice", deps.routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const choice = deps.parseBody(nousLiveVoiceChoiceSchema, request.body);
    return { choice: await live.setVoiceChoice(owner, choice) };
  });
  app.post("/api/nous/live/realtime", deps.routeOptions, async (request) => {
    deps.parseBody(nousLiveSessionInputSchema, request.body ?? {});
    return live.realtime(await caller(request));
  });
  app.post("/api/nous/live/realtime/tool", deps.routeOptions, async (request) => live.realtimeTool(await caller(request), deps.parseBody(nousLiveRealtimeToolInputSchema, request.body)));
  app.post("/api/nous/live/realtime/exchange", deps.routeOptions, async (request) => live.realtimeExchange(await caller(request), deps.parseBody(nousLiveRealtimeExchangeInputSchema, request.body)));
  if (!deps.relay) return;
  const { tickets, websocketRouteOptions, audit } = deps.relay;
  const active = new Set<() => void>();
  app.addHook("preClose", async () => { tickets.clear(); for (const stop of active) stop(); active.clear(); });
  app.get("/api/nous/live/relay/:ticket", websocketRouteOptions, (phone, request) => {
    const entry = tickets.take(String((request.params as { ticket?: unknown }).ticket ?? ""));
    if (!entry) { phone.close(4404, "session_not_found"); return; }
    try {
      const upstream = new WsClient(entry.upstream.url, entry.upstream.protocols ?? [], { maxPayload: voiceProxyLimits.maxFrameBytes, handshakeTimeout: voiceProxyLimits.connectTimeoutMs });
      const stop = bridgeNousLive(phone, upstream, entry.plan, ({ provider, code }) => { active.delete(stop); audit(provider, code); });
      active.add(stop);
    } catch {
      phone.close(1011, "voice_upstream_unavailable");
    }
  });
}
