import { lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import process from "node:process";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createFileRecord,
  parseDatabaseEnvironment,
  readDatabaseUrl,
  runCommand,
  setTreeOwnership
} from "./portable-backup.mjs";

const backupNamePattern = /^spaceapp-backup-\d{8}T\d{9}Z$/;
const expectedFileNames = ["database.dump", "data.tar.gz", "memory.tar.gz"];

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
  if (
    manifest?.format !== "spaceapp-portable-backup" ||
    manifest?.schemaVersion !== 1 ||
    !Number.isFinite(Date.parse(manifest?.createdAt)) ||
    typeof manifest?.files !== "object" ||
    manifest.files === null ||
    Object.keys(manifest.files).sort().join(",") !== [...expectedFileNames].sort().join(",")
  ) {
    throw new Error("Portable backup manifest has an unsupported format.");
  }
  for (const name of expectedFileNames) {
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

  await clearDirectory(dataRoot, new Set(["memory"]));
  await clearDirectory(memoryRoot);
  await runCommand("tar", [
    "--extract",
    "--gzip",
    `--file=${join(backupDirectory, "data.tar.gz")}`,
    `--directory=${dataRoot}`,
    "--no-same-owner",
    "--no-same-permissions"
  ]);
  await runCommand("tar", [
    "--extract",
    "--gzip",
    `--file=${join(backupDirectory, "memory.tar.gz")}`,
    `--directory=${memoryRoot}`,
    "--no-same-owner",
    "--no-same-permissions"
  ]);
  await setTreeOwnership(dataRoot, 10001, 10001);

  const database = parseDatabaseEnvironment(await readDatabaseUrl(env));
  await runCommand("pg_restore", [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
    "--exit-on-error",
    ...database.args,
    join(backupDirectory, "database.dump")
  ], { env: { ...env, ...database.env } });
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

async function clearDirectory(root, preserved = new Set()) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (preserved.has(entry.name)) continue;
    await rm(join(root, entry.name), { recursive: true, force: true });
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
