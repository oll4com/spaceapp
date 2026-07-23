import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  SpaceStore,
  TelegramDeliveryWorker,
  TelegramOutboxPersistence
} from "@space/runtime";
import type { CodexCliCompletionSweepSummary } from "./codex-cli-completion.js";

export interface SpaceCodexOwnershipManifest {
  schemaVersion: 1;
  owner: "space";
  active: boolean;
  threadIds: string[];
  updatedAt: string;
}

export interface WriteSpaceCodexOwnershipManifestInput {
  manifestPath: string;
  active: boolean;
  threadIds: string[];
  updatedAt: string;
}

export interface SpaceCodexOwnershipManifestWriteResult {
  active: boolean;
  threadCount: number;
  manifestPath: string;
  changed: boolean;
}

function safeThreadIds(threadIds: string[]): string[] {
  return [...new Set(threadIds.filter((threadId) => /^[A-Za-z0-9:_.-]{1,200}$/.test(threadId)))].sort();
}

export async function writeSpaceCodexOwnershipManifest(
  input: WriteSpaceCodexOwnershipManifestInput
): Promise<SpaceCodexOwnershipManifestWriteResult> {
  const directory = dirname(input.manifestPath);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await chmod(directory, 0o755);
  const threadIds = safeThreadIds(input.threadIds);
  const manifest: SpaceCodexOwnershipManifest = {
    schemaVersion: 1,
    owner: "space",
    active: input.active,
    threadIds,
    updatedAt: input.updatedAt
  };
  try {
    const existing = JSON.parse(await readFile(input.manifestPath, "utf8")) as Partial<SpaceCodexOwnershipManifest>;
    if (
      existing.schemaVersion === 1 &&
      existing.owner === "space" &&
      existing.active === manifest.active &&
      Array.isArray(existing.threadIds) &&
      existing.threadIds.length === threadIds.length &&
      existing.threadIds.every((threadId, index) => threadId === threadIds[index])
    ) {
      await chmod(input.manifestPath, 0o644);
      return {
        active: manifest.active,
        threadCount: threadIds.length,
        manifestPath: input.manifestPath,
        changed: false
      };
    }
  } catch {
    // Missing or invalid manifests are replaced atomically below.
  }
  const temporaryPath = `${input.manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await chmod(temporaryPath, 0o644);
    await rename(temporaryPath, input.manifestPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { active: manifest.active, threadCount: threadIds.length, manifestPath: input.manifestPath, changed: true };
}

type DeliverySummary = Awaited<ReturnType<TelegramDeliveryWorker["runOnce"]>>;

export async function runTelegramNotificationCycle(input: {
  store: Pick<SpaceStore, "listManagedCodexThreadIds">;
  persistence: Pick<TelegramOutboxPersistence, "getIntegration">;
  deliveryWorker: Pick<TelegramDeliveryWorker, "runOnce">;
  sweep: () => Promise<CodexCliCompletionSweepSummary>;
  manifestPath: string;
  now?: () => Date;
  writeManifest?: typeof writeSpaceCodexOwnershipManifest;
}): Promise<{
  manifest: SpaceCodexOwnershipManifestWriteResult;
  sweep: CodexCliCompletionSweepSummary;
  delivery: DeliverySummary;
}> {
  const now = input.now ?? (() => new Date());
  const [integration, threadIds] = await Promise.all([
    input.persistence.getIntegration(),
    input.store.listManagedCodexThreadIds()
  ]);
  const writeManifest = input.writeManifest ?? writeSpaceCodexOwnershipManifest;
  const manifest = await writeManifest({
    manifestPath: input.manifestPath,
    active:
      integration.connectionStatus === "CONNECTED" &&
      integration.isEnabled &&
      integration.legacySuppressionActive,
    threadIds,
    updatedAt: now().toISOString()
  });
  const sweep = await input.sweep();
  const delivery = await input.deliveryWorker.runOnce();
  return { manifest, sweep, delivery };
}

export interface TelegramNotificationLoopLog {
  status: "COMPLETED" | "FAILED";
  safeErrorCode: "TELEGRAM_NOTIFICATION_CYCLE_FAILED" | null;
}

export class TelegramNotificationLoop {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: {
    intervalMs: number;
    runCycle: () => Promise<unknown>;
    log?: (record: TelegramNotificationLoopLog) => void;
  }) {}

  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await this.options.runCycle();
      this.options.log?.({ status: "COMPLETED", safeErrorCode: null });
    } catch {
      this.options.log?.({ status: "FAILED", safeErrorCode: "TELEGRAM_NOTIFICATION_CYCLE_FAILED" });
    } finally {
      this.running = false;
    }
    return true;
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), Math.max(1_000, this.options.intervalMs));
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
