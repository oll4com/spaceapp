import { SetupSelectedServiceVerification, registerSetupSelectedServiceRoutes, type SetupSelectedServices } from "./setup-selected-services.js";
import { SetupCaptureVerification, registerSetupCaptureRoutes } from "./setup-capture-verification.js";
import { setupSelectionFromSettings } from "./setup-settings.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  SETUP_CATALOG, SETUP_CATALOG_VERSION, PUBLIC_SETUP_NATIVE_AGENTS, buildSetupSelection, getSetupDependencyClosure,
  setupConnectionChoiceSchema, setupFeatureIdSchema,
  type SetupAvailability, type SetupFeatureId, type SetupPlan, type SetupTask
} from "@space/contracts";
import { SetupActionRunner, SetupExecutionCoordinator, SetupExecutionError,
  type SetupActionAdapter, type SpaceStore } from "@space/runtime";
import type { SetupConnectionsService } from "./setup-connections.js";
import { readAuthenticatedInstallationHandoff } from "./installation-handoff.js";
import { readVerifiedFreeModel } from "./verified-free-model.js";
import { createProductionSetupActionAdapter, supportedSetupServices, type SetupCapabilityChecks, type SetupFunctionalChecks } from "./setup-production-actions.js";

const draftInput = z.object({
  expectedRevision: z.number().int().nonnegative().nullable(),
  persona: z.enum(["everyday", "creator", "developer"]),
  level: z.enum(["minimal", "balanced", "full"]),
  requestedFeatureIds: z.array(setupFeatureIdSchema).max(100),
  connectionChoices: z.array(setupConnectionChoiceSchema).max(40)
}).strict();
const planInput = z.object({ draftRevision: z.number().int().nonnegative() }).strict();
const runInput = z.object({
  planId: z.string().regex(/^plan:[a-zA-Z0-9._:-]{3,123}$/),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().regex(/^[a-z][a-z0-9._:-]{3,127}$/)
}).strict();
const runParams = z.object({ id: z.string().regex(/^run:[a-zA-Z0-9._:-]{3,123}$/) });
const eventQuery = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100)
}).strict();
const retryInput = z.object({
  taskIds: z.array(z.string().min(8).max(128)).min(1).max(100),
  expectedRunRevision: z.number().int().positive()
}).strict();
const reconcileInput = z.object({ taskId: z.string().min(8).max(128) }).strict();
const emptyInput = z.object({}).strict();

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message, requestId: reply.request.requestIdForSpace } });
}

function owner(request: FastifyRequest, reply: FastifyReply): string | null {
  if (request.user?.role === "ADMIN") return request.user.id;
  error(reply, 403, "FORBIDDEN", "Owner access is required.");
  return null;
}

function guard(reply: FastifyReply, cause: unknown) {
  if (cause instanceof SetupExecutionError) {
    const status = cause.code.endsWith("_NOT_FOUND") ? 404
      : cause.code === "SETUP_EVENT_CURSOR_EXPIRED" ? 410
        : ["SETUP_REVISION_CONFLICT", "SETUP_PLAN_STALE", "SETUP_RUN_ACTIVE", "SETUP_RUN_NOT_ACTIVE"].includes(cause.code) ? 409 : 422;
    return error(reply, status, cause.code, cause.message);
  }
  throw cause;
}

