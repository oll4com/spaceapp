import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getSetupDependencyClosure, type SetupFeatureId, type SetupDraft } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

export type SetupSelectedServices = Partial<Record<SetupFeatureId, {
  list: (ownerId: string) => Promise<Array<{ id: string; label: string }>>;
  /** Fixed, nonmutating check of an existing authorized target; returns no secret or content. */
  inspect: (ownerId: string, choiceId: string) => Promise<string>;
}>>;
const featureSchema = z.enum(["pane:databases", "pane:vnc", "pane:harness", "dock:streaming"]);
const paramsSchema = z.object({ featureId: featureSchema });
const choiceSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/), label: z.string().min(1).max(100) }).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = () => new Error("Select an authorized target and complete its current connection check.");

export class SetupSelectedServiceVerification {
  constructor(private readonly store: SpaceStore, readonly services: SetupSelectedServices) {}
  private id(ownerId: string, featureId: SetupFeatureId) { return `setup:service:${hash(ownerId).slice(0, 24)}:${featureId.replace(":", "-")}`; }
  async choices(ownerId: string, featureId: SetupFeatureId) {
    const probe = this.services[featureId]; if (!probe) throw fail();
    const choices = z.array(choiceSchema).max(100).parse(await probe.list(ownerId));
    if (new Set(choices.map(choice => choice.id)).size !== choices.length) throw fail();
    return choices;
  }
  private async subject(ownerId: string, featureId: SetupFeatureId): Promise<{ draft: SetupDraft; fingerprint: string; choiceId: string }> {
    const state = await this.store.getSetupExecutionState(ownerId); const draft = state?.draft;
    const choiceId = draft?.connectionChoices.find(choice => choice.featureId === featureId)?.modelId;
    if (!draft || !getSetupDependencyClosure(draft.requestedFeatureIds).includes(featureId) || !choiceId || !(await this.choices(ownerId, featureId)).some(choice => choice.id === choiceId)) throw fail();
    const inspected = await this.services[featureId]!.inspect(ownerId, choiceId);
    if (!/^[a-f0-9]{64}$/.test(inspected)) throw fail();
    return { draft, choiceId, fingerprint: hash(JSON.stringify({ version: "selected-service:v1", ownerId,
      draftId: draft.id, revision: draft.revision, featureId, choiceId, inspected })) };
  }
  async check(ownerId: string, featureId: SetupFeatureId, revision: number, choiceId: string) {
    const state = await this.store.getSetupExecutionState(ownerId);
    // Validate the exact choice before any target probe.
    if (state?.draft?.revision !== revision || state.draft.connectionChoices.find(choice => choice.featureId === featureId)?.modelId !== choiceId ||
      state.runs.some(run => ["RUNNING", "PAUSED", "WAITING_FOR_INPUT"].includes(run.status))) throw fail();
    const subject = await this.subject(ownerId, featureId);
    if ((await this.store.getSetupExecutionState(ownerId))?.draft?.revision !== revision) throw fail();
    const now = new Date().toISOString();
    await this.store.upsertSetupConnectionVerification({ connectionId: this.id(ownerId, featureId), state: "CONNECTED",
      fingerprintHash: subject.fingerprint, verifiedAt: now, updatedAt: now, reasonCode: null });
  }
  async currentFingerprint(ownerId: string, featureId: SetupFeatureId): Promise<string | null> {
    const saved = await this.store.getSetupConnectionVerification(this.id(ownerId, featureId));
    const age = saved?.verifiedAt ? Date.now() - Date.parse(saved.verifiedAt) : Infinity;
    if (saved?.state !== "CONNECTED" || age < 0 || age >= 10 * 60_000) return null;
    try { const subject = await this.subject(ownerId, featureId); return saved.fingerprintHash === subject.fingerprint ? subject.fingerprint : null; }
    catch { return null; }
  }
}
export function registerSetupSelectedServiceRoutes(app: FastifyInstance, options: {
  store: SpaceStore; verification: SetupSelectedServiceVerification;
  audit?: (request: FastifyRequest, action: string, targetId: string) => Promise<void>;
}) {
  async function selected(request: FastifyRequest, featureId: SetupFeatureId) {
    if (request.user?.role !== "ADMIN" || request.user.automationScope || request.user.proofScope === "READ_ONLY") return { forbidden: true as const };
    const state = await options.store.getSetupExecutionState(request.user.id);
    return state?.draft && getSetupDependencyClosure(state.draft.requestedFeatureIds).includes(featureId) ? { ownerId: request.user.id } : {};
  }
  app.get("/api/setup/services/:featureId/choices", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(422).send({ error: { code: "SETUP_SERVICE_UNSUPPORTED", message: "This service is not supported by setup." } });
    const actor = await selected(request, params.data.featureId);
    if ("forbidden" in actor) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "An interactive owner is required." } });
    if (!actor.ownerId) return reply.code(422).send({ error: { code: "SETUP_SERVICE_NOT_SELECTED", message: "Select this tool before connecting it." } });
    try { return { choices: await options.verification.choices(actor.ownerId, params.data.featureId) }; }
    catch { return reply.code(422).send({ error: { code: "SETUP_SERVICE_UNAVAILABLE", message: "Authorized service connections could not be loaded." } }); }
  });
  app.post("/api/setup/services/:featureId/check", { bodyLimit: 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const input = z.object({ draftRevision: z.number().int().nonnegative(), choiceId: choiceSchema.shape.id }).strict().safeParse(request.body);
    if (!params.success || !input.success) return reply.code(422).send({ error: { code: "SETUP_SERVICE_CHECK_INVALID", message: "Choose an existing authorized connection." } });
    const actor = await selected(request, params.data.featureId);
    if ("forbidden" in actor) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "An interactive owner is required." } });
    if (!actor.ownerId) return reply.code(422).send({ error: { code: "SETUP_SERVICE_NOT_SELECTED", message: "Select this tool before connecting it." } });
    try {
      await options.verification.check(actor.ownerId, params.data.featureId, input.data.draftRevision, input.data.choiceId);
      await options.audit?.(request, "setup.v2.service.verified", params.data.featureId);
      return { verified: true };
    } catch { return reply.code(422).send({ error: { code: "SETUP_SERVICE_CHECK_FAILED", message: "The selected connection did not pass its current check. Review it and try again." } }); }
  });
}

