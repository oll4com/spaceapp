/**
 * Shared harness for the real Temporal time-skipping tests (issue #60).
 *
 * Every test runs the REAL workflow code inside the workflow sandbox via
 * {@link TestWorkflowEnvironment.createTimeSkipping} with fully stubbed
 * activities. No network, database, Docker or AI provider is required.
 *
 * The workflow bundle is created with the SDK's own `bundleWorkflowCode`,
 * using a `webpackConfigHook` to resolve the `@space/*` workspace packages
 * to their TypeScript sources - the same aliases `vitest.config.ts` uses -
 * so the tests exercise the TypeScript sources directly (no build step
 * needed for `npm test -w @space/worker`).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment, type TestWorkflowEnvironmentOptions } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkerOptions } from "@temporalio/worker";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../../../..");
const PACKAGES = resolve(ROOT, "packages");

export const MAIN_TASK_QUEUE = "temporal-sandbox-tests";
export const MEMORY_MAINTENANCE_TASK_QUEUE = "space-memory-maintenance";
export const MEMORY_MUTATION_TASK_QUEUE = "space-memory-mutations";

/** Resolves `@space/*` workspace packages to their TypeScript sources. */
const workflowBundleAliases: Record<string, string> = {
  "@space/contracts": resolve(PACKAGES, "contracts/src/index.ts"),
  "@space/db": resolve(PACKAGES, "db/src/index.ts"),
  "@space/runtime": resolve(PACKAGES, "runtime/src/index.ts"),
  "@space/streaming": resolve(PACKAGES, "streaming/src/index.ts")
};

export interface WorkflowBundle {
  code: string;
  entry: string;
}

const bundleCache = new Map<string, WorkflowBundle>();

/**
 * Bundles a TypeScript module exporting workflow functions into the
 * in-memory CommonJS bundle the worker loads in its workflow isolate.
 */
export async function buildWorkflowBundle(entry: string): Promise<WorkflowBundle> {
  const cached = bundleCache.get(entry);
  if (cached) return cached;
  const { code } = await bundleWorkflowCode({
    workflowsPath: entry,
    webpackConfigHook: (config) => {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias as Record<string, string> | undefined),
        ...workflowBundleAliases
      };
      return config;
    }
  });
  const bundle: WorkflowBundle = { code, entry };
  bundleCache.set(entry, bundle);
  return bundle;
}

/** The default bundle: every production workflow (all 8 from issue #60). */
export function allWorkflowsEntry(): string {
  return resolve(__dirname, "../support/all-workflows.ts");
}

/** TEST-ONLY entry replaying the pre-patch supervisor branch (issue #60). */
export function legacySupervisorEntry(): string {
  return resolve(__dirname, "../support/legacy-supervisor-recording.ts");
}

export interface SandboxEnv {
  testEnv: TestWorkflowEnvironment;
  queues: Map<string, Worker>;
  startWorker(taskQueue: string, activities: Record<string, unknown>, bundle?: WorkflowBundle): Promise<Worker>;
  teardown(): Promise<void>;
}

export async function createSandboxEnv(
  options: TestWorkflowEnvironmentOptions = {}
): Promise<SandboxEnv> {
  const testEnv = await TestWorkflowEnvironment.createTimeSkipping(options);
  const queues = new Map<string, Worker>();
  const runs: Promise<void>[] = [];

  const startWorker = async (taskQueue: string, activities: Record<string, unknown>, bundle?: WorkflowBundle) => {
    const existing = queues.get(taskQueue);
    if (existing) return existing;
    const usedBundle = bundle ?? (await buildWorkflowBundle(allWorkflowsEntry()));
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowBundle: { code: usedBundle.code },
      activities: activities as WorkerOptions["activities"],
      maxConcurrentWorkflowTaskExecutions: 10
    } as WorkerOptions);
    runs.push(worker.run());
    queues.set(taskQueue, worker);
    return worker;
  };

  const teardown = async () => {
    for (const worker of queues.values()) worker.shutdown();
    queues.clear();
    await Promise.allSettled(runs);
    await testEnv.teardown();
  };

  return { testEnv, queues, startWorker, teardown };
}

/** Waits until predicate() is true, polling with a short interval. */
export async function waitFor(predicate: () => boolean, timeoutMs = 15000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Waits until the workflow handle points at a new run (continueAsNew). */
export async function waitForRunIdChange(
  handle: { describe(): Promise<{ runId: string }> },
  previousRunId: string,
  timeoutMs = 30000
): Promise<{ runId: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const description = await handle.describe();
    if (description.runId !== previousRunId) return description;
    if (Date.now() > deadline) throw new Error("Timed out waiting for continueAsNew");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
