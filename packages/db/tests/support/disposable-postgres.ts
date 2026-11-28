import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

/** Same image as the production compose file (PostgreSQL 17 + pgvector). */
export const disposablePostgresImage = process.env.SPACE_TEST_PG_IMAGE ?? "pgvector/pgvector:0.8.7-pg17-trixie";

function docker(args: string[], timeout = 30_000): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const activeContainers = new Set<string>();
const activeRoots = new Set<string>();
let processCleanupRegistered = false;

/** Synchronously force-removes all tracked disposable containers and cleans their socket dirs. */
export function cleanupActiveContainersSync(): string[] {
  const cleaned: string[] = [];
  for (const name of activeContainers) {
    try {
      execFileSync("docker", ["rm", "--force", "--volumes", name], { timeout: 15_000, stdio: "ignore" });
      cleaned.push(name);
    } catch { /* ignore */ }
  }
  activeContainers.clear();
  for (const root of activeRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  activeRoots.clear();
  return cleaned;
}

/** Registers process-level signal and exit handlers so active test containers are torn down on exit, crash or signal. */
export function registerProcessCleanup(): void {
  if (processCleanupRegistered) return;
  processCleanupRegistered = true;
  process.once("exit", () => {
    cleanupActiveContainersSync();
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      cleanupActiveContainersSync();
      process.kill(process.pid, signal);
    });
  }
}

/** Tracks a disposable container for guaranteed process-level cleanup. Returns an untrack callback. */
export function trackDisposableContainer(name: string, rootDir?: string): () => void {
  registerProcessCleanup();
  activeContainers.add(name);
  if (rootDir) activeRoots.add(rootDir);
  return () => {
    activeContainers.delete(name);
    if (rootDir) activeRoots.delete(rootDir);
  };
}

const RESTARTABLE_LABEL = "space.disposable-test.restartable";

/** A crash restart (`docker kill` then `docker start`) leaves a restartable container exited for a moment, and another
 * vitest worker's sweep must not remove it then (public CI 27/11: "container is marked for removal"), so an exited
 * restartable container counts as leaked only after maxAgeMs, like an abandoned running one. */
export function isSweepableTestContainer({ state, ageMs, restartable, maxAgeMs }: { state: string; ageMs: number; restartable: boolean; maxAgeMs: number }): boolean {
  if (state === "exited" || state === "dead") return !restartable || ageMs > maxAgeMs;
  if (state === "created") return ageMs > 60_000;
  return state === "running" && ageMs > maxAgeMs;
}

/** Sweeps dead or leaked test containers labeled `space.disposable-test=1`.
 * Exited or dead containers (restartable ones only after maxAgeMs), created containers older than 1 minute, and abandoned
 * running containers older than maxAgeMs (default 15 minutes) are force-removed. */
export function sweepDeadTestContainers({ maxAgeMs = 15 * 60_000, now = Date.now() }: { maxAgeMs?: number; now?: number } = {}): string[] {
  let output: string;
  try {
    output = execFileSync("docker", [
      "ps", "-a", "--filter", "label=space.disposable-test=1",
      "--format", `{{.ID}}\t{{.Names}}\t{{.State}}\t{{.CreatedAt}}\t{{.Label "${RESTARTABLE_LABEL}"}}`
    ], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return [];
  }
  if (!output) return [];

  const removed: string[] = [];
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    const id = parts[0]?.trim();
    const name = parts[1]?.trim();
    const state = parts[2]?.trim().toLowerCase();
    const createdAtStr = parts[3]?.trim();
    if (!id || !state) continue;

    const createdAt = new Date(createdAtStr || "").getTime();
    const ageMs = !Number.isNaN(createdAt) ? now - createdAt : Infinity;

    if (isSweepableTestContainer({ state, ageMs, restartable: parts[4]?.trim() === "1", maxAgeMs })) {
      try {
        execFileSync("docker", ["rm", "--force", "--volumes", id], { timeout: 15_000, stdio: "ignore" });
        removed.push(name || id);
      } catch { /* ignore */ }
    }
  }
  return removed;
}

let initialSweepDone = false;
export function ensureDeadTestContainersSwept(): void {
  if (initialSweepDone) return;
  initialSweepDone = true;
  sweepDeadTestContainers();
}

/** Why a disposable PostgreSQL container cannot run here, or null when it can.
 * Tests never pull images; a missing image is a skip reason, not a failure. */
export function disposablePostgresUnavailableReason(image = disposablePostgresImage): string | null {
  try {
    docker(["version", "--format", "{{.Server.Version}}"], 10_000);
  } catch {
    return "Docker is unavailable (`docker version` failed)";
  }
  try {
    docker(["image", "inspect", "--format", "{{.Id}}", image], 10_000);
  } catch {
    return `image ${image} is not present locally (run \`docker pull ${image}\`; tests never pull)`;
  }
  return null;
}

export interface DisposablePostgres {
  readonly name: string;
  readonly socketDir: string;
  pool(database: string, max?: number): pg.Pool;
  createDatabase(database: string): Promise<void>;
  /** Restarts the server and waits until it accepts queries again. "graceful"
   * is `docker restart` (the image's fast shutdown: open transactions roll back);
   * "crash" SIGKILLs every server process and starts again with WAL recovery.
   * Only for a server started with `restartable: true`. */
  restart(mode: "graceful" | "crash"): Promise<void>;
  stop(): Promise<void>;
}

/** Starts a throwaway PostgreSQL container with no network, reachable only
 * through a Unix socket in a task-owned temporary directory. Never use
 * createSpacePgPool against it: that factory may redirect to the live socket. */