export function createSetupSelectedServiceAdapters(options: {
  databases: Pick<import("./databases/databases-service.js").DatabasesService, "listConnections" | "getConnection" | "getAdapter">;
  streaming?: Pick<import("./streaming-service.js").StreamingService, "catalog" | "verifyAccount" | "connectionFingerprint">;
}): SetupSelectedServices {
  const actor = (id: string) => ({ id, role: "ADMIN" });
  return {
    ...(options.streaming ? { "dock:streaming": {
      list: async () => {
        const catalog = await options.streaming!.catalog();
        const activeGrants = new Set(catalog.authorizations.filter(grant => grant.status === "ACTIVE").map(grant => grant.id));
        return catalog.accounts.filter(account => account.status !== "DISCONNECTED" && activeGrants.has(account.authorizationId))
          .map(account => ({ id: account.id, label: `${account.provider} · ${account.displayName}`.slice(0, 100) }));
      },
      inspect: async (_ownerId: string, choiceId: string) => {
        const { account } = await options.streaming!.verifyAccount(choiceId);
        if (account.id !== choiceId || account.status !== "ACTIVE") throw fail();
        return options.streaming!.connectionFingerprint(choiceId);
      }
    } } : {}),
    "pane:databases": {
      list: async (ownerId) => (await options.databases.listConnections(actor(ownerId), null, "user"))
        .filter(connection => connection.isInternal || connection.ownerUserId === ownerId)
        .map(connection => ({ id: connection.id, label: connection.isInternal ? "SpaceApp database (read-only check)" : connection.name })),
      inspect: async (ownerId, choiceId) => {
        const connection = await options.databases.getConnection(choiceId, actor(ownerId), "user");
        if (!connection.isInternal && connection.ownerUserId !== ownerId) throw fail();
        const adapter = await options.databases.getAdapter(choiceId, actor(ownerId), "user");
        const result = await adapter.executeSql({ sql: "SELECT 1 AS spaceapp_setup_check", limit: 1 });
        if (result.rowCount !== 1 || Number(result.rows[0]?.spaceapp_setup_check) !== 1) throw fail();
        return hash(JSON.stringify({ id: connection.id, owner: connection.ownerUserId, engine: connection.engine,
          host: connection.host, port: connection.port, database: connection.database, username: connection.username,
          ssl: connection.ssl, filename: connection.filename, isReadOnly: connection.isReadOnly,
          updatedAt: connection.isInternal ? null : connection.updatedAt }));
      }
    }
  };
}
