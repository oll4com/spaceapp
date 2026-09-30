import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { DemoConnectionProvider, DemoLogEntry, DemoRunMode, DemoRunStatus } from "@space/contracts";
import type { DemoProjectsRepository, DemoRunRecord } from "@space/db";
import {
  findDemoProject,
  findDemoVariant,
  resolveServerEntry,
  resolveTemplateDirectory,
  type DemoProjectDefinition,
  type DemoVariantDefinition
} from "./catalog.js";

const maximumLogBytes = 1024 * 1024;
const retainedLogBytes = 256 * 1024;
const logReadLimit = 400;
const stopGraceMs = 5_000;

export class DemoRunError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "DemoRunError";
  }
}

export interface DemoRunManagerOptions {
  repository: DemoProjectsRepository;
  demoRoot: string;
  varRoot: string;
  apiPort: number;
  portRangeStart: number;
  portRangeEnd: number;
  healthTimeoutMs: number;
  previewBasePath: string;
  now?: () => Date;
  /** Overridable for tests: spawn replacement. */
  spawnProcess?: typeof spawn;
  fetchImpl?: typeof fetch;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface DemoStartedRun {
  run: DemoRunRecord;
  runToken: string;
}

interface ManagedProcess {
  child: ChildProcess;
  runId: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokenMatches(expectedHash: string, candidate: string): boolean {
  const candidateHash = Buffer.from(digest(candidate), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (candidateHash.length !== expected.length) return false;
  return timingSafeEqual(candidateHash, expected);
}

export function redactDemoLogLine(line: string, secrets: string[]): string {
  let redacted = line;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    if (redacted.includes(secret)) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]")
    .replace(/\b(refresh_token|access_token|client_secret|password|api_key|apikey)=([^\s&"']+)/gi, "$1=[REDACTED]")
    .replace(/\b00[013D][A-Za-z0-9]{12,17}\b/g, "[SALESFORCE-ID]");
}

export class DemoRunManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly logQueues = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly spawnProcess: typeof spawn;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (event: string, detail?: Record<string, unknown>) => void;

  constructor(private readonly options: DemoRunManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => undefined);
  }

  private get runsRoot(): string {
    return join(this.options.varRoot, "runs");
  }

  async initialize(): Promise<void> {
    await mkdir(this.runsRoot, { recursive: true, mode: 0o755 });
    await this.reconcile();
  }

  /**
   * A Space API restart may leave demo processes running. A recorded process is
   * adopted only when its command line still matches this variant's server entry
   * and its health endpoint answers; anything else is stopped and reported.
   */
  private async reconcile(): Promise<void> {
    const active = await this.options.repository.listActiveRuns();
    for (const run of active) {
      const variant = findDemoVariant(run.projectId, run.variantId);
      if (!variant) {
        await this.markFailed(run, "The variant is no longer part of the catalog.");
        continue;
      }
      const serverEntry = resolveServerEntry(this.options.demoRoot, variant);
      const adopted = await this.adoptIfAlive(run, serverEntry);
      if (adopted) continue;
      await this.markFailed(run, "The run was interrupted by a Space API restart.");
    }
  }

  private async adoptIfAlive(run: DemoRunRecord, serverEntry: string): Promise<boolean> {
    if (!run.pid || !run.port) return false;
    let commandLine = "";
    try {
      commandLine = await readFile(`/proc/${run.pid}/cmdline`, "utf8");
    } catch {
      return false;
    }
    if (!commandLine.includes(serverEntry)) return false;
    const health = await this.healthCheck(run.port);
    if (!health.ok) {
      await this.terminatePid(run.pid).catch(() => undefined);
      return false;
    }
    await this.options.repository.upsertRun({ ...run, status: "RUNNING", health });
    await this.appendLog(run.id, "system", "Adopted the running demo process after a Space API restart.");
    return true;
  }

  private async markFailed(run: DemoRunRecord, message: string): Promise<void> {
    await this.options.repository.upsertRun({
      ...run,
      status: "FAILED",
      port: null,
      pid: null,
      health: null,
      lastError: message,
      stoppedAt: this.now().toISOString()
    });
  }

  async getOwnedRun(ownerUserId: string, runId: string): Promise<DemoRunRecord | null> {
    const run = await this.options.repository.getRun(runId);
    if (!run || run.ownerUserId !== ownerUserId) return null;
    return run;
  }

  async requireOwnedRun(ownerUserId: string, runId: string): Promise<DemoRunRecord> {
    const run = await this.getOwnedRun(ownerUserId, runId);
    if (!run) throw new DemoRunError("DEMO_RUN_NOT_FOUND", "The demo run was not found.", 404);
    return run;
  }

  async findRunByRunToken(runId: string, token: string): Promise<DemoRunRecord | null> {
    const run = await this.options.repository.getRun(runId);
    if (!run) return null;
    if (run.status !== "RUNNING" && run.status !== "STARTING") return null;
    return tokenMatches(run.runTokenHash, token) ? run : null;
  }

  previewPath(run: DemoRunRecord): string {
    return `${this.options.previewBasePath}/${run.id}/${run.previewToken}/`;
  }

  async start(input: {
    ownerUserId: string;
    projectId: string;
    variantId: string;
    mode: DemoRunMode;
    connectionStatus?: (provider: DemoConnectionProvider) => Promise<boolean>;
  }): Promise<DemoStartedRun> {
    const project = findDemoProject(input.projectId);
    const variant = findDemoVariant(input.projectId, input.variantId);
    if (!project || !variant) throw new DemoRunError("DEMO_VARIANT_UNKNOWN", "The requested demo variant is not in the catalog.", 404);
    const existing = await this.options.repository.findActiveRun(input.ownerUserId, input.projectId, input.variantId);
    if (existing) {
      const healthy = existing.port ? await this.healthCheck(existing.port) : { ok: false, checkedAt: this.now().toISOString(), latencyMs: null, detail: null };
      if (healthy.ok) {
        const refreshed = await this.options.repository.upsertRun({ ...existing, status: "RUNNING", health: healthy, lastError: null });
        return { run: refreshed, runToken: "" };
      }
      await this.stop(input.ownerUserId, existing.id).catch(() => undefined);
    }
    if (input.mode === "LIVE") {
      await this.assertLiveReady(project, input.connectionStatus);
    }
    const nowIso = this.now().toISOString();
    const id = `demo-run:${randomBytes(9).toString("hex")}`;
    const workspacePath = join(this.runsRoot, id.replace(":", "-"));
    const dataPath = join(workspacePath, "data");
    const logPath = join(workspacePath, "run.log");
    await mkdir(dataPath, { recursive: true, mode: 0o755 });
    await this.rotateLogIfNeeded(logPath);
    const runToken = randomBytes(32).toString("base64url");
    const previewToken = randomBytes(24).toString("base64url");
    const reservation = await this.options.repository.upsertRun({
      id,
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      variantId: input.variantId,
      mode: input.mode,
      status: "STARTING",
      port: null,
      pid: null,
      previewToken,
      runTokenHash: digest(runToken),
      workspacePath,
      dataPath,
      logPath,
      health: null,
      lastError: null,
      startedAt: nowIso,
      stoppedAt: null
    });
    await this.appendLog(id, "system", `Starting ${project.name} · ${variant.label} in ${input.mode} mode.`);
    try {
      const started = await this.launch(reservation, variant, runToken);
      return { run: started, runToken };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The demo process failed to start.";
      await this.appendLog(id, "system", `Start failed: ${message}`);
      const failed = await this.options.repository.upsertRun({
        ...reservation,
        status: "FAILED",
        port: null,
        pid: null,
        health: null,
        lastError: message,
        stoppedAt: this.now().toISOString()
      });
      throw new DemoRunError("DEMO_START_FAILED", failed.lastError ?? message, 502);
    }
  }

  private async assertLiveReady(
    project: DemoProjectDefinition,
    connectionStatus: ((provider: DemoConnectionProvider) => Promise<boolean>) | undefined
  ): Promise<void> {
    if (!connectionStatus) {
      throw new DemoRunError("DEMO_CONNECTION_REQUIRED", "Live mode requires connected Salesforce and Google accounts.", 409);
    }
    const missing: string[] = [];
    for (const provider of project.requiresConnections) {
      const connected = await connectionStatus(provider);
      if (!connected) missing.push(provider === "salesforce" ? "Salesforce" : "Google Sheets");
    }
    if (missing.length > 0) {
      throw new DemoRunError(
        "DEMO_CONNECTION_REQUIRED",
        `Live mode requires these connections: ${missing.join(", ")}.`,
        409
      );
    }
  }

  private async launch(reservation: DemoRunRecord, variant: DemoVariantDefinition, runToken: string): Promise<DemoRunRecord> {
    const templateDirectory = resolveTemplateDirectory(this.options.demoRoot, variant);
    const serverEntry = resolveServerEntry(this.options.demoRoot, variant);
    const port = await this.allocatePort();
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DEMO_RUN_ID: reservation.id,
      DEMO_PROJECT_ID: reservation.projectId,
      DEMO_VARIANT_ID: reservation.variantId,
      DEMO_MODE: reservation.mode,
      DEMO_DATA_DIR: reservation.dataPath,
      DEMO_WORKSPACE_DIR: reservation.workspacePath,
      DEMO_LOG_DIR: reservation.workspacePath,
      DEMO_RUN_TOKEN: runToken,
      SPACE_API_BASE_URL: `http://127.0.0.1:${this.options.apiPort}`,
      DEMO_SOURCE_ROOT: templateDirectory
    };
    const child = this.spawnProcess(process.execPath, [serverEntry], {
      cwd: templateDirectory,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (!child.pid) throw new Error("The demo process did not report a pid.");
    const secrets = [runToken, reservation.previewToken];
    this.captureStream(reservation, child, "stdout", secrets);
    this.captureStream(reservation, child, "stderr", secrets);
    child.on("exit", (code, signal) => {
      this.processes.delete(reservation.id);
      void this.handleExit(reservation, code, signal);
    });
    this.processes.set(reservation.id, { child, runId: reservation.id });
    const health = await this.waitForHealth(port);
    if (!health.ok) {
      await this.terminatePid(child.pid);
      throw new Error(health.detail ?? "The demo preview did not answer its health check.");
    }
    const running = await this.options.repository.upsertRun({
      ...reservation,
      status: "RUNNING",
      port,
      pid: child.pid,
      health
    });
    await this.appendLog(reservation.id, "system", `Preview ready on 127.0.0.1:${port}.`);
    return running;
  }

  private async handleExit(reservation: DemoRunRecord, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const current = await this.options.repository.getRun(reservation.id).catch(() => null);
    if (!current) return;
    if (current.status === "STOPPED" || current.status === "FAILED") return;
    const message = `The demo process exited early (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}).`;
    await this.appendLog(reservation.id, "system", message);
    await this.options.repository.upsertRun({
      ...current,
      status: "FAILED",
      port: null,
      pid: null,
      health: null,
      lastError: message,
      stoppedAt: this.now().toISOString()
    });
  }

  private captureStream(run: DemoRunRecord, child: ChildProcess, stream: "stdout" | "stderr", secrets: string[]): void {
    const readable = stream === "stdout" ? child.stdout : child.stderr;
    if (!readable) return;
    let buffer = "";
    readable.setEncoding("utf8");
    readable.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) void this.appendLog(run.id, stream, line, secrets);
    });
    readable.on("end", () => {
      if (buffer.length > 0) void this.appendLog(run.id, stream, buffer, secrets);
      buffer = "";
    });
  }

