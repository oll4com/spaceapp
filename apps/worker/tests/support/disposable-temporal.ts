// A throwaway Temporal server with its own PostgreSQL, for worker crash proofs.
// Both containers run on a task-owned Docker bridge network with unique names.
// Docker port publishing is not used: the test reaches Temporal at its bridge
// address, and PostgreSQL through a Unix socket bind-mounted into a task-owned
// temporary directory. Nothing here talks to a live Space service.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Connection } from "@temporalio/client";
import pg from "pg";

/** Same images as the production compose file. Tests never pull them. */
export const disposablePostgresImage = process.env.SPACE_TEST_PG_IMAGE ?? "pgvector/pgvector:0.8.7-pg17-trixie";
export const disposableTemporalImage = process.env.SPACE_TEST_TEMPORAL_IMAGE ?? "temporalio/auto-setup:1.29.7";

function docker(args: string[], timeout = 60_000): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Why the disposable Temporal cannot run here, or null when it can. */
export function disposableTemporalUnavailableReason(): string | null {
  try {
    docker(["version", "--format", "{{.Server.Version}}"], 10_000);
  } catch {
    return "Docker is unavailable (`docker version` failed)";
  }
  for (const image of [disposablePostgresImage, disposableTemporalImage]) {
    try {
      docker(["image", "inspect", "--format", "{{.Id}}", image], 10_000);
    } catch {
      return `image ${image} is not present locally (run \`docker pull ${image}\`; tests never pull)`;
    }
  }
  return null;
}

export interface DisposableTemporal {
  /** Task-owned temporary directory; removed by stop(). */
  readonly root: string;
  readonly socketDir: string;
  /** Bridge address of the Temporal frontend, host:7233. */
  readonly temporalAddress: string;
  readonly namespace: string;
  readonly containers: readonly string[];
  readonly network: string;
  /** PostgreSQL connection string for a database, through the owned socket. */
  databaseUrl(database: string): string;
  pool(database: string, max?: number): pg.Pool;
  createDatabase(database: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startDisposableTemporal(label: string, namespace: string): Promise<DisposableTemporal> {
  if (!/^[a-z0-9-]{1,20}$/.test(label)) throw new Error("label must be short lowercase kebab-case");
  if (!/^[a-z0-9-]{1,40}$/.test(namespace)) throw new Error("namespace must be lowercase kebab-case");
  const root = await mkdtemp(path.join(os.tmpdir(), "space-tq-"));
  const socketDir = path.join(root, "socket");
  await mkdir(socketDir);
  await chmod(socketDir, 0o777);
  if (`${socketDir}/.s.PGSQL.5432`.length > 103) throw new Error("TMPDIR is too long for a PostgreSQL Unix socket path.");
  const suffix = randomBytes(4).toString("hex");
  const network = `space-test-${label}-net-${suffix}`;
  const pgName = `space-test-${label}-pg-${suffix}`;
  const temporalName = `space-test-${label}-temporal-${suffix}`;
  const containers: string[] = [];
  const pools: pg.Pool[] = [];
  let networkCreated = false;

  const stop = async () => {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    pools.length = 0;
    if (containers.includes(pgName)) {
      // The socket directory is sticky and owned by the container user; open it so the owner can delete it.
      try { docker(["exec", "--user", "root", pgName, "chmod", "0777", "/var/run/postgresql"]); } catch { /* already gone */ }
    }
    for (const name of [...containers].reverse()) {
      try { docker(["rm", "--force", "--volumes", name], 120_000); } catch { /* already gone */ }
    }
    containers.length = 0;
    if (networkCreated) {
      try { docker(["network", "rm", network], 60_000); } catch { /* already gone */ }
      networkCreated = false;
    }
    await rm(root, { recursive: true, force: true });
  };

  const newPool = (database: string, max: number) => {
    const pool = new pg.Pool({ host: socketDir, user: "postgres", database, max });
    pool.on("error", () => {});
    pool.on("connect", (client) => client.on("error", () => {}));
    return pool;
  };

  try {
    docker(["network", "create", "--label", "space.disposable-test=1", network]);
    networkCreated = true;
    docker([
      "run", "--detach", "--pull=never", "--name", pgName, "--label", "space.disposable-test=1", "--network", network,
      "--mount", `type=bind,source=${socketDir},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", disposablePostgresImage,
      "-c", "fsync=off", "-c", "max_connections=200"
    ]);
    containers.push(pgName);
    const probe = newPool("postgres", 1);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 480 && !ready; attempt += 1) {
        try {
          // The entrypoint first runs a temporary init server; only the final server runs as PID 1.
          if (docker(["exec", pgName, "cat", "/proc/1/comm"], 15_000) !== "postgres") throw new Error("initializing");
          await probe.query("SELECT 1");
          ready = true;
        } catch {
          await sleep(250);
        }
      }
      if (!ready) throw new Error(`Disposable PostgreSQL ${pgName} did not become ready.`);
    } finally {
      await probe.end();
    }

    docker([
      "run", "--detach", "--pull=never", "--init", "--name", temporalName, "--label", "space.disposable-test=1",
      "--network", network,
      "--env", "DB=postgres12", "--env", "DB_PORT=5432", "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PWD=disposable-trust-auth", "--env", `POSTGRES_SEEDS=${pgName}`,
      "--env", `DEFAULT_NAMESPACE=${namespace}`, "--env", "DEFAULT_NAMESPACE_RETENTION=24h",
      disposableTemporalImage
    ]);
    containers.push(temporalName);
    const ip = docker(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", temporalName]);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`Disposable Temporal ${temporalName} has no bridge address.`);
    const temporalAddress = `${ip}:7233`;
    const deadline = Date.now() + 240_000;
    for (;;) {
      try {
        const connection = await Connection.connect({ address: temporalAddress, connectTimeout: "3s" });
        try {
          await connection.workflowService.describeNamespace({ namespace });
          break;
        } finally {
          await connection.close();
        }
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`Disposable Temporal ${temporalName} did not become ready: ${String(error)}`);
        await sleep(1_000);
      }
    }

    return {
      root,
      socketDir,
      temporalAddress,
      namespace,
      containers: [...containers],
      network,
      databaseUrl: (database) => `postgres://postgres@localhost/${database}?host=${encodeURIComponent(socketDir)}`,
      pool(database: string, max = 4) {
        const pool = newPool(database, max);
        pools.push(pool);
        return pool;
      },
      async createDatabase(database: string) {
        if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error("database name must be a plain identifier");
        const admin = newPool("postgres", 1);
        try { await admin.query(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
      },
      stop
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
