import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { PostgresSpaceStore, PostgresStreamingBotRepository, PostgresStreamingRepository } from "@space/db";
import { StreamingCredentialStore } from "@space/streaming";
import { TelegramDeliveryWorker, TelegramSecretStore } from "@space/runtime";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";
import { sweepCodexCliCompletions } from "./codex-cli-completion.js";
import { DEFAULT_TASK_QUEUE, DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "./constants.js";
import { runTelegramNotificationCycle, TelegramNotificationLoop } from "./telegram-notification-runtime.js";
import { StreamingBotLoop, createSpaceBotMemoryStore, runStreamingBotCycle } from "./streaming-bot-runtime.js";

const address = process.env.SPACE_TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
const namespace = process.env.SPACE_TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE;
const taskQueue = process.env.SPACE_TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE;
const workflowsPath = fileURLToPath(new URL("./workflows.js", import.meta.url));

function boundedInterval(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "2000", 10);
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(parsed, 60_000)) : 2_000;
}

const connection = await NativeConnection.connect({ address });
const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath,
  activities
});

let telegramNotificationLoop: TelegramNotificationLoop | null = null;
let streamingBotLoop: StreamingBotLoop | null = null;
let notificationStore: PostgresSpaceStore | null = null;
const databaseUrl = process.env.SPACE_DATABASE_URL;
if (databaseUrl) {
  notificationStore = PostgresSpaceStore.fromConnectionString(databaseUrl);
  const spaceStore = notificationStore;
  const telegramPersistence = notificationStore.createTelegramPersistence();
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

if (databaseUrl) {
  const streamingRepository = PostgresStreamingRepository.fromConnectionString(databaseUrl);
  const botRepository = PostgresStreamingBotRepository.fromConnectionString(databaseUrl);
  streamingBotLoop = new StreamingBotLoop({
    intervalMs: boundedInterval(process.env.SPACE_STREAMING_BOT_INTERVAL_MS),
    runCycle: async () => {
      const result = await runStreamingBotCycle({
        streamingRepository,
        botRepository,
        credentialStore: new StreamingCredentialStore(
          process.env.SPACE_STREAMING_SECRET_ROOT || "/opt/spaceapp/var/streaming-secrets"
        ),
        memoryStore: createSpaceBotMemoryStore(notificationStore!),
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

console.log(JSON.stringify({ service: "space-worker", address, namespace, taskQueue, status: "running" }));
try {
  await worker.run();
} finally {
  telegramNotificationLoop?.stop();
  streamingBotLoop?.stop();
}
