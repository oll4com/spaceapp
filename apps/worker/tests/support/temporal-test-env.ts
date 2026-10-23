/**
 * Real Temporal test environment for workflow sandbox tests.
 *
 * Spins up the real time-skipping test server (the same
 * `temporal-test-server` binary `TestWorkflowEnvironment.createTimeSkipping()`
 * downloads; the SDK's Rust launcher hangs in this sandbox, so the binary is
 * launched directly) and one Worker per task queue used by the workflows
 * under test: "test-main" plus the memory maintenance/mutation queues. All
 * Workers share the same compiled workflow bundle
 * (tests/support/test-workflows.ts) and the same stub activity
 * implementations.
 *
 * Time skipping works exactly as with the SDK-managed environment: the
 * client is a TimeSkippingWorkflowClient, so awaiting a workflow result
 * unlocks time skipping on the test server; `unlockTimeSkipping()` /
 * `lockTimeSkipping()` allow manual control while polling for side effects.
 *
 * The workflow bundle is compiled with webpack; the hook below adds the same
 * @space/* source aliases vitest uses so `npm test` works straight after
 * `npm ci` without building the packages first.
 *
 * One env per test file: create in beforeAll, tear down in afterAll.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { InternalConnectionOptionsSymbol } from "@temporalio/client/lib/connection";
import { TimeSkippingWorkflowClient } from "@temporalio/testing";
import { NativeConnection, Worker } from "@temporalio/worker";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "@space/contracts";

const supportDir = fileURLToPath(new URL(".", import.meta.url));
// apps/worker/tests/support -> repo root
const repoRoot = resolve(supportDir, "..", "..", "..", "..");

export const TEST_SERVER_BIN =
  process.env.TEMPORAL_TEST_SERVER_BIN ??
  join(homedir(), ".cache", "temporal-test-server", "temporal-test-server-sdk-typescript-1.24.0");

function assertTestServerPresent(): void {
  if (!existsSync(TEST_SERVER_BIN)) {
    throw new Error(
      `Temporal test server binary not found at ${TEST_SERVER_BIN}. ` +
        `Download it (the same binary TestWorkflowEnvironment.createTimeSkipping() fetches) ` +
        `and set TEMPORAL_TEST_SERVER_BIN to its path.`
    );
  }
}

function aliasWebpackConfig(config: { resolve?: { alias?: unknown } }) {
  config.resolve ??= {};
  const alias = (config.resolve.alias ?? {}) as Record<string, string>;
  for (const pkg of ["contracts", "runtime", "db", "streaming", "memory-graph"] as const) {
    alias[`@space/${pkg}`] = resolve(repoRoot, "packages", pkg, "src", "index.ts");
  }
  config.resolve.alias = alias;
  return config;
}

async function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const open = await new Promise<boolean>((resolvePromise) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.on("error", () => resolvePromise(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolvePromise(false);
      });
    });
    if (open) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for the test server on port ${port}.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

export interface TemporalTestEnv {
  /** Client whose workflow handle `result()` automatically time-skips. */
  client: Client;
  /** Raw connection (exposes testService for manual time control). */
  connection: Connection;
  nativeConnection: NativeConnection;
  workers: Worker[];
  /** Manually unlock server time skipping (e.g. while polling for side effects). */
  unlockTimeSkipping: () => Promise<void>;
  /** Re-lock server time skipping. */
  lockTimeSkipping: () => Promise<void>;
  teardown: () => Promise<void>;
}

export const TEST_MAIN_TASK_QUEUE = "test-main";

export async function createTemporalTestEnv(
  workflowsPath: string,
  activities: Record<string, (...args: any[]) => unknown>
): Promise<TemporalTestEnv> {
  assertTestServerPresent();
  const port = 17233 + Math.floor(Math.random() * 2000);
  const server: ChildProcess = spawn(TEST_SERVER_BIN, [String(port)], { stdio: "ignore" });
  const spawnError = new Promise<never>((_, reject) => {
    server.once("error", (err) =>
      reject(new Error(`Failed to start temporal test server at ${TEST_SERVER_BIN}: ${err.message}`))
    );
  });
  try {
    await Promise.race([waitForPort(port), spawnError]);
    return await connectEnv(server, port, workflowsPath, activities);
  } catch (error) {
    server.kill("SIGTERM");
    throw error;
  }
}

async function connectEnv(
  server: ChildProcess,
  port: number,
  workflowsPath: string,
  activities: Record<string, (...args: any[]) => unknown>
): Promise<TemporalTestEnv> {
  const address = `127.0.0.1:${port}`;

  const connectionOptions = { [InternalConnectionOptionsSymbol]: { supportsTestService: true } } as object;
  const connection = await Connection.connect({ address, ...connectionOptions });
  const nativeConnection = await NativeConnection.connect({ address, ...connectionOptions });

  const client = new Client({ connection, namespace: "default" });
  // Swap in the time-skipping workflow client (same trick TimeSkippingClient uses).
  Object.defineProperty(client, "workflow", {
    value: new TimeSkippingWorkflowClient({ connection, namespace: "default" })
  });

  const taskQueues = [TEST_MAIN_TASK_QUEUE, MEMORY_MAINTENANCE_TASK_QUEUE, MEMORY_MUTATION_TASK_QUEUE];
  const workers: Worker[] = [];
  for (const taskQueue of taskQueues) {
    workers.push(
      await Worker.create({
        connection: nativeConnection,
        namespace: "default",
        taskQueue,
        workflowsPath,
        activities,
        bundlerOptions: workflowBundlerOptions()
      })
    );
  }
  const runPromises = workers.map((worker) => worker.run().then(
    () => undefined,
    () => undefined
  ));

  const testService = connection.testService;
  if (!testService) throw new Error("TestService is not available on the test server connection.");

  return {
    client,
    connection,
    nativeConnection,
    workers,
    unlockTimeSkipping: () => testService.unlockTimeSkipping({}).then(() => undefined),
    lockTimeSkipping: () => testService.lockTimeSkipping({}).then(() => undefined),
    teardown: async () => {
      for (const worker of workers) worker.shutdown();
      await Promise.all(runPromises);
      await Promise.all([connection.close(), nativeConnection.close()]);
      server.kill("SIGTERM");
    }
  };
}

/** Absolute path of the standard workflow bundle entry used by sandbox tests. */
export function testWorkflowsPath(): string {
  return join(supportDir, "test-workflows.ts");
}

/** Absolute path of the replay bundle (legacy history maps to the dispatcher). */
export function replayWorkflowsPath(): string {
  return join(supportDir, "replay-workflows.ts");
}

/** Absolute path of the negative-control replay bundle. */
export function replayVariantWorkflowsPath(): string {
  return join(supportDir, "replay-variant-workflows.ts");
}

/** Bundler options shared by sandbox Workers and replay Workers. */
export function workflowBundlerOptions(): { webpackConfigHook: (config: any) => any } {
  return { webpackConfigHook: aliasWebpackConfig as (config: any) => any };
}
