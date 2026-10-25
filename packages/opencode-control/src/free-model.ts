import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Free OpenCode Zen model checks shared by the daily picker (scripts/space-opencode-free-model-picker.mjs) and First Setup.
 * A model counts as working only after a full tool cycle (operator rule 2026-10-11): it reads a small file with its read
 * tool and answers with the random token inside it. A plain text reply is not enough, because some free models fail
 * upstream as soon as a task uses tools.
 */
export const openCodeDefaultFreeModel = "opencode/big-pickle";
const checkFile = "spaceapp-check.txt";
const checkPrompt = `Use the read tool to read the file ${checkFile} in the current directory, then reply with exactly its contents and nothing else.`;
const maxCandidates = 6;
const probeTimeoutMs = 45_000;

export interface OpenCodeRunResult { code: number | null; stdout: string; stderr: string }
export type OpenCodeExecute = (args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<OpenCodeRunResult>;

function parseEvents(stdout: string): Array<Record<string, any>> {
  return stdout.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function allPricesZero(value: unknown, depth: number): boolean {
  if (typeof value === "number") return value === 0;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return false;
  return Object.values(value).every((item) => allPricesZero(item, depth + 1));
}

/**
 * One OpenCode cost tier is free only when input and output are 0 and every other price in it (cache read and write, any
 * further dimension) is 0 too. A missing, null or non-numeric price is unknown, never zero (review 2026-10-21 #2: a tier
 * that bills cache passed the input/output check). A tier without a cache field has no cache price.
 */
export function isFreeCostTier(tier: unknown): boolean {
  if (!tier || typeof tier !== "object" || Array.isArray(tier)) return false;
  const prices = tier as Record<string, unknown>;
  if (prices.input !== 0 || prices.output !== 0) return false;
  if ("cache" in prices && (prices.cache === null || typeof prices.cache !== "object" || Array.isArray(prices.cache))) return false;
  return allPricesZero(prices, 0);
}

/** Free (every price of every cost tier zero), tool-capable, active OpenCode Zen models from OpenCode 2's /api/model JSON, newest first. */
export function parseFreeModelCatalog(text: string): string[] {
  let models: unknown = [];
  try { models = JSON.parse(text)?.data ?? []; } catch {}
  return (Array.isArray(models) ? models : [])
    .filter((model) =>
      model?.providerID === "opencode" &&
      Array.isArray(model.cost) && model.cost.length > 0 && model.cost.every(isFreeCostTier) &&
      model.capabilities?.tools === true &&
      model.status === "active" &&
      model.enabled !== false
    )
    .sort((a, b) => (b.time?.released ?? 0) - (a.time?.released ?? 0))
    .map((model) => `opencode/${model.id}`);
}

/**
 * True only for a completed read tool call followed by an answer with the file token. OpenCode 2 standalone runs
 * exit before printing the last step_finish (2.0.31, every run); there the clean exit after the answer ends the turn.
 */
export function toolCycleSucceeded(result: OpenCodeRunResult, token: string, { finishEvent = true } = {}): boolean {
  if (result.code !== 0 || !token) return false;
  const events = parseEvents(result.stdout);
  if (events.some((event) => event.type === "error")) return false;
  const tool = events.findIndex(
    (event) => event.type === "tool_use" && event.part?.tool === "read" && event.part?.state?.status === "completed"
  );
  if (tool < 0) return false;
  const answer = events.findIndex((event, index) => index > tool && event.type === "text" && event.part?.text?.includes(token));
  return answer > tool && (!finishEvent || events.some((event, index) => index > answer && event.type === "step_finish"));
}

/**
 * An owner's preferred model first (null: Auto), then Big Pickle (the operator's default, 2026-10-11), then the current
 * choice so a working fallback stays, then the catalog.
 */
export function orderFreeModelCandidates(catalog: string[], current: string | null, preferredModel: string | null = null): string[] {
  const preferred = [preferredModel, openCodeDefaultFreeModel, current].filter((id): id is string => Boolean(id) && catalog.includes(id!));
  return [...new Set([...preferred, ...catalog])].slice(0, maxCandidates);
}

function errorMessage(stdout: string, stderr: string, code: number | null): string {
  const failure = parseEvents(stdout).find((event) => event.type === "error");
  const message = failure?.error?.data?.message ?? failure?.error?.message ?? failure?.error?.name ?? stderr.trim();
  return (message || `Exit code ${code}`).slice(0, 160);
}

/** Runs one OpenCode command; `command` is the binary (PATH lookup by default). */
export function openCodeExecutor(command = "opencode"): OpenCodeExecute {
  return (args, { env, cwd, timeoutMs, signal }) => new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // OpenCode 2's run waits for EOF on an open stdin.
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stop = () => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    };
    const timer = setTimeout(stop, timeoutMs);
    if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => { if (stdout.length < 1_000_000) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 100_000) stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: error.message }); });
    child.once("close", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", stop);
      resolve({ code: timedOut ? 124 : code, stdout, stderr });
    });
  });
}

/** Isolated HOME/XDG so a check never reads or changes an owner's OpenCode config, sessions or the panes' store. */
export async function isolatedOpenCodeEnvironment(root = tmpdir()) {
  const directory = await mkdtemp(join(root, "space-free-model-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: "C.UTF-8", USER: process.env.USER, HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state")
  };
  const work = join(directory, "work");
  await mkdir(work);
  return { directory, env, work };
}

/** The text of a finished `run --format json`, or null when it failed or reported an error. */
export function openCodeRunText(result: OpenCodeRunResult): string | null {
  if (result.code !== 0) return null;
  const events = parseEvents(result.stdout);
  if (events.some((event) => event.type === "error")) return null;
  const text = events.filter((event) => event.type === "text" && typeof event.part?.text === "string").map((event) => event.part.text).join("").trim();
  return text || null;
}

/** The free model catalog through OpenCode 2's API; --standalone keeps the per-user background service off. */
export async function listFreeModels(options: { env: NodeJS.ProcessEnv; cwd: string; execute: OpenCodeExecute; timeoutMs?: number; signal?: AbortSignal }) {
  const listed = await options.execute(["api", "GET", "/api/model", "--standalone"],
    { env: options.env, cwd: options.cwd, timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal });
  return listed.code === 0 ? parseFreeModelCatalog(listed.stdout) : [];
}

export async function probeFreeModel(modelId: string, options: { env: NodeJS.ProcessEnv; work: string; execute: OpenCodeExecute; timeoutMs?: number }) {
  const token = `SPACEAPP-${randomBytes(6).toString("hex")}`;
  await writeFile(join(options.work, checkFile), `${token}\n`);
  const started = performance.now();
  // --standalone: OpenCode 2 would otherwise start its per-user background service for the run; such a run ends without
  // its last step_finish.
  const result = await options.execute(["run", "--standalone", "--format", "json", "--model", modelId, checkPrompt],
    { env: options.env, cwd: options.work, timeoutMs: options.timeoutMs ?? probeTimeoutMs });
  const ok = toolCycleSucceeded(result, token, { finishEvent: false });
  return {
    modelId,
    ok,
    latencyMs: Math.round(performance.now() - started),
    error: ok ? null : result.code === 124 ? "TIMEOUT" : errorMessage(result.stdout, result.stderr, result.code)
  };
}
