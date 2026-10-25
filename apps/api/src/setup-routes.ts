import type {} from "./request-context.js";
import { createHash } from "node:crypto";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  idSchema, setupClaimInputSchema, setupClaimResponseSchema, setupConnectionCheckRunSchema, setupConnectionSchema,
  setupOverviewSchema, setupStarterRoomResponseSchema, setupStatusSchema
} from "@space/contracts";
import { nowIso, SETUP_RECEIPT_RENEWAL_WINDOW_MS, SetupExecutionError, SpaceConflictError, type SetupActionInspection, type SetupExecutionCoordinator, type SpaceStore } from "@space/runtime";
import type { SetupFeatureId, SetupPlan, SetupTask } from "@space/contracts";
import { type AuthConfig, cookieName, hashPassword, operatorSessionTtlSeconds, signSession } from "./auth.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";
import type { SetupConnectionCheckRunManager } from "./setup-connection-check-runs.js";
import { setupSettingsMatch } from "./setup-production-actions.js";
import { planSetupSettings, setupLiveDefaults } from "./setup-settings.js";
import { type SetupConnectionsService, summarizeSetupConnections } from "./setup-connections.js";
import { formatSseMessage, startSseHeartbeat } from "./sse.js";

const setupConnectionCheckRunParamSchema = z.object({ runId: idSchema }).strict();

const setupConnectionCheckReplayQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).max(1_000_000_000).default(0)
}).strict();

const emptySetupConnectionCheckRunSchema = z.object({}).strict();

/**
 * Single-owner setup: claim, overview, connection checks and the starter room; the parent retains authentication,
 * CSRF, errors and rate limits.
 */
/** Finishing trusts a provider check this recent; an older one is repeated live (review 2026-10-21 #4). */
const providerCheckMaxAgeMs = 5 * 60_000;

