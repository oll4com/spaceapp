import type { SpaceStore } from "@space/runtime";
import type { FastifyInstance } from "fastify";
import { registerAdminIntegrationRoutes, registerAdminOperationsRoutes } from "./admin-ops-routes.js";
import type { SpaceApiConfig } from "./config.js";
import { registerMemoryGraphRoutes } from "./memory-graph-routes.js";
import { recordAudit } from "./request-audit.js";

type D<F extends (app: FastifyInstance, deps: never) => unknown> = Parameters<F>[1];
type Integration = D<typeof registerAdminIntegrationRoutes>; type MemoryGraph = D<typeof registerMemoryGraphRoutes>;
type Operations = D<typeof registerAdminOperationsRoutes>;
type AdminRoutesDeps = Pick<Integration, "spaceCapabilityInventoryCollector">
  & Pick<Operations, "apiStartedAt" | "auth" | "observability" | "workerReadinessChecker" | "storageReadinessChecker" | "cliRuntimeVisibility" | "healthMonitor"
    | "systemTopologyService" | "serviceRestarter" | "serviceRestartCooldownPath">
  & {
    config: SpaceApiConfig; store: SpaceStore; memoryGraphService: MemoryGraph["service"]; memoryConsolidationCoordinator: MemoryGraph["consolidationCoordinator"];
    memoryMutationCoordinator: MemoryGraph["mutationCoordinator"]; defaultRouteRateLimitOptions: Integration["routeOptions"] & Operations["routeOptions"];
  };

/** The admin routes at the end of app.ts (moved verbatim, ARCH-001 step 83): the admin integration routes, the memory graph routes with their
 * audit, and the admin operations routes, in the order app.ts registered them. */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps) {
  const { config, store, spaceCapabilityInventoryCollector, defaultRouteRateLimitOptions, memoryGraphService, memoryConsolidationCoordinator, memoryMutationCoordinator,
    apiStartedAt, auth, observability, workerReadinessChecker, storageReadinessChecker, cliRuntimeVisibility, healthMonitor, systemTopologyService, serviceRestarter,
    serviceRestartCooldownPath } = deps;
  registerAdminIntegrationRoutes(app, {
    config, store, spaceCapabilityInventoryCollector, routeOptions: defaultRouteRateLimitOptions
  });
  registerMemoryGraphRoutes(app, {
    config,
    service: memoryGraphService,
    store,
    consolidationCoordinator: memoryConsolidationCoordinator,
    mutationCoordinator: memoryMutationCoordinator,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
  registerAdminOperationsRoutes(app, {
    apiStartedAt, config, auth, store, observability, workerReadinessChecker, storageReadinessChecker,
    cliRuntimeVisibility, healthMonitor, systemTopologyService, serviceRestarter, serviceRestartCooldownPath,
    routeOptions: defaultRouteRateLimitOptions
  });
}
