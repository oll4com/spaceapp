import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { PostgresSpaceStore } from "@space/db";
import { TelegramDeliveryWorker, TelegramSecretStore } from "@space/runtime";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";
import { sweepCodexCliCompletions } from "./codex-cli-completion.js";
import { DEFAULT_TASK_QUEUE, DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "./constants.js";
import { runTelegramNotificationCycle, TelegramNotificationLoop } from "./telegram-notification-runtime.js";

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
const databaseUrl = process.env.SPACE_DATABASE_URL;
if (databaseUrl) {
  const notificationStore = PostgresSpaceStore.fromConnectionString(databaseUrl);
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
        store: notificationStore,
        persistence: telegramPersistence,
        deliveryWorker,
        manifestPath:
          process.env.SPACE_TELEGRAM_OWNERSHIP_MANIFEST ||
          "/opt/spaceapp/var/integrations/telegram/space-codex-thread-ownership.json",
        sweep: () => sweepCodexCliCompletions({
          store: notificationStore,
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

console.log(JSON.stringify({ service: "space-worker", address, namespace, taskQueue, status: "running" }));
try {
  await worker.run();
} finally {
  telegramNotificationLoop?.stop();
}
