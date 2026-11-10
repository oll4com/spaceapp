// Worker hard kill on real infrastructure (failure matrix "Worker crash or
// restart"; CORE-001/CORE-006). A disposable Temporal server and PostgreSQL
// (every Space migration applied) run on a task-owned Docker network. The
// unchanged worker entry point (apps/worker/src/worker.ts) runs from this
// checkout's sources against them, on its own namespace and task queue. Chat
// turns are persisted and started with the API's own code (store submission and
// TemporalCodexAppServerTurnStarter). Providers are fakes: a Codex App Server
// script (support/fake-codex-app-server.mjs) and an OpenCode HTTP server in this
// process, each recording every prompt it receives. No model is called.
//
// 1. SIGKILL with three turns in flight (no activity or shutdown code runs),
//    then a new worker process: two Codex Chat turns (maximumAttempts 5,
//    heartbeat 15 s) re-enter the same durable run, thread and turn and never
//    resend the prompt; the OpenCode turn (maximumAttempts 1) is not retried,
//    its workflow fails and its run stays RUNNING.
// 2. SIGTERM (graceful shutdown) with a Codex and an OpenCode turn in flight:
//    the OpenCode turn records INTERRUPTED/TURN_OUTCOME_UNKNOWN itself; the
//    Codex turn records nothing and re-enters on the next worker.
// 3. The API's stranded-run sweep (real query, real 180 s window, real Temporal
//    lookup) fails the SIGKILLed OpenCode run as an unknown outcome, once.
// Skips without Docker or the two images. Runs about five minutes.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readdirSync, readFileSync, type WriteStream } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { temporal } from "@temporalio/proto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DummyTurnInput } from "@space/contracts";
import { PostgresDotsRepository, PostgresSpaceStore } from "@space/db";
import { applyPendingMigrations } from "../../../packages/db/src/migration-runner.js";
import { loadMigrations } from "../../../packages/db/src/migrations.js";
import { lostRunningRunMessage, sweepStrandedChatRuns } from "../../api/src/stranded-chat-runs.js";
import { TemporalCodexAppServerTurnStarter } from "../../api/src/turns.js";
import { singleAttemptTurnOutcomeUnknownMessage } from "../src/activities.js";
import { disposableTemporalUnavailableReason, startDisposableTemporal, type DisposableTemporal } from "./support/disposable-temporal.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const sourceLoader = path.join(repoRoot, "scripts", "test-support", "worktree-source-loader.mjs");
const temporalWorkerLoader = path.join(here, "support", "worktree-temporal-worker-loader.mjs");
const fakeCodexScript = path.join(here, "support", "fake-codex-app-server.mjs");
const workerEntry = path.join(repoRoot, "apps", "worker", "src", "worker.ts");
const database = "space_worker_kill";
const namespace = "space-worker-kill-proof";
const unavailable = disposableTemporalUnavailableReason();
if (unavailable) process.stderr.write(`[worker hard kill] skipped: ${unavailable}\n`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(check: () => Promise<T | null | undefined | false>, what: string, timeoutMs: number, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    await sleep(intervalMs);
  }
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const timeoutTypeName = (value: unknown) => String(temporal.api.enums.v1.TimeoutType[Number(value)] ?? value).replace(/^TIMEOUT_TYPE_/, "");
const eventTypeName = (value: unknown) => String(temporal.api.enums.v1.EventType[Number(value)] ?? value).replace(/^EVENT_TYPE_/, "");

interface LedgerEntry { at: string; pid: number; event: string; threadId?: string; turnId?: string; tag?: string | null;
  promptSha256?: string; recoveryPrompt?: boolean; outcome?: string; turns?: string[]; reason?: string }
interface Chat { label: string; runId: string; sessionId: string; workflowId: string; prompt: string }

/** One worker process: the production entry point under the source loaders. */
class WorkerProcess {
  readonly child: ChildProcess;
  readonly log: WriteStream;
  output = "";
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  constructor(readonly label: string, env: NodeJS.ProcessEnv, logPath: string) {
    this.log = createWriteStream(logPath);
    this.child = spawn(process.execPath, ["--import", sourceLoader, "--import", temporalWorkerLoader, workerEntry],
      { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const capture = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.log.write(text);
      if (this.output.length < 2_000_000) this.output += text;
    };
    this.child.stdout!.on("data", capture);
    this.child.stderr!.on("data", capture);
    this.exit = new Promise((resolve) => this.child.once("exit", (code, signal) => resolve({ code, signal })));
  }
  get pid(): number { return this.child.pid!; }
  get identity(): string { return `${this.pid}@${os.hostname()}`; }
  get exited(): boolean { return this.child.exitCode !== null || this.child.signalCode !== null; }
  async ready(timeoutMs: number) {
    await waitFor(async () => {
      if (this.exited) throw new Error(`${this.label} exited during startup:\n${this.output.slice(-4000)}`);
      return /"status":"running"/.test(this.output) && /state: 'RUNNING'/.test(this.output);
    }, `${this.label} to poll its task queue`, timeoutMs, 200);
  }
  /** Stops only this exact PID: SIGTERM, then SIGKILL after a grace period. */
  async stop(graceMs = 30_000) {
    if (this.exited) return this.exit;
    this.child.kill("SIGTERM");
    const result = await Promise.race([this.exit, sleep(graceMs).then(() => null)]);
    if (result) return result;
    this.child.kill("SIGKILL");
    return this.exit;
  }
}

/** A fake OpenCode 2 server: records every request, queues the prompt and never finishes the turn. */
async function startFakeOpenCode(username: string, password: string) {
  const requests: Array<{ at: number; method: string; path: string; session: string | null; promptSha256?: string }> = [];
  const promptConnections: Array<{ session: string; at: number; closedAt: number | null }> = [];
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake-opencode");
    if (request.headers.authorization !== expected) { response.writeHead(401).end(); return; }
    const route = /^\/api\/(?:experimental\/)?session\/(ses_[A-Za-z0-9]+)\/(agent|prompt|wait|interrupt)$/.exec(url.pathname);
    const entry: (typeof requests)[number] = { at: Date.now(), method: request.method ?? "", path: url.pathname, session: route?.[1] ?? null };
    requests.push(entry);
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.method === "GET" && url.pathname === "/api/info") return json(200, { data: { version: "2.0.32" } });
    if (request.method === "GET" && url.pathname === "/api/session/active") return json(200, { data: {} });
    if (request.method === "POST" && route?.[2] === "agent") return json(200, {});
    if (request.method === "POST" && route?.[2] === "prompt") {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => {
        try {
          entry.promptSha256 = sha256((JSON.parse(body) as { text?: string }).text ?? "");
        } catch { entry.promptSha256 = "invalid"; }
        json(200, { data: { id: "msg_prompt" } });
      });
      return;
    }
    if (request.method === "POST" && route?.[2] === "wait") {
      // The model "works" forever: the wait is held until the client goes away.
      const connection = { session: route[1]!, at: Date.now(), closedAt: null as number | null };
      promptConnections.push(connection);
      response.on("close", () => { connection.closedAt = Date.now(); });
      return;
    }
    if (request.method === "POST" && route?.[2] === "interrupt") return json(200, { interrupted: true });
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake OpenCode server has no port");
  return {
    port: address.port,
    requests,
    promptConnections,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

describe.skipIf(unavailable !== null)(`worker hard kill on real Temporal${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let infra: DisposableTemporal;
  let pool: pg.Pool;
  let store: PostgresSpaceStore;
  let dots: PostgresDotsRepository;
  let connection: Connection;
  let client: Client;
  let fakeOpenCode: Awaited<ReturnType<typeof startFakeOpenCode>>;
  let openCodeCredentials: { username: string; password: string };
  let workerEnv: NodeJS.ProcessEnv;
  let starter: TemporalCodexAppServerTurnStarter;
  let codexHome: string;
  let workDir: string;
  let ownMarker = "";
  const workers: WorkerProcess[] = [];
  const suffix = randomBytes(4).toString("hex");
  const taskQueue = `space-worker-kill-${suffix}`;
  const evidence: Record<string, unknown> = {};
  // Shared between the phases, which run in order.
  let killed: { worker1: WorkerProcess; worker2: WorkerProcess; killedAt: number; openCode: Chat; openCodeNative: string;
    openCodeRequestsAtKill: number } | null = null;
  let graceful: { openCode: Chat; codex: Chat } | null = null;

  beforeAll(async () => {
    const t0 = Date.now();
    infra = await startDisposableTemporal("worker-kill", namespace);
    ownMarker = infra.root;
    await infra.createDatabase(database);
    pool = infra.pool(database, 6);
    const migrationClient = await pool.connect();
    try {
      await applyPendingMigrations(migrationClient, await loadMigrations());
    } finally {
      migrationClient.release();
    }
    evidence.infrastructureReadyMs = Date.now() - t0;
    store = new PostgresSpaceStore(pool);
    dots = new PostgresDotsRepository(pool);
    connection = await Connection.connect({ address: infra.temporalAddress, connectTimeout: "5s" });
    client = new Client({ connection, namespace });
    starter = new TemporalCodexAppServerTurnStarter({ address: infra.temporalAddress, namespace, taskQueue });

    const dir = (name: string) => path.join(infra.root, name);
    codexHome = dir("codex-app-server-home");
    workDir = dir("work");
    for (const name of ["bin", "codex-app-server-home", "work", "home", "tmp", "artifacts", "dots", "opencode-state", "telegram", "streaming", "codex-cli-home"]) {
      await mkdir(dir(name), { recursive: true });
    }
    // The worker hands its Codex child an allowlisted environment, so the
    // wrapper carries the fake's path; the marker argument identifies this run's processes.
    const fakeCodex = path.join(dir("bin"), "fake-codex");
    await writeFile(fakeCodex, `#!/bin/sh\nexec '${process.execPath}' '${fakeCodexScript}' --owner '${ownMarker}' "$@"\n`);
    await chmod(fakeCodex, 0o755);
    openCodeCredentials = { username: "opencode", password: randomBytes(12).toString("hex") };
    fakeOpenCode = await startFakeOpenCode(openCodeCredentials.username, openCodeCredentials.password);

    // An explicit environment: nothing is inherited from the calling shell, and
    // every path or endpoint with a live default points into this run's directory.
    workerEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: dir("home"),
      TMPDIR: dir("tmp"),
      LANG: "C.UTF-8",
      SPACE_TEST_RESOLVE_LOG: dir("resolve.log"),
      SPACE_TEMPORAL_ADDRESS: infra.temporalAddress,
      SPACE_TEMPORAL_NAMESPACE: namespace,
      SPACE_TEMPORAL_TASK_QUEUE: taskQueue,
      SPACE_DATABASE_URL: infra.databaseUrl(database),
      // Without this, createSpacePgPool prefers the live PostgreSQL socket when it is reachable.
      SPACE_PG_SOCKET_PATH: path.join(infra.socketDir, ".s.PGSQL.5432"),
      SPACE_ENABLE_CODEX_TURNS: "true",
      SPACE_CODEX_APP_SERVER_ENABLED: "true",
      SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
      SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
      SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
      SPACE_CODEX_APP_SERVER_COMMAND: fakeCodex,
      SPACE_CODEX_APP_SERVER_HOME: codexHome,
      SPACE_CODEX_APP_SERVER_CWD: workDir,
      SPACE_CODEX_ROUTE_SWITCH_ENABLED: "false",
      SPACE_CODEX_ROUTE_COMMAND: "/bin/false",
      SPACE_ARTIFACT_ROOT: dir("artifacts"),
      SPACE_DOT_WORKSPACE_ROOT: dir("dots"),
      SPACE_INTERNAL_API_BASE_URL: "http://127.0.0.1:9",
      SPACE_STREAMING_BOT_API_BASE_URL: "http://127.0.0.1:9",
      SPACE_CANONICAL_MEMORY_BRIDGE_ENABLED: "false",
      SPACE_ENABLE_OPENCODE_TURNS: "true",
      SPACE_OPENCODE_STATE_ROOT: dir("opencode-state"),
      SPACE_OPENCODE_MESSAGE_TIMEOUT_MS: "600000",
      SPACE_ENABLE_CLI_CHAT_TURNS: "false",
      SPACE_CODEX_HOME: dir("codex-cli-home"),
      SPACE_TELEGRAM_SECRET_ROOT: dir("telegram"),
      SPACE_TELEGRAM_OWNERSHIP_MANIFEST: path.join(dir("telegram"), "manifest.json"),
      SPACE_TELEGRAM_WORKER_INTERVAL_MS: "60000",
      SPACE_STREAMING_SECRET_ROOT: dir("streaming"),
      SPACE_STREAMING_BOT_INTERVAL_MS: "60000"
    };
  }, 600_000);

  afterAll(async () => {
    for (const worker of workers) await worker.stop().catch(() => undefined);
    // Any process still carrying this run's directory as an argument was
    // started by this test (a fake runtime child); stop it by exact PID.
    const leftovers = ownMarker ? processesWithArgument(ownMarker) : [];
    for (const pid of leftovers) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    evidence.leftoverProcessesAtCleanup = leftovers.length;
    await connection?.close().catch(() => undefined);
    await fakeOpenCode?.close().catch(() => undefined);
    for (const worker of workers) worker.log.end();
    if (Object.keys(evidence).length) {
      process.stdout.write(`[worker hard kill] evidence ${JSON.stringify(evidence)}\n`);
      if (process.env.SPACE_WORKER_KILL_EVIDENCE) await writeFile(process.env.SPACE_WORKER_KILL_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    await infra?.stop();
  }, 300_000);

  function processesWithArgument(argument: string): number[] {
    const found: number[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        if (readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").includes(argument)) found.push(Number(entry));
      } catch { /* exited or not readable */ }
    }
    return found;
  }

  function ledger(): LedgerEntry[] {
    const file = path.join(codexHome, "fake-codex", "ledger.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
  }
  const turnStarts = (threadId: string | null) => ledger().filter((entry) => entry.event === "turn/start" && entry.threadId === threadId);

  async function runRow(runId: string) {
    const result = await pool.query<{ status: string; error_code: string | null; error_message: string | null; codex_thread_id: string | null;
      codex_turn_id: string | null; stale_seconds: number }>(
      `SELECT status, error_code, error_message, codex_thread_id, codex_turn_id,
         EXTRACT(EPOCH FROM now() - updated_at)::float AS stale_seconds FROM space_agent_runs WHERE run_id = $1`, [runId]);
    return result.rows[0]!;
  }

  async function chatState(chat: Chat) {
    const run = await runRow(chat.runId);
    const runs = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM space_agent_runs WHERE session_id = $1", [chat.sessionId]);
    const messages = await pool.query<{ role: string; status: string; content: string }>(
      "SELECT role, status, content FROM space_agent_messages WHERE session_id = $1 ORDER BY created_at, message_id", [chat.sessionId]);
    const session = await pool.query<{ status: string; thread_id: string | null }>(
      "SELECT status, thread_id FROM space_agent_sessions WHERE session_id = $1", [chat.sessionId]);
    const completedEvents = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM events WHERE event_type = 'TURN_COMPLETED' AND payload->>'runId' = $1", [chat.runId]);
    return { run, runCount: runs.rows[0]!.n, messages: messages.rows, session: session.rows[0]!, turnCompletedEvents: completedEvents.rows[0]!.n };
  }

  /** A live OpenCode control file for one Space session, pointing at the fake server. */
  async function openCodeSession(label: string) {
    const spaceSessionId = `opencode-kill-proof-${label}-${suffix}`;
    const nativeSessionId = `ses_${label.replace(/[^A-Za-z0-9]/g, "")}${suffix}`;
    const controlDir = path.join(workerEnv.SPACE_OPENCODE_STATE_ROOT!, "opencode", "space-cli-control");
    await mkdir(controlDir, { recursive: true });
    await writeFile(path.join(controlDir, `${spaceSessionId}.json`), JSON.stringify({
      version: 1, spaceSessionId, nativeSessionId, serverPort: fakeOpenCode.port, serverHost: "127.0.0.1", serverNetwork: "host",
      serverUsername: openCodeCredentials.username, serverPassword: openCodeCredentials.password, directory: workDir,
      updatedAt: new Date().toISOString()
    }));
    return { spaceSessionId, nativeSessionId };
  }

  /** Persists and starts a Chat turn the way the API's sendMessage does. */
  async function submitChat(label: string, prompt: string, openCode: { spaceSessionId: string } | null): Promise<Chat> {
    const providerId = openCode ? "opencode" : null;
    const room = await store.createRoom({ name: `AGENT_PROOF worker kill ${label}`, kind: "AGENT_PROOF", projectPath: workDir, initialPaneCount: 1 });
    const pane = (await store.listPanes(room.id))[0]!;
    const session = await store.createSpaceAgentSession({
      paneId: pane.id, roomId: room.id, title: "Chat", selectedProviderId: providerId, selectedModelId: null,
      selectedModelConfigId: null, selectedProviderName: providerId, selectedModelName: null, selectedReasoningKey: null
    });
    const id = `${label}-${suffix}`;
    const input: DummyTurnInput = {
      roomId: room.id, paneId: pane.id, prompt, artifactIds: [], providerId,
      ...(openCode ? { providerSessionId: openCode.spaceSessionId } : {}),
      modelId: null, reasoningEffort: null, agentSessionId: session.sessionId,
      agentUserMessageId: `agent_msg:kill-user-${id}`, agentAssistantMessageId: `agent_msg:kill-reply-${id}`,
      agentThreadId: session.threadId ?? null, selectedToolIds: [], permissionMode: "full_access",
      collaborationMode: "default", traceId: `trace:worker-kill-${id}`
    };
    const planned = starter.plan(input);
    const accepted = await store.createSpaceAgentSubmission({ content: prompt, run: {
      clientRequestId: `client:worker-kill-${id}`, requestFingerprint: sha256(prompt),
      sessionId: session.sessionId, paneId: pane.id, roomId: room.id, workflowId: planned.workflowId,
      temporalRunId: null, status: "QUEUED", promptMessageId: input.agentUserMessageId!, responseMessageId: input.agentAssistantMessageId!,
      codexThreadId: null, codexTurnId: null
    } }, input.traceId);
    const started = await starter.start(input);
    if (started.runId !== accepted.run.temporalRunId) await store.updateSpaceAgentRun(accepted.run.runId, { temporalRunId: started.runId, status: "QUEUED" });
    return { label, runId: accepted.run.runId, sessionId: session.sessionId, workflowId: planned.workflowId, prompt };
  }

  async function history(workflowId: string) {
    const events = (await client.workflow.getHandle(workflowId).fetchHistory()).events ?? [];
    return events.map((event) => {
      const at = event.eventTime?.seconds ? Number(event.eventTime.seconds) * 1000 + Math.floor((event.eventTime.nanos ?? 0) / 1e6) : null;
      const scheduled = event.activityTaskScheduledEventAttributes;
      const started = event.activityTaskStartedEventAttributes;
      const failed = event.activityTaskFailedEventAttributes;
      const timedOut = event.activityTaskTimedOutEventAttributes;
      return {
        at, type: eventTypeName(event.eventType),
        ...(scheduled ? { activity: scheduled.activityType?.name, maximumAttempts: scheduled.retryPolicy?.maximumAttempts ?? null } : {}),
        ...(started ? { attempt: started.attempt, identity: started.identity,
          lastFailure: started.lastFailure ? (started.lastFailure.timeoutFailureInfo
            ? `timeout:${timeoutTypeName(started.lastFailure.timeoutFailureInfo.timeoutType)}` : started.lastFailure.message) : null } : {}),
        ...(event.activityTaskCompletedEventAttributes ? { identity: event.activityTaskCompletedEventAttributes.identity } : {}),
        ...(failed ? { identity: failed.identity, failure: failed.failure?.message, retryState: failed.retryState } : {}),
        ...(timedOut ? { timeout: timeoutTypeName(timedOut.failure?.timeoutFailureInfo?.timeoutType), retryState: timedOut.retryState } : {}),
        ...(event.workflowTaskCompletedEventAttributes ? { identity: event.workflowTaskCompletedEventAttributes.identity } : {}),
        ...(event.workflowTaskTimedOutEventAttributes ? { timeout: timeoutTypeName(event.workflowTaskTimedOutEventAttributes.timeoutType) } : {})
      };
    });
  }
  const workflowStatus = async (workflowId: string) => (await client.workflow.getHandle(workflowId).describe()).status.name;

  function startWorker(label: string): WorkerProcess {
    const worker = new WorkerProcess(label, workerEnv, path.join(infra.root, `${label}.log`));
    workers.push(worker);
    return worker;
  }

  it("SIGKILL mid-turn: Codex turns re-enter on a new worker without resending the prompt; the OpenCode turn is not retried", async () => {
    evidence.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    evidence.sourceDirty = execFileSync("git", ["status", "--porcelain", "--", "apps/worker/src", "packages"], { cwd: repoRoot, encoding: "utf8" }).trim() !== "";
    const t0 = Date.now();
    const worker1 = startWorker("worker-1");
    await worker1.ready(240_000);
    evidence.worker1StartupMs = Date.now() - t0;

    // The worker loaded every workspace package from this checkout's sources.
    const resolved = readFileSync(workerEnv.SPACE_TEST_RESOLVE_LOG!, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { specifier: string; url: string });
    expect(resolved.some((entry) => entry.specifier === "@space/db")).toBe(true);
    expect(resolved.some((entry) => entry.specifier === "@temporalio/worker")).toBe(true);
    for (const entry of resolved) expect(fileURLToPath(entry.url).startsWith(`${repoRoot}/`)).toBe(true);
    evidence.workspaceModules = [...new Set(resolved.map((entry) => entry.specifier))].sort();

    const codexInterrupted = await submitChat("codex-interrupted", "[proof:codex-interrupted] [fake-codex:hold] Summarize the synthetic note.", null);
    const codexFinished = await submitChat("codex-finished",
      "[proof:codex-finished] [fake-codex:hold] [fake-codex:finish-on-disconnect] Summarize the synthetic note.", null);
    const openCodeSessionA = await openCodeSession("kill");
    const openCode = await submitChat("opencode-kill", "[proof:opencode-kill] Summarize the synthetic note.", openCodeSessionA);

    // Persisted intent and an in-flight provider call for all three turns.
    const inFlight = await waitFor(async () => {
      const starts = ledger().filter((entry) => entry.event === "turn/start");
      const a = await runRow(codexInterrupted.runId);
      const b = await runRow(codexFinished.runId);
      const c = await runRow(openCode.runId);
      const ok = starts.some((entry) => entry.tag === "codex-interrupted") && starts.some((entry) => entry.tag === "codex-finished") &&
        a.codex_turn_id && b.codex_turn_id && c.status === "RUNNING" &&
        fakeOpenCode.promptConnections.some((entry) => entry.session === openCodeSessionA.nativeSessionId);
      return ok ? { a, b } : null;
    }, "three turns in flight with checkpointed Codex turn ids", 120_000);
    const durable = {
      a: { thread: inFlight.a.codex_thread_id, turn: inFlight.a.codex_turn_id },
      b: { thread: inFlight.b.codex_thread_id, turn: inFlight.b.codex_turn_id }
    };

    const killedAt = Date.now();
    process.kill(worker1.pid, "SIGKILL");
    const worker1Exit = await worker1.exit;
    expect(worker1Exit).toEqual({ code: null, signal: "SIGKILL" });
    const openCodeRequestsAtKill = fakeOpenCode.requests.length;

    // Nothing ran after the kill: every run is still RUNNING.
    for (const chat of [codexInterrupted, codexFinished, openCode]) expect((await runRow(chat.runId)).status).toBe("RUNNING");

    const worker2 = startWorker("worker-2");
    await worker2.ready(240_000);
    evidence.worker2ReadyAfterKillMs = Date.now() - killedAt;
    killed = { worker1, worker2, killedAt, openCode, openCodeNative: openCodeSessionA.nativeSessionId, openCodeRequestsAtKill };

    await waitFor(async () => (await runRow(codexInterrupted.runId)).status === "COMPLETED" && (await runRow(codexFinished.runId)).status === "COMPLETED",
      "both Codex runs to complete on the new worker", 240_000, 500);
    evidence.codexCompletedAfterKillMs = Date.now() - killedAt;
    // The activity records the outcome before its workflow task closes the workflow.
    await waitFor(async () => (await workflowStatus(codexInterrupted.workflowId)) === "COMPLETED" &&
      (await workflowStatus(codexFinished.workflowId)) === "COMPLETED", "both Codex workflows to complete", 120_000, 500);
    await waitFor(async () => (await workflowStatus(openCode.workflowId)) !== "RUNNING", "the OpenCode workflow to close", 240_000, 500);
    evidence.openCodeWorkflowClosedAfterKillMs = Date.now() - killedAt;

    // Codex turn whose runtime interrupted the turn when its client died: the
    // next attempt resumes the same thread and sends the worker's recovery prompt, never the original one.
    const aState = await chatState(codexInterrupted);
    const aStarts = turnStarts(durable.a.thread);
    expect(aStarts.map((entry) => entry.recoveryPrompt)).toEqual([false, true]);
    expect(aStarts[0]!.tag).toBe("codex-interrupted");
    expect(aStarts[0]!.pid).not.toBe(aStarts[1]!.pid);
    const ledgerAfter = ledger();
    expect(ledgerAfter.filter((entry) => entry.event === "thread/start" && entry.threadId === durable.a.thread)).toHaveLength(1);
    expect(ledgerAfter.some((entry) => entry.event === "turn-client-gone" && entry.turnId === durable.a.turn && entry.outcome === "interrupted")).toBe(true);
    expect(aState).toMatchObject({
      run: { status: "COMPLETED", error_code: null, codex_thread_id: durable.a.thread, codex_turn_id: aStarts[1]!.turnId },
      runCount: 1, session: { status: "READY", thread_id: durable.a.thread }, turnCompletedEvents: 1
    });
    expect(aState.messages).toEqual([
      { role: "user", status: "COMPLETED", content: codexInterrupted.prompt },
      { role: "assistant", status: "COMPLETED", content: "fake-codex continued the interrupted turn after the worker restart." }
    ]);

    // Codex turn that the runtime finished on its own after its client died:
    // the next attempt reads the finished turn back and sends nothing.
    const bState = await chatState(codexFinished);
    const bStarts = turnStarts(durable.b.thread);
    expect(bStarts.map((entry) => entry.recoveryPrompt)).toEqual([false]);
    expect(bState).toMatchObject({
      run: { status: "COMPLETED", error_code: null, codex_thread_id: durable.b.thread, codex_turn_id: durable.b.turn },
      runCount: 1, session: { status: "READY" }, turnCompletedEvents: 1
    });
    expect(bState.messages.at(-1)).toEqual({ role: "assistant", status: "COMPLETED",
      content: "fake-codex answer for codex-finished, finished after the client disconnected" });

    // Temporal: each Codex activity completed on attempt 2, on the new worker,
    // after the killed attempt's heartbeat timeout.
    const aHistory = await history(codexInterrupted.workflowId);
    const bHistory = await history(codexFinished.workflowId);
    for (const events of [aHistory, bHistory]) {
      expect(events.find((event) => event.type === "ACTIVITY_TASK_SCHEDULED")).toMatchObject({ activity: "runCodexAppServerTurn", maximumAttempts: 5 });
      expect(events.filter((event) => event.type === "ACTIVITY_TASK_STARTED")).toEqual([
        expect.objectContaining({ attempt: 2, identity: worker2.identity, lastFailure: "timeout:HEARTBEAT" })
      ]);
      expect(events.find((event) => event.type === "ACTIVITY_TASK_COMPLETED")).toMatchObject({ identity: worker2.identity });
      expect(events.at(-1)!.type).toBe("WORKFLOW_EXECUTION_COMPLETED");
      expect(events.filter((event) => event.type === "WORKFLOW_TASK_FAILED")).toEqual([]);
    }

    // OpenCode (maximumAttempts 1): no retry and no second prompt. The killed
    // attempt timed out on its heartbeat and the workflow failed; nothing
    // recorded an outcome, so the run, reply and session are still RUNNING.
    const cHistory = await history(openCode.workflowId);
    expect(cHistory.find((event) => event.type === "ACTIVITY_TASK_SCHEDULED")).toMatchObject({ activity: "runOpenCodeAgentTurn", maximumAttempts: 1 });
    expect(cHistory.filter((event) => event.type === "ACTIVITY_TASK_STARTED")).toEqual([
      expect.objectContaining({ attempt: 1, identity: worker1.identity })
    ]);
    expect(cHistory.find((event) => event.type === "ACTIVITY_TASK_TIMED_OUT")).toMatchObject({ timeout: "HEARTBEAT" });
    expect(cHistory.at(-1)!.type).toBe("WORKFLOW_EXECUTION_FAILED");
    expect(await workflowStatus(openCode.workflowId)).toBe("FAILED");
    const posts = fakeOpenCode.requests.filter((entry) => entry.session === openCodeSessionA.nativeSessionId && entry.path.endsWith("/prompt"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.promptSha256).toBe(sha256(openCode.prompt));
    // Neither the killed worker (no interrupt request) nor the new worker contacted OpenCode after the kill.
    expect(fakeOpenCode.requests.slice(openCodeRequestsAtKill)).toEqual([]);
    expect(fakeOpenCode.promptConnections.find((entry) => entry.session === openCodeSessionA.nativeSessionId)!.closedAt).not.toBeNull();
    const cState = await chatState(openCode);
    expect(cState).toMatchObject({ run: { status: "RUNNING", error_code: null }, session: { status: "RUNNING" }, runCount: 1, turnCompletedEvents: 0 });
    expect(cState.messages.at(-1)).toEqual({ role: "assistant", status: "RUNNING", content: "" });

    evidence.sigkill = {
      killedWorkerPid: worker1.pid, killedWorkerExit: worker1Exit, replacementWorkerPid: worker2.pid,
      codexInterrupted: { turnStartsOriginalPrompt: aStarts.filter((entry) => !entry.recoveryPrompt).length,
        turnStartsRecoveryPrompt: aStarts.filter((entry) => entry.recoveryPrompt).length,
        retryStartedAfterKillMs: (aHistory.find((event) => event.type === "ACTIVITY_TASK_STARTED")?.at ?? 0) - killedAt,
        history: aHistory.map((event) => event.type) },
      codexFinished: { turnStarts: bStarts.length,
        retryStartedAfterKillMs: (bHistory.find((event) => event.type === "ACTIVITY_TASK_STARTED")?.at ?? 0) - killedAt,
        history: bHistory.map((event) => event.type) },
      openCode: { promptPosts: posts.length, requestsAfterKill: fakeOpenCode.requests.length - openCodeRequestsAtKill,
        heartbeatTimeoutAfterKillMs: (cHistory.find((event) => event.type === "ACTIVITY_TASK_TIMED_OUT")?.at ?? 0) - killedAt,
        history: cHistory.map((event) => event.type), runStatusAfterWorkflowFailed: cState.run.status }
    };
  }, 900_000);

  it("SIGTERM mid-turn: the OpenCode turn records an unknown outcome itself; the Codex turn re-enters on the next worker", async () => {
    expect(killed).not.toBeNull();
    const worker2 = killed!.worker2;
    const openCodeSessionB = await openCodeSession("term");
    const codex = await submitChat("codex-sigterm", "[proof:codex-sigterm] [fake-codex:hold] Summarize the synthetic note.", null);
    const openCode = await submitChat("opencode-term", "[proof:opencode-term] Summarize the synthetic note.", openCodeSessionB);
    graceful = { codex, openCode };
    const inFlight = await waitFor(async () => {
      const run = await runRow(codex.runId);
      return run.codex_turn_id && (await runRow(openCode.runId)).status === "RUNNING" &&
        fakeOpenCode.promptConnections.some((entry) => entry.session === openCodeSessionB.nativeSessionId) ? run : null;
    }, "a Codex and an OpenCode turn in flight on worker-2", 120_000);

    const stoppedAt = Date.now();
    const worker2Exit = await worker2.stop(60_000);
    const stopMs = Date.now() - stoppedAt;
    // The OpenCode turn was cancelled by the shutdown: it asked OpenCode to interrupt
    // and recorded an unknown outcome instead of staying RUNNING.
    const dState = await chatState(openCode);
    expect(dState).toMatchObject({
      run: { status: "INTERRUPTED", error_code: "TURN_OUTCOME_UNKNOWN", error_message: singleAttemptTurnOutcomeUnknownMessage },
      session: { status: "READY" }, runCount: 1, turnCompletedEvents: 0
    });
    expect(dState.messages.at(-1)).toEqual({ role: "assistant", status: "INTERRUPTED", content: singleAttemptTurnOutcomeUnknownMessage });
    const dRequests = fakeOpenCode.requests.filter((entry) => entry.session === openCodeSessionB.nativeSessionId);
    expect(dRequests.map((entry) => entry.path.split("/").at(-1))).toEqual(["agent", "prompt", "wait", "interrupt"]);
    // The Codex turn recorded nothing: a later attempt owns it.
    expect((await runRow(codex.runId))).toMatchObject({ status: "RUNNING", error_code: null });

    const worker3 = startWorker("worker-3");
    await worker3.ready(240_000);
    await waitFor(async () => (await runRow(codex.runId)).status === "COMPLETED", "the Codex run to complete on worker-3", 240_000, 500);
    await waitFor(async () => (await workflowStatus(codex.workflowId)) === "COMPLETED", "the Codex workflow to complete", 120_000, 500);
    await waitFor(async () => (await workflowStatus(openCode.workflowId)) !== "RUNNING", "the OpenCode workflow to close", 120_000, 500);
    const eStarts = turnStarts(inFlight.codex_thread_id);
    expect(eStarts.map((entry) => entry.recoveryPrompt)).toEqual([false, true]);
    expect(await chatState(codex)).toMatchObject({ run: { status: "COMPLETED", codex_thread_id: inFlight.codex_thread_id }, runCount: 1, turnCompletedEvents: 1 });
    const eHistory = await history(codex.workflowId);
    expect(eHistory.filter((event) => event.type === "ACTIVITY_TASK_STARTED")).toEqual([
      expect.objectContaining({ attempt: 2, identity: worker3.identity })
    ]);
    const fHistory = await history(openCode.workflowId);
    expect(fHistory.filter((event) => event.type === "ACTIVITY_TASK_STARTED")).toEqual([expect.objectContaining({ attempt: 1, identity: worker2.identity })]);
    expect(fHistory.at(-1)!.type).toBe("WORKFLOW_EXECUTION_FAILED");
    // No second prompt for the OpenCode turn after the shutdown.
    expect(fakeOpenCode.requests.filter((entry) => entry.session === openCodeSessionB.nativeSessionId && entry.path.endsWith("/prompt"))).toHaveLength(1);

    evidence.sigterm = {
      stoppedWorkerPid: worker2.pid, stoppedWorkerExit: worker2Exit, stopMs, nextWorkerPid: worker3.pid,
      codex: { turnStarts: eStarts.map((entry) => (entry.recoveryPrompt ? "recovery" : "original")),
        attempt2LastFailure: eHistory.find((event) => event.type === "ACTIVITY_TASK_STARTED")?.lastFailure ?? null,
        history: eHistory.map((event) => event.type) },
      openCode: { run: `${dState.run.status}/${dState.run.error_code}`, requests: dRequests.map((entry) => entry.path.split("/").at(-1)),
        history: fHistory.map((event) => event.type),
        activityFailure: fHistory.find((event) => event.type === "ACTIVITY_TASK_FAILED")?.failure ?? null }
    };
  }, 900_000);

  it("the API sweep fails the SIGKILLed OpenCode run as an unknown outcome, once, after its 180 s window", async () => {
    expect(killed).not.toBeNull();
    const { openCode, killedAt, openCodeNative, openCodeRequestsAtKill } = killed!;
    const sweepDeps = {
      repository: dots,
      store,
      warn: () => undefined,
      // The same Temporal lookup as the API's sweep (app.ts).
      workflowState: async (workflowId: string) => {
        try {
          return (await client.workflow.getHandle(workflowId).describe()).status.name === "RUNNING" ? "RUNNING" as const : "CLOSED" as const;
        } catch (error) {
          return (error as { name?: string })?.name === "WorkflowNotFoundError" ? "NOT_FOUND" as const : "UNKNOWN" as const;
        }
      }
    };
    // Inside the window the run is left alone.
    const early = await runRow(openCode.runId);
    if (early.stale_seconds < 175) {
      expect(await sweepStrandedChatRuns(sweepDeps)).toEqual({ queuedFailed: [], runningFailed: [] });
      expect((await runRow(openCode.runId)).status).toBe("RUNNING");
    }
    await waitFor(async () => (await runRow(openCode.runId)).stale_seconds > 181, "the run to pass the sweep's 180 s window", 300_000, 1_000);
    const settledAt = Date.now();
    expect(await sweepStrandedChatRuns(sweepDeps)).toEqual({ queuedFailed: [], runningFailed: [openCode.runId] });
    expect(await sweepStrandedChatRuns(sweepDeps)).toEqual({ queuedFailed: [], runningFailed: [] });
    const state = await chatState(openCode);
    expect(state).toMatchObject({
      run: { status: "FAILED", error_code: "SPACE_AGENT_RUN_OUTCOME_UNKNOWN", error_message: lostRunningRunMessage },
      session: { status: "READY" }, runCount: 1, turnCompletedEvents: 0
    });
    expect(state.messages.at(-1)).toEqual({ role: "assistant", status: "FAILED", content: lostRunningRunMessage });
    // Still one prompt, and nothing was sent to OpenCode after the kill.
    expect(fakeOpenCode.requests.filter((entry) => entry.session === openCodeNative && entry.path.endsWith("/prompt"))).toHaveLength(1);
    expect(fakeOpenCode.requests.slice(openCodeRequestsAtKill).filter((entry) => entry.session === openCodeNative)).toEqual([]);
    // The sweep changed nothing else: every other run kept its recorded outcome.
    const others = await pool.query<{ status: string; error_code: string | null; n: number }>(
      "SELECT status, error_code, count(*)::int AS n FROM space_agent_runs WHERE run_id <> $1 GROUP BY 1, 2 ORDER BY 1, 2", [openCode.runId]);
    expect(others.rows).toEqual([
      { status: "COMPLETED", error_code: null, n: 3 },
      { status: "INTERRUPTED", error_code: "TURN_OUTCOME_UNKNOWN", n: 1 }
    ]);
    expect(graceful).not.toBeNull();
    evidence.sweep = { settledAfterKillMs: settledAt - killedAt, runningFailed: 1, secondSweepChanged: 0, finalRun: state.run.error_code };
  }, 600_000);
});
