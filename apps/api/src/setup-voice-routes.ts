import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SpaceStore } from "@space/runtime";
import { z } from "zod";
import { setupVoiceCredentialInput, type SetupVoiceCredentials } from "./setup-voice-credentials.js";
import type { SetupVoiceVerification } from "./setup-voice-verification.js";

export function registerSetupVoiceRoutes(app: FastifyInstance, options: { store: SpaceStore; credentials: SetupVoiceCredentials;
  verification?: SetupVoiceVerification; uiOrigin?: string;
  audit?: (request: FastifyRequest, providerId: string) => Promise<void> }) {
  const error = (reply: FastifyReply, status: number, code: string, message: string) => reply.status(status).send({ error: { code, message } });
  const sameOrigin = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    return !origin || origin === `${request.protocol}://${request.host}` || origin === options.uiOrigin;
  };
  async function selectedOwner(request: FastifyRequest, reply: FastifyReply) {
    if (request.user?.role !== "ADMIN" || request.user.automationScope || request.user.proofScope === "READ_ONLY") {
      error(reply, 403, "FORBIDDEN", "An interactive owner is required for Live setup."); return null;
    }
    const state = await options.store.getSetupExecutionState(request.user.id);
    if (!state?.draft?.requestedFeatureIds.includes("pane:live")) {
      error(reply, 409, "SETUP_LIVE_NOT_SELECTED", "Select Live audio before configuring its connection."); return null;
    }
    return request.user.id;
  }
  app.get("/api/setup/voice/providers", async (request, reply) => {
    const ownerId = await selectedOwner(request, reply);
    if (!ownerId) return;
    try { return { providers: await options.credentials.providers(ownerId) }; }
    catch { return error(reply, 503, "SETUP_VOICE_CREDENTIAL_UNAVAILABLE", "The secure voice connection store is unavailable."); }
  });
  app.post("/api/setup/voice/credentials", { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const ownerId = await selectedOwner(request, reply);
    if (!ownerId) return;
    const state = await options.store.getSetupExecutionState(ownerId);
    if (state?.runs.some(run => ["RUNNING", "PAUSED", "WAITING_FOR_INPUT"].includes(run.status))) {
      return error(reply, 409, "SETUP_RUN_ACTIVE", "Finish or revise the active setup before changing its voice connection.");
    }
    const input = setupVoiceCredentialInput.safeParse(request.body);
    if (!input.success) return error(reply, 422, "SETUP_VOICE_CREDENTIAL_INVALID", "Enter the required credential fields for this voice provider.");
    try {
      const result = await options.credentials.save(ownerId, input.data);
      await options.audit?.(request, input.data.providerId);
      return { ...result, configured: true };
    } catch { return error(reply, 503, "SETUP_VOICE_CREDENTIAL_UNAVAILABLE", "The voice credential could not be saved securely."); }
  });
  app.post("/api/setup/voice/checks", { bodyLimit: 1024 }, async (request, reply) => {
    const ownerId = await selectedOwner(request, reply);
    if (!ownerId) return;
    if (!sameOrigin(request)) return error(reply, 403, "SETUP_VOICE_ORIGIN_INVALID", "Audio checks require a same-origin request.");
    const input = z.object({ draftRevision: z.number().int().nonnegative() }).strict().safeParse(request.body);
    if (!input.success || !options.verification) return error(reply, 422, "SETUP_VOICE_CHECK_UNAVAILABLE", "A current compatible voice connection is required.");
    try { return await options.verification.begin(ownerId, input.data.draftRevision); }
    catch { return error(reply, 422, "SETUP_VOICE_CHECK_FAILED", "The selected voice service could not start its audio check. Review the connection and try again."); }
  });
  if (options.verification) {
    const verification = options.verification;
    app.addHook("preClose", async () => { verification.close(); });
    app.get("/api/setup/voice/checks/:id/audio", { websocket: true }, (socket, request) => {
      const id = z.object({ id: z.uuid() }).safeParse(request.params);
      if (!id.success || request.user?.role !== "ADMIN" || request.user.automationScope || request.user.proofScope === "READ_ONLY" ||
        !request.headers.origin || !sameOrigin(request)) { socket.close(1008, "audio_check_forbidden"); return; }
      void verification.attach(request.user.id, id.data.id, socket).catch(() => { socket.close(1011, "audio_check_failed"); });
    });
  }
}