export function registerSetupRoutes(app: FastifyInstance, options: {
  auth: AuthConfig;
  store: SpaceStore;
  setupConnections: SetupConnectionsService;
  setupConnectionCheckRuns: SetupConnectionCheckRunManager;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  optionalModules?: string[];
  onOwnerClaimed?: () => void;
  /** First Setup: finishing needs the owner's current run, its plan and fresh receipts for every selected task. */
  execution: {
    coordinator: () => SetupExecutionCoordinator;
    inspectTask: (task: SetupTask, ownerId: string, plan: SetupPlan) => Promise<SetupActionInspection>;
    memoryRoot?: string;
    handoffRoot?: string;
    /** Finishing asks the Live provider whether the saved connection still works (no audio). */
    liveReauthorize?: (ownerId: string) => Promise<boolean>;
  };
}) {
  const { auth, store, setupConnections, setupConnectionCheckRuns, execution, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/setup/status", defaultRouteRateLimitOptions, async () => {
    return setupStatusSchema.parse(await store.getOwnerSetupStatus());
  });
  app.post(
    "/api/setup/claim",
    {
      bodyLimit: 2 * 1024,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } }
    },
    async (request, reply) => {
      const input = parseBody(setupClaimInputSchema, request.body);
      // Refuse before scrypt when no claim can succeed, so this public route cannot be used to burn CPU (review F16).
      const status = await store.getOwnerSetupStatus();
      if (!status.setupRequired) throw new SpaceConflictError("SpaceApp owner setup is already claimed.");
      if (!status.expiresAt) throw new SpaceConflictError("The SpaceApp setup token is not valid.");
      if (Date.parse(status.expiresAt) <= Date.now()) throw new SpaceConflictError("The SpaceApp setup token has expired.");
      const tokenHash = createHash("sha256").update(input.token).digest("hex");
      const passwordHash = await hashPassword(input.password);
      const claimed = await store.claimOwnerSetup({
        tokenHash,
        email: input.email,
        passwordHash,
        now: nowIso()
      });
      const { user, onboarding } = claimed;
      await recordAudit(store, request, {
        actorUserId: user.id,
        action: "auth.owner_setup.claimed",
        targetType: "user",
        targetId: user.id,
        metadata: { role: user.role }
      }).catch((error) => {
        request.log.warn(
          { err: error, requestId: request.requestIdForSpace },
          "Owner setup audit record failed."
        );
      });
      options.onOwnerClaimed?.();
      const token = signSession(user, auth.sessionSecret);
      reply.setCookie(cookieName, token, {
        httpOnly: true,
        secure: auth.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: operatorSessionTtlSeconds
      });
      return setupClaimResponseSchema.parse({
        user,
        isAuthenticated: true,
        isSetupRequired: false,
        onboardingVersion: onboarding.onboardingVersion,
        isOnboardingComplete: onboarding.isComplete,
        starterRoomId: onboarding.starterRoomId,
        optionalModules: options.optionalModules
      });
    }
  );
  app.get("/api/setup/overview", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "FORBIDDEN", "Owner access is required.");
    }
    const [onboarding, connections] = await Promise.all([
      store.getOwnerOnboarding(),
      setupConnections.overview()
    ]);
    return setupOverviewSchema.parse({
      ...onboarding,
      summary: summarizeSetupConnections(connections),
      connections
    });
  });
  app.post(
    "/api/setup/connection-check-runs",
    { config: { rateLimit: { max: 2, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Setup connection checks require the ADMIN role.");
      }
      parseBody(emptySetupConnectionCheckRunSchema, request.body ?? {});
      const admission = await setupConnectionCheckRuns.startAll(request.user.id);
      await recordAudit(store, request, {
        action: admission.reused ? "setup.connection_check.reused" : "setup.connection_check.started",
        targetType: "setup_connection_check_run",
        targetId: admission.run.id,
        metadata: {
          scope: admission.run.scope,
          totalCount: admission.run.totalCount
        }
      });
      reply
        .code(admission.reused ? 200 : 202)
        .header("Location", `/api/setup/connection-check-runs/${encodeURIComponent(admission.run.id)}/replay`);
      return setupConnectionCheckRunSchema.parse(admission.run);
    }
  );
  app.post(
    "/api/setup/connections/:id/check-runs",
    { config: { rateLimit: { max: 12, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Setup connection checks require the ADMIN role.");
      }
      parseBody(emptySetupConnectionCheckRunSchema, request.body ?? {});
      const params = parseQuery(idParamSchema, request.params);
      const admission = await setupConnectionCheckRuns.startSingle(params.id, request.user.id);
      await recordAudit(store, request, {
        action: admission.reused ? "setup.connection_check.reused" : "setup.connection_check.started",
        targetType: "setup_connection_check_run",
        targetId: admission.run.id,
        metadata: {
          scope: admission.run.scope,
          connectionId: params.id
        }
      });
      reply
        .code(admission.reused ? 200 : 202)
        .header("Location", `/api/setup/connection-check-runs/${encodeURIComponent(admission.run.id)}/replay`);
      return setupConnectionCheckRunSchema.parse(admission.run);
    }
  );
  app.get(
    "/api/setup/connection-check-runs/:runId/replay",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Setup connection replay requires the ADMIN role.");
      }
      const params = parseQuery(setupConnectionCheckRunParamSchema, request.params);
      const query = parseQuery(setupConnectionCheckReplayQuerySchema, request.query);
      return setupConnectionCheckRuns.replay(params.runId, query.afterSequence);
    }
  );
  app.get(
    "/api/setup/connection-check-runs/:runId/stream",
    {
      compress: false,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Setup connection progress requires the ADMIN role.");
      }
      const params = parseQuery(setupConnectionCheckRunParamSchema, request.params);
      const query = parseQuery(setupConnectionCheckReplayQuerySchema, request.query);
      const rawLastEventId = request.headers["last-event-id"];
      const lastEventId = Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId;
      const parsedLastEventId = /^\d{1,10}$/.test(String(lastEventId ?? ""))
        ? Math.min(1_000_000_000, Number(lastEventId))
        : 0;
      let afterSequence = Math.max(query.afterSequence, parsedLastEventId);
      const replay = await setupConnectionCheckRuns.replay(params.runId, afterSequence);

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "private, no-cache, no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      reply.raw.write(formatSseMessage("ready", {
        runId: replay.run.id,
        afterSequence,
        requestId: request.requestIdForSpace
      }));
      for (const event of replay.events) {
        afterSequence = event.sequence;
        reply.raw.write(formatSseMessage("progress", event, event.sequence));
      }
      reply.raw.write(formatSseMessage("run", replay.run));
      reply.raw.write(formatSseMessage("overview", replay.overview));
      if (setupConnectionCheckRuns.isStreamTerminal(replay)) {
        reply.raw.end();
        return;
      }

      let isClosed = false;
      let polling = false;
      let lastRunUpdatedAt = replay.run.updatedAt;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      const stopHeartbeat = startSseHeartbeat((frame) => {
        if (!isClosed) reply.raw.write(frame);
      });
      const closeStream = () => {
        if (isClosed) return;
        isClosed = true;
        if (pollTimer) clearInterval(pollTimer);
        stopHeartbeat();
      };
      const poll = async () => {
        if (isClosed || polling) return;
        polling = true;
        try {
          const current = await setupConnectionCheckRuns.replay(params.runId, afterSequence);
          for (const event of current.events) {
            afterSequence = event.sequence;
            reply.raw.write(formatSseMessage("progress", event, event.sequence));
          }
          if (current.run.updatedAt !== lastRunUpdatedAt || setupConnectionCheckRuns.isStreamTerminal(current)) {
            lastRunUpdatedAt = current.run.updatedAt;
            reply.raw.write(formatSseMessage("run", current.run));
            reply.raw.write(formatSseMessage("overview", current.overview));
          }
          if (setupConnectionCheckRuns.isStreamTerminal(current)) {
            closeStream();
            reply.raw.end();
          }
        } catch {
          if (!isClosed) {
            reply.raw.write(formatSseMessage("stream-error", {
              code: "SETUP_CONNECTION_STREAM_UNAVAILABLE",
              message: "Live progress paused; durable replay remains available."
            }));
            closeStream();
            reply.raw.end();
          }
        } finally {
          polling = false;
        }
      };
      pollTimer = setInterval(() => void poll(), 500);
      reply.raw.once("close", closeStream);
      request.raw.once("aborted", closeStream);
    }
  );
  app.post(
    "/api/setup/connections/:id/verify",
    { config: { rateLimit: { max: 12, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "FORBIDDEN", "Owner access is required.");
      }
      const params = parseQuery(idParamSchema, request.params);
      const connection = await setupConnections.verify(params.id);
      await recordAudit(store, request, {
        action: "setup.connection.verify",
        targetType: "setup_connection",
        targetId: connection.id,
        metadata: { state: connection.state, reasonCode: connection.reasonCode }
      });
      return setupConnectionSchema.parse(connection);
    }
  );
  app.post(
    "/api/setup/connections/verify-all",
    { config: { rateLimit: { max: 2, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "FORBIDDEN", "Owner access is required.");
      }
      const [onboarding, connections] = await Promise.all([
        store.getOwnerOnboarding(),
        setupConnections.verifyAll()
      ]);
      await recordAudit(store, request, {
        action: "setup.connection.verify_all",
        targetType: "owner_setup",
        targetId: request.user.id,
        metadata: {
          connected: connections.filter((connection) => connection.state === "CONNECTED").length,
          total: connections.length
        }
      });
      return setupOverviewSchema.parse({
        ...onboarding,
        summary: summarizeSetupConnections(connections),
        connections
      });
    }
  );
  app.post("/api/setup/starter-room", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "FORBIDDEN", "Owner access is required.");
    }
    const result = await store.ensureOwnerStarterRoom(request.requestIdForSpace);
    await recordAudit(store, request, {
      action: "setup.starter_room.ensure",
      targetType: "room",
      targetId: result.room.id,
      metadata: { onboardingVersion: result.onboarding.onboardingVersion }
    });
    return setupStarterRoomResponseSchema.parse(result);
  });
  app.post("/api/setup/finish", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "FORBIDDEN", "Owner access is required.");
    }
    const currentOnboarding = await store.getOwnerOnboarding();
    let onboarding = currentOnboarding;
    const hasRequestedRun = request.body != null && Object.keys(Object(request.body)).length > 0;
    const validatesRun = !currentOnboarding.isComplete || hasRequestedRun;
    if (validatesRun) {
      const input = z.object({
        runId: z.string().regex(/^run:[a-zA-Z0-9._:-]{3,123}$/),
        draftRevision: z.number().int().nonnegative(),
        planDigest: z.string().regex(/^[a-f0-9]{64}$/)
      }).strict().safeParse(request.body);
      if (!input.success) {
        return sendApiError(reply, 409, "SETUP_RUN_REQUIRED", "Complete the current setup run before finishing.");
      }
      const coordinator = execution.coordinator();
      const state = await coordinator.getState(request.user.id);
      const run = state.runs.find((item) => item.id === input.data.runId);
      const plan = state.plans.find((item) => item.id === run?.planId);
      if (!run || !plan || !state.draft || plan.planDigest !== input.data.planDigest ||
        plan.draftRevision !== input.data.draftRevision || state.draft.revision !== input.data.draftRevision) {
        return sendApiError(reply, 409, "SETUP_PLAN_STALE", "Setup choices changed. Review the current plan.");
      }
      if (process.env.SPACE_PUBLIC_DISTRIBUTION === "true") {
        const [{ readVerifiedFreeModel }, { readSetupAssistantProof }] = await Promise.all([
          import("./verified-free-model.js"), import("./installation-handoff.js")
        ]);
        const memoryRoot = execution.memoryRoot ?? process.env.SPACE_MEMORY_ROOT;
        const handoffRoot = execution.handoffRoot ?? process.env.SPACE_INSTALLATION_HANDOFF_ROOT;
        const [modelId, proof] = await Promise.all([
          readVerifiedFreeModel(memoryRoot), readSetupAssistantProof(handoffRoot, memoryRoot, auth.sessionSecret)
        ]);
        if (!modelId || !proof) {
          return sendApiError(reply, 422, "SETUP_NOT_READY", "The free OpenCode task and installation memory must be verified again.");
        }
      }
      if (process.env.SPACE_PUBLIC_DISTRIBUTION === "true") {
        const { projectSetupInstallationMemory, setupInstallationMemoryMatches } = await import("./setup-installation-memory.js");
        const { readVerifiedFreeModel } = await import("./verified-free-model.js");
        const { readSetupAssistantProof } = await import("./installation-handoff.js");
        const memoryRoot = execution.memoryRoot ?? process.env.SPACE_MEMORY_ROOT;
        const [modelId, proof] = await Promise.all([readVerifiedFreeModel(memoryRoot), readSetupAssistantProof(
          execution.handoffRoot ?? process.env.SPACE_INSTALLATION_HANDOFF_ROOT, memoryRoot, auth.sessionSecret, true)]);
        const task = state.tasks.find((item) => item.runId === run.id && item.actionId === "WRITE_INSTALLATION_MEMORY");
        const content = task && modelId && proof ? projectSetupInstallationMemory(state, plan, task, modelId, proof) : null;
        if (!memoryRoot || !content || !await setupInstallationMemoryMatches(memoryRoot, content)) {
          return sendApiError(reply, 422, "SETUP_NOT_READY", "Installation memory must be saved and verified before finishing.");
        }
      }
      const currentFingerprints: Partial<Record<SetupFeatureId, string>> = {};
      // Review 2026-10-21 #4: an unchanged local credential is no proof that the provider still accepts it. An agent whose
      // last provider check is older than five minutes is checked live now; a selected Live connection must be accepted
      // by its provider now.
      const runTasks = state.tasks.filter((item) => item.runId === run.id);
      // Review 2026-10-21 #8: results that expired before finish (or are about to) are checked again in this run, which
      // keeps the work done; nothing asks the providers for a run that cannot finish anyway.
      const expiredTaskIds = run.status !== "READY" ? [] : runTasks.filter((task) => !state.receipts.some((receipt) =>
        receipt.taskId === task.id && receipt.outcome === "PASSED" &&
        Date.parse(receipt.expiresAt) > Date.now() + SETUP_RECEIPT_RENEWAL_WINDOW_MS)).map((task) => task.id);
      if (expiredTaskIds.length) {
        return sendApiError(reply, 422, "SETUP_CHECKS_EXPIRED", "Some setup checks expired. Setup checks them again before finishing.", {
          missingTaskIds: expiredTaskIds
        });
      }
      for (const connectionId of new Set(runTasks.filter((item) => item.featureId.startsWith("agent:")).map((item) => `cli:${item.featureId.slice(6)}`))) {
        const saved = await store.getSetupConnectionVerification(connectionId);
        const age = saved?.verifiedAt ? Date.now() - Date.parse(saved.verifiedAt) : Infinity;
        if (!(age >= 0 && age < providerCheckMaxAgeMs)) await setupConnections.verify(connectionId).catch(() => undefined);
      }
      if (runTasks.some((task) => task.actionId === "VERIFY_LIVE_AUDIO") &&
        !(execution.liveReauthorize && await execution.liveReauthorize(request.user.id).catch(() => false))) {
        return sendApiError(reply, 422, "SETUP_NOT_READY", "The selected Live connection must be accepted by its provider again.", {
          missingTaskIds: runTasks.filter((task) => task.actionId === "VERIFY_LIVE_AUDIO").map((task) => task.id)
        });
      }
      const observedAgents = new Map((await setupConnections.overview()).map((connection) => [connection.id, connection]));
      for (const task of runTasks) {
        if (task.featureId.startsWith("agent:")) {
          const connectionId = `cli:${task.featureId.slice(6)}`;
          const observed = observedAgents.get(connectionId);
          const saved = await store.getSetupConnectionVerification(connectionId);
          const age = saved?.verifiedAt ? Date.now() - Date.parse(saved.verifiedAt) : Infinity;
          if (!(age >= 0 && age < providerCheckMaxAgeMs)) continue;
          if (observed?.functionalState === "FUNCTIONAL" && observed.liveVerificationState === "VERIFIED" &&
            observed.verifiedAt && saved?.state === "CONNECTED" && saved.verifiedAt && saved.fingerprintHash) {
            currentFingerprints[task.featureId] = saved.fingerprintHash;
          }
        } else {
          const observed = await execution.inspectTask(task, request.user.id, plan);
          if (observed.outcome === "VERIFIED") currentFingerprints[task.featureId] = observed.receipt.subjectFingerprint;
        }
      }
      const readiness = await coordinator.checkReadiness(request.user.id, run.id, currentFingerprints);
      if (!readiness.ready) {
        return sendApiError(reply, 422, "SETUP_NOT_READY", "Selected setup tasks need current verification.", {
          missingTaskIds: readiness.missingTaskIds
        });
      }
      const currentSettings = await store.getUserSettings(request.user.id);
      if (!setupSettingsMatch(currentSettings, planSetupSettings(plan.effectiveFeatureIds, currentSettings, setupLiveDefaults(state.draft, plan)))) {
        return sendApiError(reply, 422, "SETUP_NOT_READY", "Workspace settings changed. Review and apply the current setup selection again.");
      }
      for (const task of state.tasks.filter((item) => item.runId === run.id)) {
        const observed = await execution.inspectTask(task, request.user.id, plan);
        if (observed.outcome !== "VERIFIED" || observed.receipt.subjectFingerprint !== currentFingerprints[task.featureId]) {
          return sendApiError(reply, 422, "SETUP_NOT_READY", "A selected setup capability needs verification again.", {
            missingTaskIds: [task.id]
          });
        }
      }
      try {
        onboarding = await store.completeSetupExecution({
          ownerId: request.user.id, expectedStateRevision: state.revision,
          runId: run.id, draftRevision: input.data.draftRevision,
          planDigest: input.data.planDigest, currentFingerprints,
          reconfigure: currentOnboarding.isComplete,
          completedAt: nowIso()
        });
      } catch (cause) {
        if (cause instanceof SetupExecutionError) {
          return sendApiError(reply, cause.code === "SETUP_NOT_READY" ? 422 : 409, cause.code, cause.message);
        }
        throw cause;
      }
    }
    const connections = await setupConnections.overview();
    if (validatesRun) {
      await recordAudit(store, request, {
        action: currentOnboarding.isComplete ? "setup.reconfiguration.finish" : "setup.onboarding.finish",
        targetType: "owner_setup",
        targetId: request.user!.id,
        metadata: { onboardingVersion: onboarding.onboardingVersion }
      });
    }
    return setupOverviewSchema.parse({
      ...onboarding,
      summary: summarizeSetupConnections(connections),
      connections
    });
  });
}
