import type { CliSessionStats, HostMemoryDetails } from "@space/contracts";
import { InMemorySystemAnalyticsRepository, PostgresSpaceStore, PostgresSystemAnalyticsRepository, type GatewayRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import type { createPublicCredentialHost } from "./cli-auth-transfer.js";
import type { CliHostReapAggregate, CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { OpencodeModelBenchService, openCode2Models } from "./opencode-model-bench.js";
import { createSystemServicesProvider, runSystemServicesCollector, type SystemServicesRunner } from "./service-services.js";
import { SystemAnalyticsService, tokenUsageSourcesFor, type SystemAnalyticsLiveSession } from "./system-analytics-service.js";
import { createToolbarModelStatsCollector, type ToolbarModelStatsCollector } from "./toolbar-model-stats.js";
import { collectCliSessionStats, createCliSessionStatsProvider, createHostMemoryDetailsProvider, type InvalidatableProvider } from "./toolbar-system-services.js";
import type { UnifiedCliTaskRegistry } from "./unified-cli-task-registry.js";
import { SPACE_AGENT_HOME } from "@space/contracts";

type SystemAnalyticsDeps = {
  options: {
    toolbarCliSessionStatsProvider?: InvalidatableProvider<CliSessionStats> | (() => Promise<CliSessionStats>);
    systemServicesProvider?: SystemServicesRunner;
    toolbarHostMemoryProvider?: InvalidatableProvider<HostMemoryDetails> | (() => Promise<HostMemoryDetails>);
    toolbarCliSessionReaper?: () => Promise<CliHostReapAggregate>;
    toolbarCliSessionTerminator?: (sessionId: string, traceId?: string) => Promise<boolean>;
    toolbarModelStatsCollector?: ToolbarModelStatsCollector;
    systemAnalyticsService?: SystemAnalyticsService;
    opencodeModelBenchService?: OpencodeModelBenchService | null;
    opencodeStateRoot?: string;
  };
  config: SpaceApiConfig; store: SpaceStore;
  cliTerminalManager: Pick<CliTerminalManager, "hostHealth" | "reapDetachedSessions" | "interrupt">;
  unifiedCliTaskRegistry: Pick<UnifiedCliTaskRegistry, "findLatestTaskForPane">;
  gatewayRepositoryFor: () => GatewayRepository;
  publicCredentialHost: ReturnType<typeof createPublicCredentialHost>;
};

/**
 * The toolbar and system analytics block of app.ts (moved verbatim, ARCH-001 step 88): the CLI session
 * stats of the CLI hosts, the system services, the host memory details with each session's task title, the detached-session
 * reaper and the session terminator, the model stats, the system analytics service with its live sessions, and the OpenCode
 * model bench with its daily refresh outside tests. Returns every provider app.ts hands to the routes.
 */
export function createSystemAnalyticsServices(deps: SystemAnalyticsDeps) {
  const { options, config, store, cliTerminalManager, unifiedCliTaskRegistry, gatewayRepositoryFor, publicCredentialHost } = deps;
  const toolbarCliSessionStatsProvider =
    options.toolbarCliSessionStatsProvider ??
    createCliSessionStatsProvider({
      collect: async () => {
        const hosts = [
          { hostId: "main" as const, enabled: config.cliEnabled, runtimeId: "cli:codex" },
          { hostId: "root" as const, enabled: config.cliRootEnabled, runtimeId: "cli:root" }
        ].filter((host) => host.enabled);
        const settled = await Promise.all(hosts.map(async (host) => {
          try {
            return { ok: true as const, hostId: host.hostId, health: await cliTerminalManager.hostHealth(host.runtimeId) };
          } catch {
            return { ok: false as const, hostId: host.hostId };
          }
        }));
        if (hosts.length > 0 && settled.every((host) => !host.ok)) {
          throw new Error("Space CLI hosts are unavailable.");
        }
        return collectCliSessionStats({
          hosts: settled.flatMap((host) => host.ok ? [{ hostId: host.hostId, health: host.health }] : [])
        });
      }
    });
  const systemServicesProvider =
    options.systemServicesProvider ??
    createSystemServicesProvider({ collect: runSystemServicesCollector });
  const toolbarHostMemoryProvider =
    options.toolbarHostMemoryProvider ??
    createHostMemoryDetailsProvider({
      cliSessions: () => toolbarCliSessionStatsProvider(),
      resolveSessionTitle: async (paneId) => {
        try {
          const task = await unifiedCliTaskRegistry.findLatestTaskForPane(paneId);
          return task?.title ?? null;
        } catch {
          return null;
        }
      }
    });
  const toolbarCliSessionReaper = options.toolbarCliSessionReaper ?? (() => cliTerminalManager.reapDetachedSessions());
  const toolbarCliSessionTerminator = options.toolbarCliSessionTerminator ?? ((sessionId: string, traceId?: string) => cliTerminalManager.interrupt(sessionId, undefined, traceId));
  const toolbarModelStatsCollector = options.toolbarModelStatsCollector
    ?? createToolbarModelStatsCollector({ store });
  const systemAnalyticsService = options.systemAnalyticsService ?? new SystemAnalyticsService({
    repository: store instanceof PostgresSpaceStore
      ? PostgresSystemAnalyticsRepository.fromConnectionString(
          config.databaseUrl ?? (() => {
            throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
          })(),
          {
            max: 2,
            idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
            connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
          }
        )
      : new InMemorySystemAnalyticsRepository(),
    store,
    stateRoot: options.opencodeStateRoot,
    codexHome: config.codexAppServerHome ?? `${SPACE_AGENT_HOME}/.codex`,
    tokenUsage: tokenUsageSourcesFor(gatewayRepositoryFor, config.instanceJobs["token-usage-claude"]),
    liveSessions: async () => {
      const health = await Promise.all([
        cliTerminalManager.hostHealth("cli:codex").catch(() => null),
        config.cliRootEnabled ? cliTerminalManager.hostHealth("cli:root").catch(() => null) : Promise.resolve(null)
      ]);
      const unique = new Map<string, SystemAnalyticsLiveSession>();
      for (const session of health.flatMap((entry) => entry?.sessions ?? [])) {
        unique.set(session.cliSessionId, {
          cliSessionId: session.cliSessionId,
          paneId: session.paneId,
          roomId: session.roomId,
          runtimeId: session.runtimeId,
          codexThreadId: session.codexThreadId,
          modelId: session.modelId,
          reasoningEffort: session.reasoningEffort,
          pid: session.pid,
          status: session.status,
          attachmentCount: session.attachmentCount,
          startedAt: session.startedAt,
          detachedAt: session.detachedAt,
          endedAt: session.endedAt
        });
      }
      return [...unique.values()];
    }
  });
  const opencodeModelBenchService = options.opencodeModelBenchService ?? new OpencodeModelBenchService({
    execVerbose: publicCredentialHost
      ? (provider) => publicCredentialHost.openCodeModels(provider).then((stdout) => openCode2Models(stdout, provider)).catch(() => [])
      : undefined,
    repository: store instanceof PostgresSpaceStore
      ? PostgresSystemAnalyticsRepository.fromConnectionString(
          config.databaseUrl ?? (() => {
            throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
          })(),
          {
            max: 2,
            idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
            connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
          }
        )
      : new InMemorySystemAnalyticsRepository()
  });
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    opencodeModelBenchService.startDailyRefresh();
  }
  return { toolbarCliSessionStatsProvider, systemServicesProvider, toolbarHostMemoryProvider, toolbarCliSessionReaper, toolbarCliSessionTerminator,
    toolbarModelStatsCollector, systemAnalyticsService, opencodeModelBenchService };
}