async function serverAvailability(connections: SetupConnectionsService, checkAgentSessions?: () => Promise<void>, capabilityChecks: SetupCapabilityChecks = {}, functionalChecks: SetupFunctionalChecks = {}, voiceSupported = false, selectedServices: SetupSelectedServices = {}): Promise<Partial<Record<SetupFeatureId, SetupAvailability>>> {
  const available: Partial<Record<SetupFeatureId, SetupAvailability>> = {};
  const observed = new Map((await connections.overview()).map((connection) => [connection.id, connection]));
  for (const feature of SETUP_CATALOG) {
    if (feature.kind === "agent" && process.env.SPACE_PUBLIC_DISTRIBUTION === "true" &&
        !PUBLIC_SETUP_NATIVE_AGENTS.includes(feature.id.slice(6))) available[feature.id] = "UNAVAILABLE";
    else if (feature.id === "utility:snip") available[feature.id] = "INSTALLABLE";
    else if (feature.id === "pane:live" && voiceSupported) available[feature.id] = "INSTALLABLE";
    else if (selectedServices[feature.id]) available[feature.id] = "INSTALLABLE";
    else if (functionalChecks[feature.id]) available[feature.id] = "INSTALLABLE";
    else if (capabilityChecks[feature.id]) available[feature.id] = "AVAILABLE";
    else if (supportedSetupServices.has(feature.id)) available[feature.id] =
      feature.id === "dock:agent-sessions" && !checkAgentSessions ? "UNAVAILABLE" : "AVAILABLE";
    else if (feature.id === "agent:opencode" || feature.id === "pane:chat") available[feature.id] = "INSTALLABLE";
    else if (feature.kind === "agent") {
      const connection = observed.get(`cli:${feature.id.slice(6)}`);
      available[feature.id] = connection?.state === "UNAVAILABLE" || !connection ? "UNAVAILABLE" : "INSTALLABLE";
    } else available[feature.id] = "UNAVAILABLE";
  }
  return available;
}

async function currentConnectionFingerprints(
  store: SpaceStore, connections: SetupConnectionsService, featureIds: readonly SetupFeatureId[], ownerId: string,
  voiceFingerprint?: (ownerId: string) => Promise<string | null>,
  serviceVerification?: SetupSelectedServiceVerification,
  captureFingerprint?: (ownerId: string) => Promise<string | null>
): Promise<Partial<Record<SetupFeatureId, string>>> {
  const observed = new Map((await connections.overview()).map((item) => [item.id, item]));
  const fingerprints: Partial<Record<SetupFeatureId, string>> = {};
  for (const featureId of getSetupDependencyClosure(featureIds)) {
    if (featureId === "utility:snip" && captureFingerprint) {
      const fingerprint = await captureFingerprint(ownerId);
      if (fingerprint) fingerprints[featureId] = fingerprint;
      continue;
    }
    if (featureId === "pane:live" && voiceFingerprint) {
      const fingerprint = await voiceFingerprint(ownerId);
      if (fingerprint) fingerprints[featureId] = fingerprint;
      continue;
    }
    if (serviceVerification?.services[featureId]) {
      const fingerprint = await serviceVerification.currentFingerprint(ownerId, featureId);
      if (fingerprint) fingerprints[featureId] = fingerprint;
      continue;
    }
    if (!featureId.startsWith("agent:")) continue;
    const connectionId = `cli:${featureId.slice(6)}`;
    const connection = observed.get(connectionId);
    if (connection?.functionalState !== "FUNCTIONAL" || connection.liveVerificationState !== "VERIFIED" || !connection.verifiedAt) continue;
    const saved = await store.getSetupConnectionVerification(connectionId);
    if (saved?.state === "CONNECTED" && saved.fingerprintHash && saved.verifiedAt) {
      fingerprints[featureId] = saved.fingerprintHash;
    }
  }
  return fingerprints;
}

