import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryActivityLogRepository,
  InMemoryAppDiagnosticsRepository,
  InMemoryDemoProjectsRepository,
  PostgresActivityLogRepository,
  PostgresAppDiagnosticsRepository,
  PostgresDemoProjectsRepository,
  PostgresSpaceStore
} from "@space/db";
import { InMemorySpaceStore, type SpaceStore } from "@space/runtime";
import { ActivityLogService } from "./activity-log.js";
import { AppDiagnosticsService } from "./app-diagnostics.js";
import type { SpaceApiConfig } from "./config.js";
import { DemoCredentialStore } from "./demo-projects/credentials.js";
import { DemoProjectsService } from "./demo-projects/service.js";

// The services createApp builds from config when its options supply none: PostgreSQL-backed when the store is, else in
// memory (app diagnostics then write under a per-process temporary root removed on dispose).
export function createDemoProjectsService(input: {
  config: SpaceApiConfig;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}): DemoProjectsService {
  const { config } = input;
  const repository =
    config.runtimeStore === "postgres" && config.databaseUrl
      ? PostgresDemoProjectsRepository.fromConnectionString(config.databaseUrl, {
          max: 2,
          idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
          connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
        })
      : new InMemoryDemoProjectsRepository();
  const portStart = Math.min(config.demoProjectsPortStart, 65_500);
  const portEnd = Math.max(portStart + 1, Math.min(config.demoProjectsPortEnd, 65_535));
  return new DemoProjectsService({
    repository,
    demoRoot: config.demoProjectsRoot,
    varRoot: config.demoProjectsVarRoot,
    apiPort: config.port,
    publicOrigin: config.demoProjectsPublicOrigin,
    portRangeStart: portStart,
    portRangeEnd: portEnd,
    healthTimeoutMs: config.demoProjectsHealthTimeoutMs,
    credentialStore: new DemoCredentialStore(`${config.demoProjectsVarRoot.replace(/\/+$/, "")}/secrets`),
    log: input.log
  });
}

export function createDefaultStore(config: SpaceApiConfig): SpaceStore {
  if (config.runtimeStore === "postgres") {
    if (!config.databaseUrl) {
      throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
    }
    return PostgresSpaceStore.fromConnectionString(config.databaseUrl, {
      codexLbConfigured: config.codexLbConfigured,
      codexLbBaseUrl: config.codexLbBaseUrl,
      mcpServerConfigs: config.mcpServerConfigs ?? [],
      mcpConfigError: config.mcpConfigError ?? null
    }, {
      idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
      connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
    });
  }

  return new InMemorySpaceStore({
    codexLbConfigured: config.codexLbConfigured,
    codexLbBaseUrl: config.codexLbBaseUrl,
    mcpServerConfigs: config.mcpServerConfigs ?? [],
    mcpConfigError: config.mcpConfigError ?? null
  });
}

export function createDefaultAppDiagnosticsService(
  config: SpaceApiConfig,
  store: SpaceStore
): AppDiagnosticsService {
  const persistent = store instanceof PostgresSpaceStore;
  const repository = persistent
    ? PostgresAppDiagnosticsRepository.fromConnectionString(
        config.databaseUrl ?? (() => {
          throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
        })(),
        {
          max: 2,
          idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
          connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
        }
      )
    : new InMemoryAppDiagnosticsRepository();
  return new AppDiagnosticsService({
    repository,
    root: persistent
      ? config.appDiagnosticsRoot
      : join(tmpdir(), `space-app-diagnostics-${process.pid}-${crypto.randomUUID()}`),
    cleanupRootOnDispose: !persistent
  });
}

export function createDefaultActivityLogService(config: SpaceApiConfig, store: SpaceStore): ActivityLogService {
  const persistent = store instanceof PostgresSpaceStore;
  const repository = persistent
    ? PostgresActivityLogRepository.fromConnectionString(
        config.databaseUrl ?? (() => {
          throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
        })(),
        {
          max: 2,
          idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
          connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
        }
      )
    : new InMemoryActivityLogRepository();
  return new ActivityLogService({ repository });
}
