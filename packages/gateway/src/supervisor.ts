import cluster, { type Worker } from "node:cluster";

/**
 * Zero-downtime handoff for Space Gateway. The supervisor holds the listening socket and runs the gateway as a
 * cluster worker. On SIGHUP (`systemctl reload space-gateway`) it starts a worker from the current bundle, and only
 * when that worker listens does it tell the previous one to stop accepting and finish its open streams. A worker
 * that fails to start is dropped and the running one keeps serving, so a bad deploy never takes the gateway down.
 */
export const DRAIN_MESSAGE = "space-gateway:drain";
/**
 * Nous Gateway (KMS key provider): the first worker unwraps the credential key and gives it to the supervisor, which hands it to every
 * later worker over IPC (memory only), so a reload (the 24-hour certificate renewal) never needs KMS (runbook §8.9). A Space Gateway
 * worker never sends it, so nothing changes there.
 */
export const KEY_HOLD_MESSAGE = "space-gateway:credential-key";
export const KEY_REQUEST_MESSAGE = "space-gateway:credential-key-request";

/** Worker side: the key the supervisor holds (base64), or null when it holds none or there is no supervisor (answers within `timeoutMs`). */
export function heldCredentialKey(timeoutMs = 2_000): Promise<string | null> {
  if (typeof process.send !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (key: string | null) => { clearTimeout(timer); process.off("message", onMessage); resolve(key); };
    const onMessage = (message: { type?: unknown; key?: unknown } | null) => {
      if (message?.type === KEY_HOLD_MESSAGE) done(typeof message.key === "string" && message.key ? message.key : null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    process.on("message", onMessage);
    process.send!({ type: KEY_REQUEST_MESSAGE });
  });
}

/** Worker side: gives the unwrapped key to the supervisor for the next workers. */
export const holdCredentialKey = (key: string) => { if (typeof process.send === "function") process.send({ type: KEY_HOLD_MESSAGE, key }); };

export interface SupervisorOptions {
  workerFile: string;
  /** How long a new worker may take to listen before it is given up. */
  startTimeoutMs?: number;
  restartDelayMs?: number;
  /** A worker that keeps exiting soon after it starts is restarted after a doubling delay, at most this long. */
  maxRestartDelayMs?: number;
  log?: (line: string) => void;
}

/** A worker that ran at least this long counts as healthy: the restart delay starts over. */
const HEALTHY_RUN_MS = 60_000;

export function startSupervisor(options: SupervisorOptions) {
  const log = options.log ?? ((line: string) => process.stdout.write(`space-gateway supervisor: ${line}\n`));
  cluster.setupPrimary({ exec: options.workerFile });
  let current: Worker | null = null;
  let pending: Worker | null = null;
  let stopping = false;
  let quickExits = 0;
  let heldKey: string | null = null;
  const draining = new Set<Worker>();

  const drain = (worker: Worker, reason: "reload" | "stop") => {
    draining.add(worker);
    try { worker.send({ type: DRAIN_MESSAGE, reason }); } catch { worker.kill("SIGTERM"); }
  };

  function launch(): Worker {
    const worker = cluster.fork();
    const startedAt = Date.now();
    worker.on("message", (message: { type?: unknown; key?: unknown } | null) => {
      if (message?.type === KEY_HOLD_MESSAGE && typeof message.key === "string" && message.key) heldKey = message.key;
      else if (message?.type === KEY_REQUEST_MESSAGE) try { worker.send({ type: KEY_HOLD_MESSAGE, key: heldKey }); } catch { /* the worker is gone */ }
    });
    worker.on("exit", (code, signal) => {
      draining.delete(worker);
      if (worker === pending) {
        pending = null;
        if (!stopping) log(`new worker exited before listening (${signal ?? code}); the running worker keeps serving`);
      } else if (worker === current) {
        current = null;
        if (!stopping) {
          quickExits = Date.now() - startedAt < HEALTHY_RUN_MS ? quickExits + 1 : 0;
          const delayMs = Math.min((options.restartDelayMs ?? 3_000) * 2 ** Math.max(0, quickExits - 1), options.maxRestartDelayMs ?? 60_000);
          log(`worker exited (${signal ?? code}); starting another in ${Math.round(delayMs / 1000)}s`);
          // Never unref'd: with no worker the timer is all that keeps the supervisor alive. An unref'd timer let it exit
          // instead, systemd restarted the unit until its start limit and the gateway stayed down (2026-10-28, 6 hours).
          setTimeout(() => { if (!stopping && !current) current = launch(); }, delayMs);
        }
      }
      if (stopping && !current && !pending && draining.size === 0) process.exit(0);
    });
    return worker;
  }

  current = launch();

  process.on("SIGHUP", () => {
    if (stopping || pending) return;
    if (!current) { current = launch(); return; }
    const next = launch();
    pending = next;
    const timer = setTimeout(() => {
      if (pending !== next) return;
      log("new worker did not start listening in time; keeping the running worker");
      pending = null;
      next.kill("SIGKILL");
    }, options.startTimeoutMs ?? 60_000);
    timer.unref();
    next.once("listening", () => {
      clearTimeout(timer);
      if (pending !== next) return;
      pending = null;
      const previous = current;
      current = next;
      if (previous) drain(previous, "reload");
      log("handed over to the new worker");
    });
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const worker of [current, pending, ...draining]) if (worker) drain(worker, "stop");
    if (!current && !pending && draining.size === 0) process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return { current: () => current };
}
