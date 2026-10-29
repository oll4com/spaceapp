import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import { SetupVoiceCredentials } from "../src/setup-voice-credentials.js";
import { getApiConfig } from "../src/config.js";
import * as verification from "../src/setup-voice-verification.js";
import Fastify from "fastify";
import { registerSetupExecutionRoutes } from "../src/setup-execution-routes.js";

describe("server owned Local voice audio check", () => {
  it("requires observed input, provider transcript, output and playback before issuing a current owner scoped proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-voice-proof-"));
    let receivedToken = "";
    const provider = createServer((request, response) => {
      receivedToken = String(request.headers["x-local-voice-token"]);
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ websocket_url: "/audio" }));
    });
    const providerWs = new WebSocketServer({ server: provider });
    providerWs.on("connection", socket => socket.on("message", (_data, binary) => {
      if (!binary) return;
      socket.send(JSON.stringify({ type: "user_transcript", text: "test speech" }));
      socket.send(Buffer.alloc(12_800, 10));
    }));
    provider.listen(0, "127.0.0.1"); await once(provider, "listening");
    const address = provider.address() as { port: number };
    const config = getApiConfig({ SPACE_LOCAL_VOICE_PROVIDER_URL: `http://127.0.0.1:${address.port}` });
    const credentials = new SetupVoiceCredentials(root, config);
    const store = new InMemorySpaceStore();
    const coordinator = new SetupExecutionCoordinator(store);
    const { credentialRef } = await credentials.save("user:one", { providerId: "local", token: "private-owned-local-token" });
    const draft = await coordinator.updateDraft("user:one", null, { persona: "everyday", level: "balanced", requestedFeatureIds: ["pane:live"],
      connectionChoices: [{ featureId: "pane:live", providerId: "local", modelId: "local-qwen3-greek", voiceId: "default", credentialRef }] });
    const service = new verification.SetupVoiceVerification({ store, credentials, config });
    const setupApi = Fastify(); setupApi.decorateRequest("user", null);
    setupApi.addHook("preHandler", async request => { request.user = { id: "user:one", email: "owner@example.com", role: "ADMIN" }; });
    registerSetupExecutionRoutes(setupApi, { store, actionPumpEnabled: false, voiceFingerprint: ownerId => service.currentFingerprint(ownerId),
      connections: { overview: async () => [], verify: async () => { throw new Error("Not selected"); },
        verifyAll: async () => [], recordVerifiedEvidence: async () => { throw new Error("Not selected"); } } });
    const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(relay, "listening");
    let client: WebSocket | undefined;
    try {
      expect(await service.currentFingerprint("user:one")).toBeNull();
      const catalog = (await setupApi.inject({ method: "GET", url: "/api/setup/catalog" })).json();
      expect(catalog.features.find((feature: { id: string }) => feature.id === "pane:live").availability).toBe("INSTALLABLE");
      const pendingPlan = (await setupApi.inject({ method: "POST", url: "/api/setup/plan", payload: { draftRevision: draft.revision } })).json();
      expect(pendingPlan.requiredHumanInputs).toHaveLength(2);
      await expect(service.begin("user:two", draft.revision)).rejects.toThrow();
      const check = await service.begin("user:one", draft.revision);
      expect(receivedToken).toBe("private-owned-local-token");
      expect(JSON.stringify(check)).not.toContain("private-owned-local-token");
      relay.on("connection", socket => { void service.attach("user:one", check.checkId, socket); });
      client = new WebSocket(`ws://127.0.0.1:${(relay.address() as { port: number }).port}`);
      await once(client, "open");
      // A browser's playback assertion alone must never issue a receipt.
      client.send(JSON.stringify({ type: "playback-complete" }));
      expect(await service.currentFingerprint("user:one")).toBeNull();
      const output = new Promise<void>(resolve => client!.on("message", (_data, binary) => { if (binary) resolve(); }));
      const prematureOutput = new Promise<boolean>(resolve => {
        const observe = (_data: unknown, binary: boolean) => { if (binary) { clearTimeout(timeout); client!.off("message", observe); resolve(true); } };
        const timeout = setTimeout(() => { client!.off("message", observe); resolve(false); }, 200);
        client!.on("message", observe);
      });
      client.send(Buffer.alloc(12_800)); client.send(Buffer.alloc(128, 5));
      expect(await prematureOutput).toBe(false);
      client.send(Buffer.alloc(12_800, 5)); await output;
      expect(await service.currentFingerprint("user:one")).toBeNull();
      const verified = new Promise<void>(resolve => client!.on("message", (data, binary) => {
        if (!binary && JSON.parse(data.toString()).type === "verified") resolve();
      }));
      client.send(JSON.stringify({ type: "playback-complete", playedBytes: 12_800 })); await verified;
      expect(await service.currentFingerprint("user:one")).toMatch(/^[a-f0-9]{64}$/);
      const verifiedPlan = (await setupApi.inject({ method: "POST", url: "/api/setup/plan", payload: { draftRevision: draft.revision } })).json();
      expect(verifiedPlan.requiredHumanInputs).toEqual([]);
      expect(verifiedPlan.planDigest).not.toBe(pendingPlan.planDigest);
      expect(await service.currentFingerprint("user:two")).toBeNull();
      // A restart can inspect the durable proof; rotating a credential invalidates it.
      expect(await new verification.SetupVoiceVerification({ store, credentials, config }).currentFingerprint("user:one")).toMatch(/^[a-f0-9]{64}$/);
      await credentials.save("user:one", { providerId: "local", token: "rotated-owned-local-token" });
      expect(await service.currentFingerprint("user:one")).toBeNull();
      await coordinator.updateDraft("user:one", draft.revision, { persona: "everyday", level: "balanced", requestedFeatureIds: ["pane:live"],
        connectionChoices: [{ ...draft.connectionChoices[0]!, credentialRef: "cred:voice:foreign-owner:local" }] });
      await expect(service.begin("user:one", draft.revision + 1)).rejects.toThrow();
    } finally {
      service.close(); client?.terminate();
      await setupApi.close();
      for (const socket of relay.clients) socket.terminate(); for (const socket of providerWs.clients) socket.terminate();
      await new Promise<void>(resolve => relay.close(() => resolve()));
      await new Promise<void>(resolve => providerWs.close(() => resolve()));
      await new Promise<void>(resolve => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
