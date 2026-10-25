import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { assertDevInstanceIsolated, instanceBackgroundJobEnabled } from "@space/contracts";
import { PostgresSpaceStore, PostgresStreamingBotRepository, PostgresStreamingRepository } from "@space/db";
import { StreamingCredentialStore } from "@space/streaming";
import { TelegramDeliveryWorker, TelegramSecretStore, otlpSpanExporterFromEnv } from "@space/runtime";
import { NativeConnection, Runtime, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import { resolveTemporalCoreMetricsBind, resolveWorkerMetricsListen, startWorkerMetricsServer } from "./worker-metrics.js";
import { workerLog } from "./worker-log.js";
import { sweepCodexCliCompletions } from "./codex-cli-completion.js";
import { DEFAULT_TASK_QUEUE, DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "./constants.js";
import { runTelegramNotificationCycle, TelegramNotificationLoop } from "./telegram-notification-runtime.js";
import { StreamingBotLoop, createSpaceBotMemoryStore, runStreamingBotCycle } from "./streaming-bot-runtime.js";
import { CHESS_MOVE_SOCKET, startChessMoveServer } from "./chess-cli-move.js";
import { NOUS_TURN_MAX_BODY_BYTES, NousTurnInputError, runNousTurn, validateNousTurnInput } from "./nous-turn.js";

assertDevInstanceIsolated(process.env, "worker");
const address = process.env.SPACE_TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
const namespace = process.env.SPACE_TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE;
const taskQueue = process.env.SPACE_TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE;
const workflowsPath = fileURLToPath(new URL("./workflows.js", import.meta.url));

function boundedInterval(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "2000", 10);
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(parsed, 60_000)) : 2_000;
}

// Optional Temporal SDK Prometheus exporter (workflow-task latency, poll and
// slot metrics). Loopback only and off unless SPACE_WORKER_TEMPORAL_METRICS_BIND
// is set; it must be installed before the first native connection.
const temporalCoreMetricsBind = resolveTemporalCoreMetricsBind();
if (temporalCoreMetricsBind) {
  Runtime.install({ telemetryOptions: { metrics: { prometheus: { bindAddress: temporalCoreMetricsBind } } } });
}

const connection = await NativeConnection.connect({ address });
const spans = otlpSpanExporterFromEnv(process.env, "space-worker");
const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath,
  activities,
  // Structured, correlated activity records and worker metrics. Activity-side
  // only: the workflow sandbox and its replay behaviour are unchanged.
  interceptors: { activity: [createActivityObservabilityInterceptors({ spans })] }
});

// Optional loopback-only Prometheus endpoint for worker metrics.
const metricsListen = resolveWorkerMetricsListen();
if (metricsListen) {
  const metricsServer = await startWorkerMetricsServer(metricsListen);
  workerLog(metricsServer ? "info" : "warn", "worker.metrics_endpoint", {
    status: metricsServer ? "LISTENING" : "UNAVAILABLE",
    port: metricsListen.port
  });
}

let telegramNotificationLoop: TelegramNotificationLoop | null = null;
let streamingBotLoop: StreamingBotLoop | null = null;
let notificationStore: PostgresSpaceStore | null = null;
const databaseUrl = process.env.SPACE_DATABASE_URL;
// A dev instance runs on a copy of stable's data, so these loops would resend stable's messages.
const telegramBridgeEnabled = instanceBackgroundJobEnabled(process.env, "telegram-bridge");
const streamingBotEnabled = instanceBackgroundJobEnabled(process.env, "streaming-bot");
if (databaseUrl && (telegramBridgeEnabled || streamingBotEnabled)) {
  notificationStore = PostgresSpaceStore.fromConnectionString(databaseUrl);
}
if (databaseUrl && telegramBridgeEnabled) {
  const spaceStore = notificationStore!;
  const telegramPersistence = spaceStore.createTelegramPersistence();
  const workerId = `space-worker:${hostname()}:${process.pid}`;
  const deliveryWorker = new TelegramDeliveryWorker({
    persistence: telegramPersistence,
    secrets: new TelegramSecretStore(process.env.SPACE_TELEGRAM_SECRET_ROOT || "/opt/spaceapp/secrets/telegram"),
    workerId,
    log: (record) => console.log(JSON.stringify({
      service: "space-worker",
      component: "telegram-delivery",
      ...record
    }))
  });
  telegramNotificationLoop = new TelegramNotificationLoop({
    intervalMs: boundedInterval(process.env.SPACE_TELEGRAM_WORKER_INTERVAL_MS),
    runCycle: async () => {
      const result = await runTelegramNotificationCycle({
        store: spaceStore,
        persistence: telegramPersistence,
        deliveryWorker,
        manifestPath:
          process.env.SPACE_TELEGRAM_OWNERSHIP_MANIFEST ||
          "/opt/spaceapp/var/integrations/telegram/space-codex-thread-ownership.json",
        sweep: () => sweepCodexCliCompletions({
          store: spaceStore,
          workerId,
          codexHome: process.env.SPACE_CODEX_HOME || "/var/lib/spaceapp-user/.codex",
          log: (record) => console.log(JSON.stringify({
            service: "space-worker",
            component: "telegram-terminal-sweep",
            ...record
          }))
        })
      });
      if (result.manifest.changed || result.sweep.claimed > 0 || result.delivery.claimed > 0) {
        console.log(JSON.stringify({
          service: "space-worker",
          component: "telegram-notification-cycle",
          status: "COMPLETED",
          manifestActive: result.manifest.active,
          manifestChanged: result.manifest.changed,
          managedThreadCount: result.manifest.threadCount,
          sweep: result.sweep,
          delivery: result.delivery
        }));
      }
    },
    log: (record) => {
      if (record.status === "FAILED") {
        console.error(JSON.stringify({ service: "space-worker", component: "telegram-notification-cycle", ...record }));
      }
    }
  });
  telegramNotificationLoop.start();
}

