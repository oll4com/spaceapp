import { lstat, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import process from "node:process";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createFileRecord,
  hostSecretEntries,
  optionalBackupFiles,
  parseDatabaseEnvironment,
  readDatabaseUrl,
  requiredBackupFiles,
  runCommand,
  setTreeOwnership,
  temporalDatabases
} from "./portable-backup.mjs";

const backupNamePattern = /^spaceapp-backup-\d{8}T\d{9}Z$/;
const stagingName = ".spaceapp-restore-staging";
// The databases as they were before the restore, and the files the restore replaced, kept until it has finished.
const rollbackName = ".spaceapp-restore-rollback";
const previousName = ".spaceapp-restore-previous";
const restoreArgs = ["--clean", "--if-exists", "--no-owner", "--no-acl", "--single-transaction", "--exit-on-error"];

export async function selectLatestBackup(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && backupNamePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const latest = candidates.at(-1);
  if (!latest) throw new Error("No portable SpaceApp backup was found.");
  return join(root, latest);
}

export async function selectBackup(root, backupId) {
  if (!backupNamePattern.test(backupId)) {
    throw new Error("Portable backup identifier is invalid.");
  }
  const backupRoot = resolve(root);
  const backupDirectory = resolve(backupRoot, backupId);
  if (!backupDirectory.startsWith(`${backupRoot}${sep}`)) {
    throw new Error("Portable backup path escaped the backup root.");
  }
  const backupStat = await lstat(backupDirectory);
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
    throw new Error("Portable backup target must be a real directory.");
  }
  return backupDirectory;
}

export async function validateBackupManifest(backupDirectory) {
  if (!backupNamePattern.test(basename(backupDirectory))) {
    throw new Error("Portable backup directory name is invalid.");
  }
  const manifestPath = join(backupDirectory, "manifest.json");
  const manifestStat = await stat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > 64 * 1024) {
    throw new Error("Portable backup manifest is invalid.");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // Version 1 has the three required files; version 2 may add the Temporal database dumps.
  const names = typeof manifest?.files === "object" && manifest.files !== null ? Object.keys(manifest.files) : [];
  const allowed = manifest?.schemaVersion === 2 ? [...requiredBackupFiles, ...optionalBackupFiles] : requiredBackupFiles;
  if (
    manifest?.format !== "spaceapp-portable-backup" ||
    (manifest?.schemaVersion !== 1 && manifest?.schemaVersion !== 2) ||
    !Number.isFinite(Date.parse(manifest?.createdAt)) ||
    !requiredBackupFiles.every((name) => names.includes(name)) ||
    !names.every((name) => allowed.includes(name))
  ) {
    throw new Error("Portable backup manifest has an unsupported format.");
  }
  for (const name of names) {
    const expected = manifest.files[name];
    if (
      !expected ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      !Number.isSafeInteger(expected.size) ||
      expected.size < 0
    ) {
      throw new Error(`Portable backup manifest entry ${name} is invalid.`);
    }
    const actual = await createFileRecord(join(backupDirectory, name));
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(`Portable backup checksum validation failed for ${name}.`);
    }
  }
  return manifest;
}