export function registerSetupExecutionRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  uiOrigin?: string;
  connections: SetupConnectionsService;
  installationSecret?: string;
  memoryRoot?: string;
  handoffRoot?: string;
  actionAdapterFor?: (task: SetupTask, ownerId: string, plan: SetupPlan) => SetupActionAdapter | null;
  actionPumpEnabled?: boolean;
  checkAgentSessions?: () => Promise<void>;
  capabilityChecks?: SetupCapabilityChecks;
  functionalChecks?: SetupFunctionalChecks;
  voiceFingerprint?: (ownerId: string) => Promise<string | null>;
  selectedServices?: SetupSelectedServices;
  selectFreeModel?: (modelId: string) => Promise<void>;
  /** Whether this installation's OpenCode wrapper can apply a choice now (unset: whenever selectFreeModel is set). */
  freeModelSelectable?: () => Promise<boolean>;
  audit?: (request: FastifyRequest, action: string, targetId: string) => Promise<void>;
}) {
  const coordinator = new SetupExecutionCoordinator(options.store);
  const audit = options.audit ?? (async () => undefined);
  const captureVerification = new SetupCaptureVerification(options.store);
  const captureFingerprint = (ownerId: string) => captureVerification.currentFingerprint(ownerId);
  registerSetupCaptureRoutes(app, { verification: captureVerification, uiOrigin: options.uiOrigin });
  const serviceVerification = new SetupSelectedServiceVerification(options.store, options.selectedServices ?? {});
  registerSetupSelectedServiceRoutes(app, { store: options.store, verification: serviceVerification, audit });
  const pumping = new Map<string, Promise<void>>();
  function adapterFor(task: SetupTask, ownerId: string, plan: SetupPlan) {
    const serviceFeatureId = task.featureId === "widget:streaming-metrics" ? "dock:streaming" : task.featureId;
    return options.actionAdapterFor?.(task, ownerId, plan) ?? createProductionSetupActionAdapter({
      task, ownerId, plan, store: options.store, connections: options.connections,
      memoryRoot: options.memoryRoot ?? process.env.SPACE_MEMORY_ROOT,
      handoffRoot: options.handoffRoot ?? process.env.SPACE_INSTALLATION_HANDOFF_ROOT,
      installationSecret: options.installationSecret,
      checkAgentSessions: options.checkAgentSessions,
      capabilityChecks: options.capabilityChecks,
      functionalChecks: options.functionalChecks,
      voiceFingerprint: options.voiceFingerprint,
      captureFingerprint,
      selectedServiceFingerprint: serviceVerification.services[serviceFeatureId]
        ? (owner) => serviceVerification.currentFingerprint(owner, serviceFeatureId) : undefined
    });
  }
  function schedule(ownerId: string, runId: string) {
    if (options.actionPumpEnabled === false || pumping.has(runId)) return;
    const promise = Promise.resolve().then(async () => {
      const state = await coordinator.getState(ownerId);
      const run = state.runs.find((item) => item.id === runId);
      const plan = state.plans.find((item) => item.id === run?.planId);
      if (!run || !plan || run.status !== "RUNNING") return;
      const runner = new SetupActionRunner(coordinator, (task) => adapterFor(task, ownerId, plan));
      await runner.pump(ownerId, runId);
    }).catch((cause) => app.log.error({ err: cause, runId }, "First setup action pump failed."))
      .finally(() => { pumping.delete(runId); });
    pumping.set(runId, promise);
  }

  app.get("/api/setup/installation-handoff", async (request, reply) => {
    if (!owner(request, reply)) return;
    const handoff = await readAuthenticatedInstallationHandoff(options.handoffRoot ?? process.env.SPACE_INSTALLATION_HANDOFF_ROOT, options.installationSecret);
    return handoff ?? { modelId: null, completed: false };
  });

  app.get("/api/setup/free-model", async (request, reply) => {
    if (!owner(request, reply)) return;
    const modelId = await readVerifiedFreeModel(options.memoryRoot ?? process.env.SPACE_MEMORY_ROOT);
    return { choice: "AUTO_BEST_FREE", modelId, verified: modelId !== null };
  });

  const freeModelSelectable = async () => Boolean(options.selectFreeModel) && (options.freeModelSelectable ? await options.freeModelSelectable() : true);
  const needsAttention = "Needs attention: the selected free model did not complete a tool call. Your current model is unchanged.";
  let selectingModel = false;
  app.post("/api/setup/free-model", async (request, reply) => {
    const ownerId = owner(request, reply);
    if (!ownerId) return;
    const input = z.object({ modelId: z.string().regex(/^opencode\/[a-z0-9][a-z0-9._-]{0,100}$/).nullable() }).strict().safeParse(request.body);
    if (!input.success) return error(reply, 422, "SETUP_MODEL_UNAVAILABLE", "Choose a currently verified free model.");
    const handoff = await readAuthenticatedInstallationHandoff(options.handoffRoot ?? process.env.SPACE_INSTALLATION_HANDOFF_ROOT, options.installationSecret);
    // null is "Auto — best free": no pick is kept and the wrapper uses the first free model that passes (Big Pickle first).
    const auto = input.data.modelId === null;
    const model = auto ? null : handoff?.catalog?.models.find((item) => item.anonymousAvailable && item.id === input.data.modelId);
    if (!auto && !model) return error(reply, 422, "SETUP_MODEL_UNAVAILABLE", "This model has no current account-free setup proof.");
    const state = await coordinator.getState(ownerId);
    if (selectingModel || state.runs.some((run) => ["RUNNING", "PAUSED", "WAITING_FOR_INPUT"].includes(run.status))) {
      return error(reply, 409, "SETUP_RUN_ACTIVE", "Finish or revise the active setup before changing its model.");
    }
    if (!await freeModelSelectable()) return error(reply, 503, "SETUP_MODEL_UNAVAILABLE", "Model selection is unavailable on this installation.");
    selectingModel = true;
    try {
      await options.selectFreeModel!(model?.id ?? "auto");
      const current = await readVerifiedFreeModel(options.memoryRoot ?? process.env.SPACE_MEMORY_ROOT);
      if (!current || (model && current !== model.id)) return error(reply, 422, "SETUP_MODEL_NOT_VERIFIED", needsAttention);
      const connection = await options.connections.verify("cli:opencode");
      if (connection.functionalState !== "FUNCTIONAL" || connection.liveVerificationState !== "VERIFIED") {
        return error(reply, 422, "SETUP_MODEL_NOT_VERIFIED", "OpenCode must pass its connection check with the selected model.");
      }
      await audit(request, "setup.v2.model.selected", current);
      return { choice: auto ? "AUTO_BEST_FREE" : "VERIFIED_FREE", modelId: current, verified: true };
    } catch {
      return error(reply, 422, "SETUP_MODEL_NOT_VERIFIED", needsAttention);
    } finally { selectingModel = false; }
  });

  app.get("/api/setup/free-models", async (request, reply) => {
    if (!owner(request, reply)) return;
    const handoff = await readAuthenticatedInstallationHandoff(options.handoffRoot ?? process.env.SPACE_INSTALLATION_HANDOFF_ROOT, options.installationSecret);
    return { choice: "AUTO_BEST_FREE", selectedModelId: await readVerifiedFreeModel(options.memoryRoot ?? process.env.SPACE_MEMORY_ROOT),
      checkedAt: handoff?.catalog?.checkedAt ?? null, models: handoff?.catalog?.models ?? [], selectable: await freeModelSelectable() };
  });

  app.get("/api/setup/catalog", async (request, reply) => {
    if (!owner(request, reply)) return;
    const availability = await serverAvailability(options.connections, options.checkAgentSessions, options.capabilityChecks, options.functionalChecks, Boolean(options.voiceFingerprint), options.selectedServices);
    return {
      protocolVersion: 2,
      catalogVersion: SETUP_CATALOG_VERSION,
      features: SETUP_CATALOG.map((feature) => ({
        ...feature,
        availability: availability[feature.id] ?? "UNAVAILABLE",
        reasonCode: availability[feature.id] === "UNAVAILABLE"
          ? feature.id === "pane:harness" ? "HARNESS_SETUP_UNSUPPORTED"
            : feature.kind === "agent" && process.env.SPACE_PUBLIC_DISTRIBUTION === "true" &&
                !PUBLIC_SETUP_NATIVE_AGENTS.includes(feature.id.slice(6)) ? "AGENT_SETUP_CHECK_UNSUPPORTED"
              : "RUNTIME_NOT_VERIFIED" : null
      }))
    };
  });

  app.get("/api/setup/draft", async (request, reply) => {
    const ownerId = owner(request, reply);
    if (!ownerId) return;
    const state = await coordinator.getState(ownerId);
    if (state.draft) return state.draft;
    const onboarding = await options.store.getOwnerOnboarding();
    if (onboarding.onboardingVersion < 2 || onboarding.isComplete) {
      const settings = await options.store.getUserSettings(ownerId);
      return {
        id: null, ownerId, protocolVersion: 2, revision: null,
        persona: "everyday", level: settings.environmentPreset === "max" ? "full" : "minimal",
        requestedFeatureIds: setupSelectionFromSettings(settings), connectionChoices: [],
        catalogVersion: SETUP_CATALOG_VERSION, selectionOrigin: "EXISTING_SETTINGS"
      };
    }
    const availability = await serverAvailability(options.connections, options.checkAgentSessions, options.capabilityChecks, options.functionalChecks, Boolean(options.voiceFingerprint), options.selectedServices);
    return {
      id: null, ownerId, protocolVersion: 2, revision: null,
      persona: "everyday", level: "minimal",
      requestedFeatureIds: buildSetupSelection("everyday", "minimal", availability, []).requestedIds,
      connectionChoices: [], catalogVersion: SETUP_CATALOG_VERSION
    };
  });

  app.get("/api/setup/current", async (request, reply) => {
    const ownerId = owner(request, reply);
    if (!ownerId) return;
    const state = await coordinator.getState(ownerId);
    const run = [...state.runs].reverse().find((candidate) =>
      !["CANCELLED", "SUPERSEDED"].includes(candidate.status)
    ) ?? null;
    const plan = state.plans.find((candidate) => candidate.id === run?.planId) ?? null;
    if (run?.status === "RUNNING") schedule(ownerId, run.id);
    return {
      run, plan, completedRunId: state.completion?.runId ?? null,
      tasks: run ? state.tasks.filter((task) => task.runId === run.id) : [],
      receipts: run ? state.receipts.filter((receipt) => receipt.runId === run.id) : []
    };
  });

  app.put("/api/setup/draft", async (request, reply) => {
    const ownerId = owner(request, reply);
    if (!ownerId) return;
    const input = draftInput.parse(request.body);
    try {
      const draft = await coordinator.updateDraft(ownerId, input.expectedRevision, input);
      await audit(request, "setup.v2.draft.updated", draft.id);
      return draft;
    } catch (cause) { return guard(reply, cause); }
  });

  app.post("/api/setup/plan", async (request, reply) => {
    const ownerId = owner(request, reply);
    if (!ownerId) return;
    const input = planInput.parse(request.body);
    try {
      const state = await coordinator.getState(ownerId);
      const plan = await coordinator.createPlan(ownerId, input.draftRevision,
        await serverAvailability(options.connections, options.checkAgentSessions, options.capabilityChecks, options.functionalChecks, Boolean(options.voiceFingerprint), options.selectedServices),
        await currentConnectionFingerprints(options.store, options.connections, state.draft?.requestedFeatureIds ?? [], ownerId, options.voiceFingerprint, serviceVerification, captureFingerprint));
      await audit(request, "setup.v2.plan.created", plan.id);
      return plan;
    } catch (cause) { return guard(reply, cause); }
  });

  app.post("/api/setup/runs", async (request, reply) => {
    const ownerId = owner(request, reply);
    if (!ownerId) return;
    const input = runInput.parse(request.body);
    try {
      const state = await coordinator.getState(ownerId);
      const existing = state.runIdempotency.some((item) => item.key === input.idempotencyKey);
      if (!existing) {
        if (!state.draft) throw new SetupExecutionError("SETUP_PLAN_STALE", "Setup choices must be saved before starting.");
        let current;
        try {
          current = await coordinator.createPlan(ownerId, state.draft.revision,
            await serverAvailability(options.connections, options.checkAgentSessions, options.capabilityChecks, options.functionalChecks, Boolean(options.voiceFingerprint), options.selectedServices),
            await currentConnectionFingerprints(options.store, options.connections, state.draft.requestedFeatureIds, ownerId, options.voiceFingerprint, serviceVerification, captureFingerprint));
        } catch (cause) {
          if (cause instanceof SetupExecutionError && cause.code === "SETUP_FEATURE_UNAVAILABLE") {
            throw new SetupExecutionError("SETUP_PLAN_STALE", "Selected tool availability changed. Review the plan again.");
          }
          throw cause;
        }
        if (current.id !== input.planId || current.planDigest !== input.planDigest) {
          throw new SetupExecutionError("SETUP_PLAN_STALE", "Setup plan changed. Review the current plan before starting.");
        }
      }
      const run = await coordinator.startRun(ownerId, input.planId, input.planDigest, input.idempotencyKey);
      if (!existing) await audit(request, "setup.v2.run.started", run.id);
      if (run.status === "RUNNING") schedule(ownerId, run.id);
      return reply.status(existing ? 200 : 201).send(run);
    } catch (cause) { return guard(reply, cause); }
  });

  app.get("/api/setup/runs/:id", async (request, reply) => {
    const ownerId = owner(request, reply);
    if (!ownerId) return;
    const { id } = runParams.parse(request.params);
    const state = await coordinator.getState(ownerId);
    const run = state.runs.find((item) => item.id === id);
    if (!run) return error(reply, 404, "SETUP_RUN_NOT_FOUND", "Setup run was not found.");
    if (run.status === "RUNNING") schedule(ownerId, run.id);
    return {
      run, plan: state.plans.find((item) => item.id === run.planId),
      tasks: state.tasks.filter((item) => item.runId === id),
      receipts: state.receipts.filter((item) => item.runId === id)
    };
  });

  app.get("/api/setup/runs/:id/events", async (request, reply) => {
    const ownerId = owner(request, reply);
    if (!ownerId) return;
    const { id } = runParams.parse(request.params);
    const query = eventQuery.parse(request.query);
    try { return { events: await coordinator.listRunEvents(ownerId, id, query.after, query.limit) }; }
    catch (cause) { return guard(reply, cause); }
  });

  for (const operation of ["pause", "resume", "cancel"] as const) {
    app.post(`/api/setup/runs/:id/${operation}`, async (request, reply) => {
      const ownerId = owner(request, reply);
      if (!ownerId) return;
      emptyInput.parse(request.body ?? {});
      const { id } = runParams.parse(request.params);
      try {
        if (operation === "pause") await coordinator.pauseRun(ownerId, id);
        if (operation === "resume") await coordinator.resumeRun(ownerId, id);
        if (operation === "cancel") await coordinator.cancelRun(ownerId, id);
        await audit(request, `setup.v2.run.${operation}`, id);
        if (operation === "resume") schedule(ownerId, id);
        return { run: (await coordinator.getState(ownerId)).runs.find((item) => item.id === id) };
      } catch (cause) { return guard(reply, cause); }
    });
  }

  app.post("/api/setup/runs/:id/retry", async (request, reply) => {
    const ownerId = owner(request, reply);
    if (!ownerId) return;
    const { id } = runParams.parse(request.params);
    const input = retryInput.parse(request.body);
    try {
      // A completed run's expired checks are checked again in the same run (review 2026-10-21 #8); failed work is retried.
      const revalidate = (await coordinator.getState(ownerId)).runs.find((item) => item.id === id)?.status === "READY";
      if (revalidate) await coordinator.revalidateStaleTasks(ownerId, id, input.taskIds, input.expectedRunRevision);
      else await coordinator.retryFailedTasks(ownerId, id, input.taskIds, input.expectedRunRevision);
      await audit(request, revalidate ? "setup.v2.run.revalidated" : "setup.v2.run.retried", id);
      schedule(ownerId, id);
      return { run: (await coordinator.getState(ownerId)).runs.find((item) => item.id === id) };
    } catch (cause) { return guard(reply, cause); }
  });

  app.post("/api/setup/runs/:id/reconcile", async (request, reply) => {
    const ownerId = owner(request, reply);
    if (!ownerId) return;
    const { id } = runParams.parse(request.params);
    const { taskId } = reconcileInput.parse(request.body);
    try {
      const state = await coordinator.getState(ownerId);
      const run = state.runs.find((item) => item.id === id);
      const plan = state.plans.find((item) => item.id === run?.planId);
      const task = state.tasks.find((item) => item.id === taskId && item.runId === id);
      if (!run || !plan || !task) throw new SetupExecutionError("SETUP_TASK_NOT_FOUND", "Setup task was not found.");
      const adapter = adapterFor(task, ownerId, plan);
      if (!adapter) throw new SetupExecutionError("SETUP_RECONCILIATION_UNAVAILABLE", "This setup check cannot be reconciled automatically.");
      await coordinator.reconcileExpiredTask(ownerId, id, taskId, adapter.inspect);
      await audit(request, "setup.v2.run.reconciled", id);
      const current = await coordinator.getState(ownerId);
      const updatedRun = current.runs.find((item) => item.id === id)!;
      if (updatedRun.status === "RUNNING") schedule(ownerId, id);
      return { run: updatedRun, plan, tasks: current.tasks.filter((item) => item.runId === id),
        receipts: current.receipts.filter((item) => item.runId === id) };
    } catch (cause) { return guard(reply, cause); }
  });
  return {
    inspectTask: async (task: SetupTask, ownerId: string, plan: SetupPlan) => {
      try { return await adapterFor(task, ownerId, plan)?.inspect(task) ?? { outcome: "UNKNOWN" as const }; }
      catch { return { outcome: "UNKNOWN" as const }; }
    }
  };

}
