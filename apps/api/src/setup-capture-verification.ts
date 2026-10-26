import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getSetupDependencyClosure } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

const fail = () => new Error("The selected capture check is missing, stale or incomplete.");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Retains only a short synthetic challenge; captured pixels never reach durable storage. */
export class SetupCaptureVerification {
  private checks = new Map<string, { ownerId: string; revision: number; expires: number; colors: string[] }>();
  constructor(private readonly store: SpaceStore) {}
  private id(ownerId: string) { return `setup:capture:${hash(ownerId).slice(0, 24)}`; }
  private async subject(ownerId: string) {
    const state = await this.store.getSetupExecutionState(ownerId); const draft = state?.draft;
    if (!draft || !getSetupDependencyClosure(draft.requestedFeatureIds).includes("utility:snip")) throw fail();
    return { revision: draft.revision, fingerprint: hash(JSON.stringify({ version: "capture-check:v1", ownerId,
      draftId: draft.id, revision: draft.revision, catalogVersion: draft.catalogVersion })) };
  }
  async begin(ownerId: string, revision: number) {
    if ((await this.subject(ownerId)).revision !== revision) throw fail();
    const state = await this.store.getSetupExecutionState(ownerId);
    if (state?.runs.some(run => ["RUNNING", "PAUSED", "WAITING_FOR_INPUT"].includes(run.status))) throw fail();
    for (const [id, check] of this.checks) if (check.expires <= Date.now() || check.ownerId === ownerId) this.checks.delete(id);
    if (this.checks.size >= 64) throw fail();
    const checkId = randomUUID(); const colors = Array.from({ length: 64 }, () => `#${randomBytes(3).toString("hex")}`);
    this.checks.set(checkId, { ownerId, revision, colors, expires: Date.now() + 120_000 });
    return { checkId, colors };
  }
  async cancel(ownerId: string, checkId: string) {
    if (this.checks.get(checkId)?.ownerId === ownerId) this.checks.delete(checkId);
  }
  async complete(ownerId: string, checkId: string, rgba: string) {
    const check = this.checks.get(checkId);
    if (!check || check.ownerId !== ownerId) throw fail();
    this.checks.delete(checkId);
    if (check.expires <= Date.now() || !/^[A-Za-z0-9+/]{5462}==$/.test(rgba)) throw fail();
    const subject = await this.subject(ownerId);
    if (subject.revision !== check.revision) throw fail();
    const bytes = Buffer.from(rgba, "base64"); if (bytes.length !== 32 * 32 * 4) throw fail();
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const color = check.colors[row * 8 + col]!;
      const at = ((row * 4 + 2) * 32 + col * 4 + 2) * 4;
      if (bytes[at + 3] !== 255) throw fail();
      for (let channel = 0; channel < 3; channel++) {
        const expected = parseInt(color.slice(1 + channel * 2, 3 + channel * 2), 16);
        if (Math.abs(bytes[at + channel]! - expected) > 12) throw fail();
      }
    }
    if ((await this.subject(ownerId)).fingerprint !== subject.fingerprint) throw fail();
    const now = new Date().toISOString();
    await this.store.upsertSetupConnectionVerification({ connectionId: this.id(ownerId), state: "CONNECTED",
      fingerprintHash: subject.fingerprint, verifiedAt: now, updatedAt: now, reasonCode: null });
  }
  async currentFingerprint(ownerId: string): Promise<string | null> {
    const saved = await this.store.getSetupConnectionVerification(this.id(ownerId));
    const age = saved?.verifiedAt ? Date.now() - Date.parse(saved.verifiedAt) : Infinity;
    if (saved?.state !== "CONNECTED" || age < 0 || age >= 600_000) return null;
    try { const subject = await this.subject(ownerId); return subject.fingerprint === saved.fingerprintHash ? subject.fingerprint : null; }
    catch { return null; }
  }
  close() { this.checks.clear(); }
}

export function registerSetupCaptureRoutes(app: FastifyInstance, options: { verification: SetupCaptureVerification; uiOrigin?: string }) {
  function actor(request: FastifyRequest) {
    const user = request.user;
    if (user?.role !== "ADMIN" || user.automationScope || user.proofScope === "READ_ONLY") return null;
    const expected = `${request.protocol}://${request.host}`;
    if (request.headers.origin !== expected && (!options.uiOrigin || request.headers.origin !== options.uiOrigin)) return null;
    return user.id;
  }
  const unavailable = (reply: import("fastify").FastifyReply) => reply.code(422).send({ error: {
    code: "SETUP_CAPTURE_CHECK_FAILED", message: "The capture test did not pass. Select this tab and try again, or remove Screen capture for now." } });
  const forbidden = (reply: import("fastify").FastifyReply) => reply.code(403).send({ error: {
    code: "FORBIDDEN", message: "An interactive owner on this Space installation is required." } });
  app.addHook("preClose", async () => { options.verification.close(); });
  app.post("/api/setup/capture/checks", { bodyLimit: 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const ownerId = actor(request); if (!ownerId) return forbidden(reply);
    const input = z.object({ draftRevision: z.number().int().nonnegative() }).strict().safeParse(request.body);
    if (!input.success) return unavailable(reply);
    try { return await options.verification.begin(ownerId, input.data.draftRevision); } catch { return unavailable(reply); }
  });
  app.post("/api/setup/capture/checks/:id/complete", { bodyLimit: 8192 }, async (request, reply) => {
    const ownerId = actor(request); if (!ownerId) return forbidden(reply);
    const id = z.object({ id: z.uuid() }).safeParse(request.params);
    const input = z.object({ rgba: z.string().length(5464) }).strict().safeParse(request.body);
    if (!id.success || !input.success) return unavailable(reply);
    try { await options.verification.complete(ownerId, id.data.id, input.data.rgba); return { verified: true }; } catch { return unavailable(reply); }
  });
  app.delete("/api/setup/capture/checks/:id", async (request, reply) => {
    const ownerId = actor(request); if (!ownerId) return forbidden(reply);
    const id = z.object({ id: z.uuid() }).safeParse(request.params); if (!id.success) return unavailable(reply);
    await options.verification.cancel(ownerId, id.data.id); return { cancelled: true };
  });
}