export async function restorePortableBackup({
  env = process.env,
  stdout = process.stdout,
  inputRoot = "/backups",
  backupId = "",
  confirmation = "",
  dataRoot = "/var/lib/spaceapp",
  memoryRoot = "/var/lib/spaceapp/memory"
} = {}) {
  if (confirmation !== "RESTORE") {
    throw new Error("Portable restore requires explicit RESTORE confirmation.");
  }
  const backupRoot = resolve(inputRoot);
  const backupDirectory = await selectBackup(backupRoot, backupId);
  const manifest = await validateBackupManifest(backupDirectory);
  await validateTarArchive(join(backupDirectory, "data.tar.gz"));
  await validateTarArchive(join(backupDirectory, "memory.tar.gz"));

  // Files are extracted next to the live data first and swapped in only after every database restored (external
  // review 2026-10-16). Each database restores in its own transaction, so before the first one the current databases
  // are copied aside: when a later database or the file swap fails, every database restored so far and the files go
  // back to how they were (run-spaceapp 1.1.7 review). Staging stays on each root's own filesystem: the memory root
  // can be a separate volume.
  const dataStaging = join(dataRoot, stagingName);
  const memoryStaging = join(memoryRoot, stagingName);
  const rollbackDirectory = join(dataRoot, rollbackName);
  const restored = [];
  let swapped = null;
  let keepRollback = false;
  try {
    for (const [archive, staging] of [["data.tar.gz", dataStaging], ["memory.tar.gz", memoryStaging]]) {
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { mode: 0o700 });
      await runCommand("tar", [
        "--extract",
        "--gzip",
        `--file=${join(backupDirectory, archive)}`,
        `--directory=${staging}`,
        "--no-same-owner",
        "--no-same-permissions"
      ]);
    }

    const database = parseDatabaseEnvironment(await readDatabaseUrl(env));
    const postgresEnv = (databaseName) => ({ ...env, ...database.env, PGDATABASE: databaseName });
    const restores = [[database.databaseName, "database.dump"], ...optionalBackupFiles
      .filter((name) => manifest.files[name])
      .map((name) => [name.replace(/\.dump$/, ""), name])];
    const present = new Set([database.databaseName, ...(await runCommand("psql", [
      "--no-psqlrc", "--tuples-only", "--no-align",
      `--command=SELECT datname FROM pg_database WHERE datname IN (${temporalDatabases.map((name) => `'${name}'`).join(", ")}) ORDER BY datname`,
      ...database.args
    ], { env: postgresEnv(database.databaseName), capture: true })).split(/\r?\n/).filter((name) => temporalDatabases.includes(name))]);
    await rm(rollbackDirectory, { recursive: true, force: true });
    await mkdir(rollbackDirectory, { mode: 0o700 });
    for (const [databaseName] of restores) {
      if (!present.has(databaseName)) continue;
      await runCommand("pg_dump", [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        `--file=${join(rollbackDirectory, `${databaseName}.dump`)}`,
        `--dbname=${databaseName}`
      ], { env: postgresEnv(databaseName) });
    }

    try {
      for (const [databaseName, dump] of restores) {
        await runCommand("pg_restore", [...restoreArgs, `--dbname=${databaseName}`, join(backupDirectory, dump)], { env: postgresEnv(databaseName) });
        restored.push(databaseName);
      }
      swapped = { data: await swapEntries(dataRoot, dataStaging, new Set(["memory", stagingName, rollbackName, ...hostSecretEntries])) };
      swapped.memory = await swapEntries(memoryRoot, memoryStaging, new Set([stagingName]));
    } catch (error) {
      const fileProblem = swapped ? await undoSwap(swapped).then(() => null, (undoError) => undoError) : null;
      const stillRestored = [];
      for (const databaseName of [...restored].reverse()) {
        if (!present.has(databaseName)) { stillRestored.push(databaseName); continue; }
        try {
          await runCommand("pg_restore", [...restoreArgs, `--dbname=${databaseName}`, join(rollbackDirectory, `${databaseName}.dump`)], { env: postgresEnv(databaseName) });
        } catch {
          stillRestored.push(databaseName);
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (!stillRestored.length && !fileProblem) {
        throw new Error(`Restore failed (${reason}). Every database and file was put back as it was before the restore.`);
      }
      keepRollback = true;
      const steps = stillRestored.map((databaseName) => present.has(databaseName)
        ? `pg_restore ${restoreArgs.join(" ")} --dbname=${databaseName} ${join(rollbackDirectory, `${databaseName}.dump`)}`
        : `(no copy: ${databaseName} did not exist before the restore)`);
      throw new Error([
        `Restore failed (${reason}) and could not be fully undone.`,
        ...stillRestored.map((databaseName) => `${databaseName} is at the backup's state, not at its state before the restore.`),
        ...(fileProblem ? [`The files could not be put back (${fileProblem.message}); the replaced files are in ${join(dataRoot, previousName)} and ${join(memoryRoot, previousName)}.`] : []),
        "To finish the restore instead, run the same restore again: it restores every database and the files from the backup.",
        "To put a database back as it was before the restore, run in the core container, with its database connection:",
        ...steps
      ].join("\n"));
    }
    await rm(swapped.data.previous, { recursive: true, force: true });
    await rm(swapped.memory.previous, { recursive: true, force: true });
  } finally {
    await rm(dataStaging, { recursive: true, force: true });
    await rm(memoryStaging, { recursive: true, force: true });
    if (!keepRollback) await rm(rollbackDirectory, { recursive: true, force: true });
  }
  await setTreeOwnership(dataRoot, 10001, 10001);
  stdout.write(`Backup restored: ${basename(backupDirectory)} (${manifest.createdAt})\n`);
  return backupDirectory;
}

async function validateTarArchive(path) {
  const output = await runCommand("tar", ["--list", "--gzip", `--file=${path}`], {
    capture: true,
    maxOutputBytes: 4 * 1024 * 1024
  });
  for (const entry of output.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replace(/^\.\//, "");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error("Portable backup archive contains an unsafe path.");
    }
  }
}

// Moves the current entries of root aside into root/.spaceapp-restore-previous and the staged ones in; every move is
// recorded so undoSwap can reverse it.
async function swapEntries(root, staging, preserved) {
  const previous = join(root, previousName);
  const swap = { root, previous, movedOut: [], movedIn: [] };
  await rm(previous, { recursive: true, force: true });
  await mkdir(previous, { mode: 0o700 });
  for (const entry of await readdir(root)) {
    if (preserved.has(entry) || entry === previousName) continue;
    await rename(join(root, entry), join(previous, entry));
    swap.movedOut.push(entry);
  }
  for (const entry of await readdir(staging)) {
    await rename(join(staging, entry), join(root, entry));
    swap.movedIn.push(entry);
  }
  return swap;
}

async function undoSwap({ data, memory }) {
  for (const swap of [memory, data].filter(Boolean)) {
    for (const entry of swap.movedIn) await rm(join(swap.root, entry), { recursive: true, force: true });
    for (const entry of swap.movedOut) await rename(join(swap.previous, entry), join(swap.root, entry));
    await rm(swap.previous, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  let inputRoot = "/backups";
  let backupId = "";
  let confirmation = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input" && argv[index + 1]) {
      inputRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--backup-id" && argv[index + 1]) {
      backupId = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--confirm" && argv[index + 1]) {
      confirmation = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("Usage: portable-restore.mjs --input /backups --backup-id <id> --confirm RESTORE");
  }
  return { inputRoot, backupId, confirmation };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    await restorePortableBackup(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Portable restore failed."}\n`);
    process.exitCode = 1;
  }
}