  private async rotateLogIfNeeded(logPath: string): Promise<void> {
    try {
      const info = await stat(logPath);
      if (info.size <= maximumLogBytes) return;
      const handle = await open(logPath, "r");
      try {
        const retained = Buffer.alloc(retainedLogBytes);
        await handle.read(retained, 0, retainedLogBytes, Math.max(0, info.size - retainedLogBytes));
        await writeFile(logPath, retained.toString("utf8").replace(/^[^\n]*\n/, ""));
      } finally {
        await handle.close();
      }
      await appendFile(logPath, `${JSON.stringify({
        seq: await this.nextSeq(logPath),
        at: this.now().toISOString(),
        stream: "system",
        line: "Earlier log lines were dropped to keep the run log bounded."
      } satisfies DemoLogEntry)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // A missing log file simply means the run has not produced output yet.
    }
  }

  async appendLog(runId: string, stream: "stdout" | "stderr" | "system", line: string, secrets: string[] = []): Promise<void> {
    const run = await this.options.repository.getRun(runId);
    if (!run) return;
    const trimmed = redactDemoLogLine(line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""), secrets).slice(0, 2000);
    const entry: DemoLogEntry = { seq: await this.nextSeq(run.logPath), at: this.now().toISOString(), stream, line: trimmed };
    const previous = this.logQueues.get(run.logPath) ?? Promise.resolve();
    const next = previous
      .then(() => appendFile(run.logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 }))
      .catch((error) => this.log("demo.log.append_failed", { runId, message: String(error) }));
    this.logQueues.set(run.logPath, next);
    await next;
  }

  private readonly seqCounters = new Map<string, number>();

  private async nextSeq(logPath: string): Promise<number> {
    const cached = this.seqCounters.get(logPath);
    if (cached !== undefined) {
      const next = cached + 1;
      this.seqCounters.set(logPath, next);
      return next;
    }
    let count = 0;
    try {
      const raw = await readFile(logPath, "utf8");
      count = raw.split("\n").filter((line) => line.length > 0).length;
    } catch {
      count = 0;
    }
    this.seqCounters.set(logPath, count);
    return count;
  }

  async readLogs(ownerUserId: string, runId: string, since = 0): Promise<{ entries: DemoLogEntry[]; nextSeq: number; dropped: boolean }> {
    const run = await this.requireOwnedRun(ownerUserId, runId);
    let entries: DemoLogEntry[] = [];
    let dropped = false;
    try {
      const raw = await readFile(run.logPath, "utf8");
      const lines = raw.split("\n").filter((line) => line.length > 0);
      const parsed: DemoLogEntry[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as DemoLogEntry;
          if (typeof entry.seq === "number") parsed.push(entry);
        } catch {
          // Ignore partial trailing lines from a killed process.
        }
      }
      const all = parsed.slice(-logReadLimit);
      entries = all.filter((entry) => entry.seq >= since);
      const first = all[0];
      dropped = parsed.length > all.length || (since > 0 && first !== undefined && first.seq > since);
    } catch {
      entries = [];
    }
    const last = entries.at(-1);
    const nextSeq = last ? last.seq + 1 : since;
    return { entries, nextSeq, dropped };
  }

  async stop(ownerUserId: string, runId: string): Promise<DemoRunRecord> {
    const run = await this.requireOwnedRun(ownerUserId, runId);
    return this.stopRun(run);
  }

  private async stopRun(run: DemoRunRecord): Promise<DemoRunRecord> {
    const managed = this.processes.get(run.id);
    const pid = managed?.child.pid ?? run.pid;
    if (pid) await this.terminatePid(pid);
    this.processes.delete(run.id);
    await this.appendLog(run.id, "system", "Run stopped.");
    return this.options.repository.upsertRun({
      ...run,
      status: "STOPPED",
      port: null,
      pid: null,
      health: null,
      stoppedAt: this.now().toISOString()
    });
  }

  async restart(ownerUserId: string, runId: string): Promise<DemoStartedRun> {
    const run = await this.requireOwnedRun(ownerUserId, runId);
    await this.stopRun(run);
    return this.start({
      ownerUserId,
      projectId: run.projectId,
      variantId: run.variantId,
      mode: run.mode
    });
  }

  /** Stops every demo run owned by the user for one project without touching other sessions. */
  async stopProjectRuns(ownerUserId: string, projectId: string): Promise<number> {
    const runs = await this.options.repository.listRuns(ownerUserId, 40);
    let stopped = 0;
    for (const run of runs) {
      if (run.projectId !== projectId) continue;
      if (run.status !== "RUNNING" && run.status !== "STARTING") continue;
      await this.stopRun(run);
      stopped += 1;
    }
    return stopped;
  }

  dispose(): void {
    for (const managed of this.processes.values()) {
      const pid = managed.child.pid;
      if (pid) void this.terminatePid(pid);
    }
    this.processes.clear();
  }

  private async terminatePid(pid: number): Promise<void> {
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // The process already exited.
        }
      }
    };
    signalGroup("SIGTERM");
    const deadline = Date.now() + stopGraceMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (isAlive(pid)) signalGroup("SIGKILL");
  }

  async allocatePort(): Promise<number> {
    const { portRangeStart, portRangeEnd } = this.options;
    const span = Math.max(1, portRangeEnd - portRangeStart);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const candidate = portRangeStart + Math.floor(Math.random() * span);
      if (await isPortFree(candidate)) return candidate;
    }
    for (let port = portRangeStart; port <= portRangeEnd; port += 1) {
      if (await isPortFree(port)) return port;
    }
    throw new DemoRunError("DEMO_NO_PORT", "No free port is available for the demo runtime.", 503);
  }

  async healthCheck(port: number): Promise<{ ok: boolean; checkedAt: string; latencyMs: number | null; detail: string | null }> {
    const startedAt = Date.now();
    const checkedAt = this.now().toISOString();
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(Math.min(this.options.healthTimeoutMs, 5_000)),
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        return { ok: false, checkedAt, latencyMs: Date.now() - startedAt, detail: `Health check returned ${response.status}.` };
      }
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; runId?: string } | null;
      if (payload && payload.ok === false) {
        return { ok: false, checkedAt, latencyMs: Date.now() - startedAt, detail: "The demo reported an unhealthy state." };
      }
      return { ok: true, checkedAt, latencyMs: Date.now() - startedAt, detail: null };
    } catch (error) {
      return {
        ok: false,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message.slice(0, 200) : "The health check failed."
      };
    }
  }

  private async waitForHealth(port: number): Promise<{ ok: boolean; checkedAt: string; latencyMs: number | null; detail: string | null }> {
    const deadline = Date.now() + this.options.healthTimeoutMs;
    let last = await this.healthCheck(port);
    while (!last.ok && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      last = await this.healthCheck(port);
    }
    return last;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

export function demoRunStatusTone(status: DemoRunStatus): "neutral" | "pending" | "good" | "bad" {
  switch (status) {
    case "RUNNING":
      return "good";
    case "STARTING":
      return "pending";
    case "FAILED":
    case "CONNECTION_REQUIRED":
      return "bad";
    default:
      return "neutral";
  }
}