if (databaseUrl && streamingBotEnabled) {
  const streamingRepository = PostgresStreamingRepository.fromConnectionString(databaseUrl);
  const botRepository = PostgresStreamingBotRepository.fromConnectionString(databaseUrl);
  streamingBotLoop = new StreamingBotLoop({
    intervalMs: boundedInterval(process.env.SPACE_STREAMING_BOT_INTERVAL_MS),
    runCycle: async () => {
      const result = await runStreamingBotCycle({
        streamingRepository,
        spaceStore: notificationStore!,
        botRepository,
        credentialStore: new StreamingCredentialStore(
          process.env.SPACE_STREAMING_SECRET_ROOT || "/opt/spaceapp/var/streaming-secrets"
        ),
        memoryStore: createSpaceBotMemoryStore(botRepository),
        youtubeDailyBudget: Number.parseInt(process.env.SPACE_STREAMING_YOUTUBE_DAILY_QUOTA_BUDGET ?? "8000", 10),
        youtubeReplyUnitCost: 10,
        internalApiBaseUrl: process.env.SPACE_STREAMING_BOT_API_BASE_URL || "http://127.0.0.1:4910",
        internalApiToken: process.env.SPACE_INTERNAL_API_TOKEN || null,
        mcpToolBridgeEnabled: process.env.SPACE_MCP_TOOL_BRIDGE_ENABLED === "true",
        log: (record) => console.log(JSON.stringify({ service: "space-worker", component: "streaming-bot-cycle", ...record }))
      });
      if (result.replies > 0 || result.errors > 0) {
        console.log(JSON.stringify({ service: "space-worker", component: "streaming-bot-cycle", status: "COMPLETED", ...result }));
      }
    },
    log: (record) => {
      if (record.status === "FAILED") {
        console.error(JSON.stringify({ service: "space-worker", component: "streaming-bot-cycle", ...record }));
      }
    }
  });
  streamingBotLoop.start();
}

// Chess benchmark CLI moves and Nous's turns for the API: CLI processes must run here, never in the API's cgroup.
const chessMoveServer = process.env.SPACE_CHESS_MOVE_SOCKET === "disabled"
  ? null
  : await startChessMoveServer(process.env.SPACE_CHESS_MOVE_SOCKET || CHESS_MOVE_SOCKET, undefined, {
    "/nous-turn": { maxBodyBytes: NOUS_TURN_MAX_BODY_BYTES, isInputError: (error) => error instanceof NousTurnInputError,
      handle: (body, signal) => runNousTurn(validateNousTurnInput(body), signal) }
  }).catch((error: unknown) => {
      workerLog("warn", "worker.chess_move_server", { status: "UNAVAILABLE", error: error instanceof Error ? error.message : String(error) });
      return null;
    });

console.log(JSON.stringify({ service: "space-worker", address, namespace, taskQueue, status: "running" }));
try {
  await worker.run();
} finally {
  telegramNotificationLoop?.stop();
  streamingBotLoop?.stop();
  chessMoveServer?.close();
  await spans?.close();
}