export async function startDisposablePostgres(label: string, { restartable = false } = {}): Promise<DisposablePostgres> {
  if (!/^[a-z0-9-]{1,24}$/.test(label)) throw new Error("label must be short lowercase kebab-case");
  ensureDeadTestContainersSwept();
  const root = await mkdtemp(path.join(os.tmpdir(), "space-pg-"));
  const socketDir = path.join(root, "socket");
  await mkdir(socketDir);
  await chmod(socketDir, 0o777);
  if (`${socketDir}/.s.PGSQL.5432`.length > 103) throw new Error("TMPDIR is too long for a PostgreSQL Unix socket path.");
  const name = `space-test-${label}-${randomBytes(4).toString("hex")}`;
  const untrack = trackDisposableContainer(name, root);
  const pools: pg.Pool[] = [];
  let created = false;

  const stop = async () => {
    untrack();
    await Promise.allSettled(pools.map((pool) => pool.end()));
    if (created) {
      try { docker(["exec", "--user", "root", name, "chmod", "0777", "/var/run/postgresql"]); } catch { /* container already gone */ }
      try { docker(["rm", "--force", "--volumes", name], 60_000); } catch { /* container already gone */ }
      created = false;
    }
    await rm(root, { recursive: true, force: true });
  };

  const waitUntilReady = async () => {
    const probe = new pg.Pool({ host: socketDir, user: "postgres", database: "postgres", max: 1 });
    probe.on("error", () => { /* a probe connection may see the server go away */ });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 240 && !ready; attempt += 1) {
        try {
          // The entrypoint first runs a temporary init server on the same socket;
          // only the final server runs as PID 1.
          if (docker(["exec", name, "cat", "/proc/1/comm"]) !== "postgres") throw new Error("initializing");
          await probe.query("SELECT 1");
          ready = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!ready) throw new Error(`Disposable PostgreSQL ${name} did not become ready.`);
    } finally {
      await probe.end();
    }
  };

  // Data on tmpfs: initdb and test writes never touch the host disk (public-host IO starvation, docs/agents/app-data-disk.md).
  // A restartable server keeps its data across a restart, so it stays in a volume with initdb's syncs off.
  try {
    // 90s, not 30s: parallel suites hit daemon stalls >30s (ETIMEDOUT), killing the CLI between create and start and leaking a "Created" container; fits the usual 120s beforeAll.
    docker([
      "run", ...(restartable ? ["--env", "POSTGRES_INITDB_ARGS=--no-sync", "--label", `${RESTARTABLE_LABEL}=1`] : ["--rm", "--tmpfs", "/var/lib/postgresql/data"]), "--detach", "--pull=never", "--name", name, "--label", "space.disposable-test=1", "--network", "none",
      "--mount", `type=bind,source=${socketDir},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", disposablePostgresImage, "-c", "listen_addresses=", "-c", "fsync=off"
    ], 90_000);
    created = true;
    await waitUntilReady();
  } catch (error) {
    untrack();
    // A `docker run` that timed out may still have created the container.
    if (!created) try { docker(["rm", "--force", "--volumes", name], 60_000); } catch { /* never created */ }
    await stop();
    throw error;
  }

  return {
    name,
    socketDir,
    pool(database: string, max = 4) {
      const pool = new pg.Pool({ host: socketDir, user: "postgres", database, max });
      // Like the production pools (createSpacePgPool): a client that the server
      // terminates, idle or checked out, must not become an unhandled 'error'.
      pool.on("error", () => {});
      pool.on("connect", (client) => client.on("error", () => {}));
      pools.push(pool);
      return pool;
    },
    async createDatabase(database: string) {
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error("database name must be a plain identifier");
      const admin = new pg.Pool({ host: socketDir, user: "postgres", database: "postgres", max: 1 });
      try { await admin.query(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
    },
    async restart(mode: "graceful" | "crash") {
      if (!restartable) throw new Error("restart() needs startDisposablePostgres(label, { restartable: true }): tmpfs data is lost on restart.");
      if (mode === "graceful") docker(["restart", "--time", "10", name], 60_000);
      else {
        docker(["kill", "--signal", "KILL", name], 30_000);
        docker(["start", name], 30_000);
      }
      await waitUntilReady();
    },
    stop
  };
}

/** Whether a maintainer-provided PostgreSQL socket is a run's own `<name>` in the reports folder
 * (~/agent-workspace/reports/<run>/<name>). The home directory is read here, not written as a path, so the public
 * export leaves the tests that use it as written (EXT-C-F18). */
export function isReportsSocket(socket: string | undefined, name = "pg-socket"): boolean {
  const root = `${path.join(os.homedir(), "agent-workspace", "reports")}/`;
  return !!socket?.startsWith(root) && new RegExp(`^[^/]+/${name}$`).test(socket.slice(root.length));
}

/** For integration tests that once ran only on a maintainer's socket: that socket when given (a reports-folder one),
 * else a disposable container, so they also run wherever Docker and the pinned image are, the public suite too
 * (EXT-C-F15). `skip` is true when neither can run. */
export function integrationPostgres(maintainerSocket: string | undefined, label: string) {
  let server: DisposablePostgres | undefined;
  return {
    skip: !maintainerSocket && disposablePostgresUnavailableReason() !== null,
    async socket(name = "pg-socket"): Promise<string> {
      if (maintainerSocket) {
        if (!isReportsSocket(maintainerSocket, name)) throw new Error("Disposable test socket required.");
        return maintainerSocket;
      }
      server = await startDisposablePostgres(label);
      return server.socketDir;
    },
    async stop() { await server?.stop(); }
  };
}
