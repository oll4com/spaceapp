import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getSetupDependencyClosure, setupClientRuntimeFeatureSchema, setupClientRuntimeObservationSchema,
  type SetupClientRuntimeFeatureId, type SetupClientRuntimeChallenge } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { SetupCapabilityChecks } from "./setup-production-actions.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = () => new Error("The selected browser runtime check is missing, stale or incomplete.");

export async function setupClientRuntimeBuildId(): Promise<string> {
  const digest = createHash("sha256").update(await readFile(new URL(import.meta.url)));
  // Production entrypoints refer to hashed bundles. Source execution must not trust an older dist.
  const entries = new URL(import.meta.url).pathname.endsWith(".ts") ? [
    "../../web/src/features/setup-connections/setup-client-runtime-check.ts",
    "../../web/src/features/osk-keyboard/OnScreenKeyboard.tsx",
    "../../web/src/features/asteroids/engine.ts",
    "../../web/src/features/asteroids/render.ts",
    "../../web/src/features/vibe-music/youtubePlaylistPlayer.ts"
  ] : ["../../web/dist/index.html"];
  for (const entry of entries) digest.update(await readFile(new URL(entry, import.meta.url)));
  return digest.digest("hex");
}

/** Owner-reported browser observations, not cryptographic attestation; retains no content or playback history. */
export class SetupClientRuntimeVerification {
  private checks = new Map<string, { ownerId: string; featureId: SetupClientRuntimeFeatureId; fingerprint: string; challenge: string; expires: number }>();
  constructor(private readonly store: SpaceStore, private readonly buildId: string) {}
  private id(ownerId: string, featureId: string) { return `setup:client:${hash(ownerId).slice(0, 24)}:${featureId.replace(":", "-")}`; }
  private async subject(ownerId: string, featureId: SetupClientRuntimeFeatureId) {
    const actor = await this.store.getControlActor(ownerId);
    const state = await this.store.getSetupExecutionState(ownerId);
    const draft = state?.draft;
    if (actor?.role !== "ADMIN" || !draft || !getSetupDependencyClosure(draft.requestedFeatureIds).includes(featureId)) throw fail();
    return { revision: draft.revision, active: state!.runs.some(run => ["RUNNING", "PAUSED", "WAITING_FOR_INPUT"].includes(run.status)),
      fingerprint: hash(JSON.stringify(["client-runtime:v1", this.buildId, ownerId, featureId, draft.id, draft.revision, draft.catalogVersion])) };
  }
  async begin(ownerId: string, featureId: SetupClientRuntimeFeatureId, revision: number): Promise<SetupClientRuntimeChallenge> {
    const subject = await this.subject(ownerId, featureId);
    if (subject.revision !== revision || subject.active) throw fail();
    for (const [id, check] of this.checks) if (check.expires <= Date.now() || check.ownerId === ownerId && check.featureId === featureId) this.checks.delete(id);
    if (this.checks.size >= 64) throw fail();
    const checkId = randomUUID(); const challenge = `SpaceApp-${randomBytes(16).toString("hex")}`;
    this.checks.set(checkId, { ownerId, featureId, challenge, fingerprint: subject.fingerprint, expires: Date.now() + 120_000 });
    return { checkId, featureId, challenge };
  }
  async complete(ownerId: string, checkId: string, observation: unknown) {
    const check = this.checks.get(checkId);
    if (!check || check.ownerId !== ownerId) throw fail();
    this.checks.delete(checkId);
    const observed = setupClientRuntimeObservationSchema.parse(observation);
    const subject = await this.subject(ownerId, check.featureId);
    if (check.expires <= Date.now() || observed.featureId !== check.featureId || subject.fingerprint !== check.fingerprint || subject.active) throw fail();
    if (observed.featureId === "utility:osk" && (observed.text !== check.challenge || observed.terminalData !== check.challenge)) throw fail();
    const now = new Date().toISOString();
    await this.store.upsertSetupConnectionVerification({ connectionId: this.id(ownerId, check.featureId), state: "CONNECTED",
      fingerprintHash: subject.fingerprint, verifiedAt: now, updatedAt: now, reasonCode: null });
  }
  async cancel(ownerId: string, checkId: string) { if (this.checks.get(checkId)?.ownerId === ownerId) this.checks.delete(checkId); }
  async currentFingerprint(ownerId: string, featureId: SetupClientRuntimeFeatureId): Promise<string | null> {
    const saved = await this.store.getSetupConnectionVerification(this.id(ownerId, featureId));
    const age = saved?.verifiedAt ? Date.now() - Date.parse(saved.verifiedAt) : Infinity;
    if (saved?.state !== "CONNECTED" || age < 0 || age >= 600_000) return null;
    try { const current = await this.subject(ownerId, featureId); return current.fingerprint === saved.fingerprintHash ? current.fingerprint : null; }
    catch { return null; }
  }
  capabilityChecks(): SetupCapabilityChecks {
    return Object.fromEntries(setupClientRuntimeFeatureSchema.options.map(featureId => [featureId, async (ownerId: string) => {
      const fingerprint = await this.currentFingerprint(ownerId, featureId);
      if (!fingerprint) throw fail();
      return fingerprint;
    }]));
  }
  close() { this.checks.clear(); }
}
export function registerSetupClientRuntimeRoutes(app: FastifyInstance, options: { verification: SetupClientRuntimeVerification; uiOrigin?: string }) {
  function owner(request: FastifyRequest) {
    const user = request.user;
    if (user?.role !== "ADMIN" || user.automationScope || user.proofScope === "READ_ONLY") return null;
    const expected = `${request.protocol}://${request.host}`;
    return request.headers.origin === expected || options.uiOrigin && request.headers.origin === options.uiOrigin ? user.id : null;
  }
  const denied = (reply: import("fastify").FastifyReply) => reply.code(403).send({ error: { code: "FORBIDDEN", message: "An interactive owner on this installation is required." } });
  const failed = (reply: import("fastify").FastifyReply) => reply.code(422).send({ error: { code: "SETUP_CLIENT_RUNTIME_CHECK_FAILED", message: "This browser tool did not pass its current check. Retry or remove it from your selection." } });
  const params = z.object({ id: z.uuid() }).strict();
  app.addHook("preClose", async () => { options.verification.close(); });
  app.post("/api/setup/client-runtime/checks", { bodyLimit: 1024, config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (request, reply) => {
    const ownerId = owner(request); if (!ownerId) return denied(reply);
    const input = z.object({ featureId: setupClientRuntimeFeatureSchema, draftRevision: z.number().int().nonnegative() }).strict().safeParse(request.body);
    if (!input.success) return failed(reply);
    try { return await options.verification.begin(ownerId, input.data.featureId, input.data.draftRevision); } catch { return failed(reply); }
  });
  app.post("/api/setup/client-runtime/checks/:id/complete", { bodyLimit: 1024 }, async (request, reply) => {
    const ownerId = owner(request); if (!ownerId) return denied(reply);
    const id = params.safeParse(request.params); if (!id.success) return failed(reply);
    try { await options.verification.complete(ownerId, id.data.id, request.body); return { verified: true }; } catch { return failed(reply); }
  });
  app.delete("/api/setup/client-runtime/checks/:id", async (request, reply) => {
    const ownerId = owner(request); if (!ownerId) return denied(reply);
    const id = params.safeParse(request.params); if (!id.success) return failed(reply);
    await options.verification.cancel(ownerId, id.data.id); return { cancelled: true };
  });
}
