import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundle } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { temporal } from "@temporalio/proto";

export const fixtureDirectory = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));
const entry = fileURLToPath(new URL("./sandbox-workflows.ts", import.meta.url));
const productionWorkflows = fileURLToPath(new URL("../../src/workflows.ts", import.meta.url));
const loader = fileURLToPath(new URL("./sandbox-variant-loader.cjs", import.meta.url));
const contracts = fileURLToPath(new URL("../../../../packages/contracts/src/index.ts", import.meta.url));
const logger = new DefaultLogger("ERROR");

export async function workflowBundle(variant?: "legacy" | "negative"): Promise<WorkflowBundle> {
  return bundleWorkflowCode({ workflowsPath: entry, logger, webpackConfigHook(config) {
    // Match the production package's source, including on a fresh npm ci before
    // workspace builds. This changes module resolution, not workflow behavior.
    config.resolve!.alias = { ...config.resolve!.alias, "@space/contracts$": contracts };
    if (variant) config.module!.rules!.push({ test: resource => resource === productionWorkflows,
      enforce: "pre", use: { loader, options: { variant } } });
    return config;
  } });
}

export function deferred<T = void>() {
  let settled = false;
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, get settled() { return settled; }, resolve(value: T | PromiseLike<T>) { settled = true; resolve(value); }, reject };
}

export async function sandbox() {
  // Each suite owns a disposable real server and tears it down in afterAll.
  Runtime.install({ logger });
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  return { env, bundle: await workflowBundle() };
}

export async function runInWorker<T>(env: TestWorkflowEnvironment, bundle: WorkflowBundle,
  activities: Record<string, (...args: any[]) => any>, task: (taskQueue: string) => Promise<T>) {
  const taskQueue = `sandbox-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace,
    workflowBundle: bundle, taskQueue, identity: "space-temporal-synthetic-test", activities });
  return worker.runUntil(() => task(taskQueue));
}

export async function saveHistory(name: string, handle: { fetchHistory(): Promise<any> }) {
  const history = await handle.fetchHistory();
  if (process.env.SPACE_RECORD_TEMPORAL_HISTORIES === "1" &&
      !name.endsWith("-continue") && !name.endsWith("-polls") && !name.endsWith("-250polls")) {
    await mkdir(fixtureDirectory, { recursive: true });
    const json = temporal.api.history.v1.History.toObject(history, { longs: String, enums: String, bytes: String });
    // Only non-command diagnostic metadata is normalized. Retain every event,
    // command, payload, marker, ordering and ID for real replay validation.
    const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize) :
      value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, nested]) =>
        [key, key === "identity" ? "space-temporal-synthetic-test" : key === "stackTrace" ? "Synthetic test failure" : normalize(nested)])) : value;
    const patch = process.env.SPACE_TEMPORAL_HISTORY_PATCH;
    if (patch && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(patch)) throw Error("Invalid history patch ID");
    await writeFile(join(fixtureDirectory, `${name}${patch ? `--${patch}` : ""}.json`),
      JSON.stringify(normalize(json), null, 2) + "\n", { encoding: "utf8", flag: patch ? "wx" : "w" });
  }
  return history;
}

export async function histories() {
  const files = (await readdir(fixtureDirectory)).filter(name => name.endsWith(".json")).sort();
  return Promise.all(files.map(async file => ({ workflowId: file,
    history: temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(join(fixtureDirectory, file), "utf8"))) })));
}
