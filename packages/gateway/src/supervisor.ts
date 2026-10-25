import cluster, { type Worker } from "node:cluster";

/**
 * Zero-downtime handoff for Space Gateway. The supervisor holds the listening socket and runs the gateway as a
 * cluster worker. On SIGHUP (`systemctl reload space-gateway`) it starts a worker from the current bundle, and only
 * when that worker listens does it tell the previous one to stop accepting and finish its open streams. A worker
 * that fails to start is dropped and the running one keeps serving, so a bad deploy never takes the gateway down.
 */
export const DRAIN_MESSAGE = "space-gateway:drain";

export interface SupervisorOptions {
  workerFile: string;
  /** How long a new worker may take to listen before it is given up. */
  startTimeoutMs?: number;
  restartDelayMs?: number;
  log?: (line: string) => void;
}

export function startSupervisor(options: SupervisorOptions) {
  const log = options.log ?? ((line: string) => process.stdout.write(`space-gateway supervisor: ${line}\n`));
  cluster.setupPrimary({ exec: options.workerFile });
  let current: Worker | null = null;
  let pending: Worker | null = null;
  let stopping = false;
  const draining = new Set<Worker>();

  const drain = (worker: Worker, reason: "reload" | "stop") => {
    draining.add(worker);
    try { worker.send({ type: DRAIN_MESSAGE, reason }); } catch { worker.kill("SIGTERM"); }
  };

  function launch(): Worker {
    const worker = cluster.fork();
    worker.on("exit", (code, signal) => {
      draining.delete(worker);
      if (worker === pending) {
        pending = null;
        if (!stopping) log(`new worker exited before listening (${signal ?? code}); the running worker keeps serving`);
      } else if (worker === current) {
        current = null;
        if (!stopping) {
          log(`worker exited (${signal ?? code}); starting another`);
          setTimeout(() => { if (!stopping && !current) current = launch(); }, options.restartDelayMs ?? 3_000).unref();
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
