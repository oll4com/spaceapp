import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

/** Same image as the production compose file (PostgreSQL 17 + pgvector). */
export const disposablePostgresImage = process.env.SPACE_TEST_PG_IMAGE ?? "pgvector/pgvector:0.8.7-pg17-trixie";

function docker(args: string[], timeout = 30_000): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
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
   * "crash" SIGKILLs every server process and starts again with WAL recovery. */
  restart(mode: "graceful" | "crash"): Promise<void>;
  stop(): Promise<void>;
}

/** Starts a throwaway PostgreSQL container with no network, reachable only
 * through a Unix socket in a task-owned temporary directory. Never use
 * createSpacePgPool against it: that factory may redirect to the live socket. */
export async function startDisposablePostgres(label: string): Promise<DisposablePostgres> {
  if (!/^[a-z0-9-]{1,24}$/.test(label)) throw new Error("label must be short lowercase kebab-case");
  const root = await mkdtemp(path.join(os.tmpdir(), "space-pg-"));
  const socketDir = path.join(root, "socket");
  await mkdir(socketDir);
  await chmod(socketDir, 0o777);
  if (`${socketDir}/.s.PGSQL.5432`.length > 103) throw new Error("TMPDIR is too long for a PostgreSQL Unix socket path.");
  const name = `space-test-${label}-${randomBytes(4).toString("hex")}`;
  const pools: pg.Pool[] = [];
  let created = false;

  const stop = async () => {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    if (created) {
      try { docker(["exec", "--user", "root", name, "chmod", "0777", "/var/run/postgresql"]); } catch { /* container already gone */ }
      docker(["rm", "--force", "--volumes", name], 60_000);
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

  try {
    docker([
      "run", "--detach", "--pull=never", "--name", name, "--label", "space.disposable-test=1", "--network", "none",
      "--mount", `type=bind,source=${socketDir},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", disposablePostgresImage, "-c", "listen_addresses=", "-c", "fsync=off"
    ]);
    created = true;
    await waitUntilReady();
  } catch (error) {
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
