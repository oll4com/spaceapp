import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const backupNamePattern = /^spaceapp-backup-\d{8}T\d{9}Z$/;

export function createBackupId(now = new Date()) {
  return `spaceapp-backup-${now.toISOString().replace(/[-:.]/g, "")}`;
}

export function parseDatabaseEnvironment(connectionString) {
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("SpaceApp database URL must use postgresql://.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !parsed.username || !databaseName || databaseName.includes("/")) {
    throw new Error("SpaceApp database URL is incomplete.");
  }
  const env = {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: databaseName
  };
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) env.PGSSLMODE = sslMode;
  return {
    databaseName,
    env,
    args: [`--dbname=${databaseName}`]
  };
}

export async function readDatabaseUrl(env = process.env) {
  if (env.SPACE_DATABASE_URL) return env.SPACE_DATABASE_URL;
  const file = env.SPACE_DATABASE_URL_FILE;
  if (!file) throw new Error("SPACE_DATABASE_URL or SPACE_DATABASE_URL_FILE is required.");
  const value = (await readFile(file, "utf8")).trim();
  if (!value) throw new Error("SpaceApp database URL secret is empty.");
  return value;
}

export async function createFileRecord(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return {
    sha256: digest.digest("hex"),
    size: (await stat(path)).size
  };
}

export async function runCommand(command, args, {
  env = process.env,
  capture = false,
  maxOutputBytes = 1024 * 1024
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"]
    });
    let output = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
          child.kill("SIGTERM");
          reject(new Error(`${command} output exceeded the safety limit.`));
        }
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${command} failed (${code ?? signal}).`));
      }
    });
  });
}

export async function createPortableBackup({
  env = process.env,
  stdout = process.stdout,
  now = new Date(),
  backupRoot = "/backups",
  dataRoot = "/var/lib/spaceapp",
  memoryRoot = "/var/lib/spaceapp/memory"
} = {}) {
  const backupId = createBackupId(now);
  if (!backupNamePattern.test(backupId)) throw new Error("Generated backup identifier is invalid.");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupRootStat = await stat(backupRoot);
  const target = join(backupRoot, backupId);
  await mkdir(target, { mode: 0o700 });

  try {
    const database = parseDatabaseEnvironment(await readDatabaseUrl(env));
    const databaseDump = join(target, "database.dump");
    const dataArchive = join(target, "data.tar.gz");
    const memoryArchive = join(target, "memory.tar.gz");
    const postgresEnv = { ...env, ...database.env };

    await runCommand("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      `--file=${databaseDump}`,
      ...database.args
    ], { env: postgresEnv });
    await runCommand("tar", [
      "--create",
      "--gzip",
      `--file=${dataArchive}`,
      `--directory=${dataRoot}`,
      "--exclude=./memory",
      "--exclude=./artifacts/browser-profiles",
      "--exclude=./browser-profiles",
      "."
    ]);
    await runCommand("tar", [
      "--create",
      "--gzip",
      `--file=${memoryArchive}`,
      `--directory=${memoryRoot}`,
      "."
    ]);

    const files = Object.fromEntries(await Promise.all(
      ["database.dump", "data.tar.gz", "memory.tar.gz"].map(async (name) => [
        name,
        await createFileRecord(join(target, name))
      ])
    ));
    const manifest = {
      format: "spaceapp-portable-backup",
      schemaVersion: 1,
      createdAt: now.toISOString(),
      appVersion: env.npm_package_version || "unknown",
      files
    };
    await writeFile(
      join(target, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
    await setTreeOwnership(target, backupRootStat.uid, backupRootStat.gid);
    stdout.write(`Backup created: ${backupId}\n`);
    return target;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function setTreeOwnership(path, uid, gid) {
  const item = await lstat(path);
  if (item.isDirectory()) {
    for (const entry of await readdir(path)) {
      await setTreeOwnership(join(path, entry), uid, gid);
    }
    await chmod(path, 0o700);
  } else {
    await chmod(path, 0o600);
  }
  try {
    await chown(path, uid, gid);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EINVAL") throw error;
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await createPortableBackup().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Portable backup failed."}\n`);
    process.exitCode = 1;
  });
}
