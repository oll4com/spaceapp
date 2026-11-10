import type {} from "./request-context.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { type HostMemoryDetails, hostMemoryDetailsSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { invalidateToolbarProvider, minimumKernelCacheReclaimBytes, type registerAdminCleanupRoutes } from "./admin-cleanup-routes.js";
import type { CliMaintenanceManager, CliUpdateAllRunner } from "./cli-maintenance.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { CliSessionCleanupService } from "./cli-session-cleanup.js";
import type { CodexHistoryAccessCoordinator } from "./codex-history-purge.js";
import type { SpaceApiConfig } from "./config.js";
import {
  MaintenanceAutopilot,
  createCliMaintenanceAutopilotSteps,
  createMemoryReliefStep,
  createStorageCleanupStep
} from "./maintenance-autopilot.js";
import { registerMaintenanceAutopilotRoutes } from "./maintenance-autopilot-routes.js";
import { recordAudit } from "./request-audit.js";
import type { KernelCacheReclaimResult } from "./toolbar-system-services.js";

/**
 * The maintenance autopilot: its storage, memory and CLI steps, the nightly scheduler (stable's
 * maintenance-autopilot job, never in tests) and its ADMIN routes. The memory step shares the toolbar cleanup's lock.
 */
export function registerMaintenanceAutopilot(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  codexHistoryAccessCoordinator: CodexHistoryAccessCoordinator;
  cliSessionCleanupService: CliSessionCleanupService;
  toolbarCleanup: ReturnType<typeof registerAdminCleanupRoutes>;
  toolbarHostMemoryProvider: () => Promise<HostMemoryDetails>;
  toolbarKernelCacheReclaimer: () => Promise<KernelCacheReclaimResult>;
  cliMaintenanceManager: CliMaintenanceManager;
  cliUpdateAllRunner: CliUpdateAllRunner;
  maintenanceAutopilot?: MaintenanceAutopilot;
}) {
  const {
    config, store, cliRuntimeVisibility, codexHistoryAccessCoordinator, cliSessionCleanupService, toolbarCleanup,
    toolbarHostMemoryProvider, toolbarKernelCacheReclaimer, cliMaintenanceManager, cliUpdateAllRunner
  } = options;
  const maintenanceAutopilotTesting = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const recordAutopilotAudit = async (actorId: string, action: string, targetId: string, metadata: Record<string, unknown>) => {
    try {
      await store.recordAuditEvent({
        actorUserId: actorId,
        traceId: `maintenance_autopilot:${randomUUID()}`,
        action,
        targetType: "maintenance_autopilot",
        targetId,
        metadata: { ...metadata, source: "maintenance_autopilot" }
      });
    } catch (error) {
      app.log.warn({ err: error, action }, "Maintenance autopilot audit event could not be recorded");
    }
  };
  const maintenanceAutopilot = options.maintenanceAutopilot ?? new MaintenanceAutopilot({
    stateFile: maintenanceAutopilotTesting ? null : config.maintenanceAutopilotStateFile,
    steps: {
      cleanup: createStorageCleanupStep({
        anyCliEnabled: async () => (await cliRuntimeVisibility.enabledRuntimeIds()).length > 0,
        withExclusive: (operation) => codexHistoryAccessCoordinator.withExclusivePurge(operation),
        protectedThreadIds: () => Promise.resolve(store.listActiveManagedCodexThreadIds()),
        codexEnabled: () => cliRuntimeVisibility.isEnabled("cli:codex"),
        service: cliSessionCleanupService,
        audit: (result, actorId) => recordAutopilotAudit(actorId, "admin.cli_sessions.cleaned", result.previewId, {
          status: result.status,
          cleaned: result.cleaned,
          totalBytes: result.totalBytes,
          failures: result.failures
        })
      }),
      memory: createMemoryReliefStep({
        acquire: toolbarCleanup.acquire,
        release: toolbarCleanup.release,
        readMemory: async () => hostMemoryDetailsSchema.parse(await toolbarHostMemoryProvider()),
        stopClosedPaneClis: toolbarCleanup.stopClosedPaneClis,
        reclaimPageCache: async () => {
          try {
            return await toolbarKernelCacheReclaimer();
          } finally {
            invalidateToolbarProvider(toolbarHostMemoryProvider);
          }
        },
        minimumReclaimBytes: minimumKernelCacheReclaimBytes,
        audit: (result, actorId) => recordAutopilotAudit(actorId, "admin.memory.reclaimed", "vm207", {
          status: result.status,
          killedCliCount: result.stoppedCliCount,
          kernelCacheStatus: result.status,
          kernelCacheReclaimedBytes: result.reclaimedBytes
        })
      }),
      ...createCliMaintenanceAutopilotSteps({
        manager: cliMaintenanceManager,
        updateAll: cliUpdateAllRunner,
        listCliRuntimeSettings: async () => store.listCliRuntimeSettings(),
        onUpdateAll: (result, actorId) => recordAutopilotAudit(actorId, "cli_maintenance.update_all_completed", `autopilot:${Date.now().toString(36)}`, {
          mode: result.mode,
          overallStatus: result.overallStatus,
          runtimeCount: result.runtimes.length,
          scope: result.scope,
          reinstall: result.reinstall
        })
      })
    },
    onRunFinished: (run, actorId) => recordAutopilotAudit(actorId, "admin.maintenance_autopilot.finished", run.id, {
      trigger: run.trigger,
      status: run.status,
      steps: run.steps.map((step) => ({ id: step.id, status: step.status }))
    }),
    onError: (error, message) => app.log.warn({ err: error }, message)
  });
  if (!options.maintenanceAutopilot && !maintenanceAutopilotTesting && config.instanceJobs["maintenance-autopilot"]) maintenanceAutopilot.startScheduler();
  app.addHook("onClose", () => maintenanceAutopilot.stop());
  registerMaintenanceAutopilotRoutes(app, {
    autopilot: maintenanceAutopilot,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
}
