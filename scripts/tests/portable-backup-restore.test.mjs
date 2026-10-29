import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createBackupId,
  createFileRecord,
  createPortableBackup,
  parseDatabaseEnvironment
} from "../portable-backup.mjs";
import {
  RESTORE_UNCHANGED_EXIT,
  RestoreUnchangedError,
  restorePortableBackup,
  selectBackup,
  selectLatestBackup,
  validateBackupManifest
} from "../portable-restore.mjs";
import { RESTORE_UNCHANGED_EXIT as LAUNCHER_RESTORE_UNCHANGED_EXIT } from "../../packages/run-spaceapp/src/cli.mjs";

test("portable backups use sortable UTC identifiers and secret-free PostgreSQL process env", () => {
  assert.equal(
    createBackupId(new Date("2026-07-23T12:34:56.789Z")),
    "spaceapp-backup-20260723T123456789Z"
  );
  const database = parseDatabaseEnvironment(
    "postgresql://spaceapp:p%40ssword@postgres:5432/spaceapp"
  );
  assert.equal(database.databaseName, "spaceapp");
  assert.deepEqual(database.env, {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGUSER: "spaceapp",
    PGPASSWORD: "p@ssword",
    PGDATABASE: "spaceapp"
  });
  assert.doesNotMatch(JSON.stringify(database.args), /p@ssword|p%40ssword/);
});

test("restore selects the latest strict backup directory and validates every checksum", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-portable-restore-"));
  const older = join(root, "spaceapp-backup-20260723T120000000Z");
  const latest = join(root, "spaceapp-backup-20260723T130000000Z");
  await mkdir(older);
  await mkdir(latest);
  await mkdir(join(root, "not-a-backup"));
  await writeFile(join(latest, "database.dump"), "database");
  await writeFile(join(latest, "data.tar.gz"), "data");
  await writeFile(join(latest, "memory.tar.gz"), "memory");
  const files = Object.fromEntries(await Promise.all(
    ["database.dump", "data.tar.gz", "memory.tar.gz"].map(async (name) => [
      name,
      await createFileRecord(join(latest, name))
    ])
  ));
  const manifest = {
    format: "spaceapp-portable-backup",
    schemaVersion: 1,
    createdAt: "2026-07-23T13:00:00.000Z",
    appVersion: "0.1.0",
    files
  };
  await writeFile(join(latest, "manifest.json"), `${JSON.stringify(manifest)}\n`);

  assert.equal(await selectLatestBackup(root), latest);
  assert.equal(
    await selectBackup(root, "spaceapp-backup-20260723T120000000Z"),
    older
  );
  await assert.rejects(
    () => selectBackup(root, "../spaceapp-backup-20260723T130000000Z"),
    /identifier/i
  );
  await assert.doesNotReject(() => validateBackupManifest(latest));

  await writeFile(join(latest, "memory.tar.gz"), "tampered");
  await assert.rejects(() => validateBackupManifest(latest), /checksum/i);
});

async function backupWith(files, schemaVersion) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-portable-v2-"));
  const backup = join(root, "spaceapp-backup-20261016T120000000Z");
  await mkdir(backup);
  for (const [name, content] of Object.entries(files)) await writeFile(join(backup, name), content);
  const records = Object.fromEntries(await Promise.all(Object.keys(files).map(async (name) => [name, await createFileRecord(join(backup, name))])));
  await writeFile(join(backup, "manifest.json"), JSON.stringify({
    format: "spaceapp-portable-backup", schemaVersion, createdAt: "2026-10-16T12:00:00.000Z", appVersion: "1.1.6", files: records
  }));
  return { root, backup };
}

test("version 2 manifests may carry the Temporal dumps and nothing else", async () => {
  const base = { "database.dump": "db", "data.tar.gz": "data", "memory.tar.gz": "memory" };
  await assert.doesNotReject(async () => validateBackupManifest((await backupWith({ ...base, "temporal.dump": "t" }, 2)).backup));
  await assert.rejects(async () => validateBackupManifest((await backupWith({ ...base, "temporal.dump": "t" }, 1)).backup), /unsupported/);
  await assert.rejects(async () => validateBackupManifest((await backupWith({ ...base, "other.dump": "x" }, 2)).backup), /unsupported/);
  await assert.rejects(async () => validateBackupManifest((await backupWith({ "database.dump": "db", "data.tar.gz": "data" }, 2)).backup), /unsupported/);
});

async function restoreFixture() {
  const work = await mkdtemp(join(tmpdir(), "spaceapp-portable-restore-order-"));
  const source = join(work, "source");
  await mkdir(join(source, "data"), { recursive: true });
  await mkdir(join(source, "memory"));
  await writeFile(join(source, "data", "restored.txt"), "from backup");
  await writeFile(join(source, "memory", "graph.json"), "{}");
  execFileSync("tar", ["--create", "--gzip", `--file=${join(work, "data.tar.gz")}`, `--directory=${join(source, "data")}`, "."]);
  execFileSync("tar", ["--create", "--gzip", `--file=${join(work, "memory.tar.gz")}`, `--directory=${join(source, "memory")}`, "."]);
  const { root } = await backupWith({
    "database.dump": "db", "temporal.dump": "t",
    "data.tar.gz": await readFile(join(work, "data.tar.gz")), "memory.tar.gz": await readFile(join(work, "memory.tar.gz"))
  }, 2);
  // PostgreSQL shims: psql lists the Temporal database, pg_dump writes the pre-restore copy, pg_restore logs every call
  // and fails for FAIL_DB (backup dumps) or for every rollback when ROLLBACK_EXIT is set.
  const shims = join(work, "bin");
  await mkdir(shims);
  const log = join(work, "pg_restore.log");
  // psql logs its calls; the listing query prints the Temporal database unless NO_TEMPORAL.
  await writeFile(join(shims, "psql"), `#!/bin/sh\necho "$*" >> ${join(work, "psql.log")}\ncase "$*" in *pg_database*) [ -n "$NO_TEMPORAL" ] || printf 'temporal\\n';; esac\n`);
  await writeFile(join(shims, "pg_dump"), "#!/bin/sh\nfor arg; do case $arg in --file=*) echo \"$PGDATABASE before\" > \"${arg#--file=}\";; esac; done\n");
  await writeFile(join(shims, "pg_restore"), [
    "#!/bin/sh",
    `echo "$PGDATABASE $*" >> ${log}`,
    "case \"$*\" in *.spaceapp-restore-rollback*) exit ${ROLLBACK_EXIT:-0};; esac",
    "[ \"$PGDATABASE\" = \"$FAIL_DB\" ] && exit 1",
    "exit 0"
  ].join("\n") + "\n");
  for (const name of ["psql", "pg_dump", "pg_restore"]) await chmod(join(shims, name), 0o755);
  let run = 0;
  return async (extraEnv = {}) => {
    const dataRoot = join(work, `live-${run++}`);
    const memoryRoot = join(dataRoot, "memory");
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(dataRoot, "current.txt"), "live");
    await writeFile(join(memoryRoot, "current.json"), "live");
    await writeFile(log, "");
    const env = { PATH: `${shims}:${process.env.PATH}`, SPACE_DATABASE_URL: "postgresql://spaceapp:pw@postgres:5432/spaceapp", ...extraEnv };
    const result = restorePortableBackup({
      env, stdout: { write() {} }, inputRoot: root, backupId: "spaceapp-backup-20261016T120000000Z", confirmation: "RESTORE", dataRoot, memoryRoot
    });
    return { result, dataRoot, memoryRoot, log: async () => readFile(log, "utf8") };
  };
}

test("restore swaps the files in only after every database restored", async () => {
  const restore = await restoreFixture();
  const failed = await restore({ FAIL_DB: "spaceapp" });
  await assert.rejects(failed.result, /pg_restore failed/);
  assert.deepEqual((await readdir(failed.dataRoot)).sort(), ["current.txt", "memory"]);
  assert.deepEqual(await readdir(failed.memoryRoot), ["current.json"]);

  const ok = await restore();
  await ok.result;
  assert.deepEqual((await readdir(ok.dataRoot)).sort(), ["memory", "restored.txt"]);
  assert.deepEqual(await readdir(ok.memoryRoot), ["graph.json"]);
  const log = await ok.log();
  assert.match(log, /spaceapp .*--single-transaction.*database\.dump/);
  assert.match(log, /temporal .*--dbname=temporal .*temporal\.dump/);
  assert.doesNotMatch(log, /spaceapp-restore-rollback/);
  // Each database is emptied before its restore, never restored with --clean (cross-version restores, 1.1.8).
  assert.doesNotMatch(log, /--clean/);
  const psql = await readFile(join(dirname(ok.dataRoot), "psql.log"), "utf8");
  for (const db of ["spaceapp", "temporal"]) assert.match(psql, new RegExp(`--dbname=${db} --command=DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`));
});

test("a database that fails after another restored puts every database back as it was (1.1.7 review)", async () => {
  const restore = await restoreFixture();
  const failed = await restore({ FAIL_DB: "temporal" });
  await assert.rejects(failed.result, (error) => error instanceof RestoreUnchangedError && /put back as it was before the restore/.test(error.message));
  const log = (await failed.log()).trim().split("\n");
  // The app database restored, Temporal failed, then the app database came back from its pre-restore copy.
  assert.match(log[0], /^spaceapp .*database\.dump$/);
  assert.match(log[1], /^temporal .*temporal\.dump$/);
  assert.match(log[2], /^spaceapp .*--single-transaction.*\.spaceapp-restore-rollback\/spaceapp\.dump$/);
  assert.equal(log.length, 3);
  assert.deepEqual((await readdir(failed.dataRoot)).sort(), ["current.txt", "memory"]);
  assert.deepEqual(await readdir(failed.memoryRoot), ["current.json"]);
});

test("a rollback that fails keeps the pre-restore copies and prints how to put them back", async () => {
  const restore = await restoreFixture();
  const failed = await restore({ FAIL_DB: "temporal", ROLLBACK_EXIT: "1" });
  const error = await failed.result.then(() => null, (caught) => caught);
  assert.ok(error instanceof Error);
  // Left partly at the backup's state: not an unchanged restore, so the launcher keeps SpaceApp stopped.
  assert.ok(!(error instanceof RestoreUnchangedError));
  assert.match(error.message, /spaceapp is at the backup's state/);
  assert.match(error.message, /run the same restore again/);
  assert.match(error.message, /psql --dbname=spaceapp --command="DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" && pg_restore --no-owner --no-acl --single-transaction --exit-on-error --dbname=spaceapp .*\.spaceapp-restore-rollback\/spaceapp\.dump/);
  assert.deepEqual((await readdir(join(failed.dataRoot, ".spaceapp-restore-rollback"))).sort(), ["spaceapp.dump", "temporal.dump"]);
  assert.deepEqual((await readdir(failed.dataRoot)).sort(), [".spaceapp-restore-rollback", "current.txt", "memory"]);
});

test("a backup with workflow history is refused before any change where Temporal does not exist (1.1.8)", async () => {
  const restore = await restoreFixture();
  const refused = await restore({ NO_TEMPORAL: "1" });
  const error = await refused.result.then(() => null, (caught) => caught);
  assert.ok(error instanceof RestoreUnchangedError);
  assert.match(error.message, /workflow history \(temporal\)/);
  assert.match(error.message, /Nothing was changed/);
  assert.match(error.message, /install --profile medium/);
  assert.equal((await refused.log()).trim(), "");
  assert.deepEqual((await readdir(refused.dataRoot)).sort(), ["current.txt", "memory"]);
  assert.deepEqual(await readdir(refused.memoryRoot), ["current.json"]);
});

test("a failure before the first database restore is an unchanged restore; the launcher and the script agree on its exit code", async () => {
  const restore = await restoreFixture();
  const refused = await restore({ SPACE_DATABASE_URL: "not-a-url" });
  const error = await refused.result.then(() => null, (caught) => caught);
  assert.ok(error instanceof RestoreUnchangedError, String(error));
  assert.match(error.message, /Nothing was changed/);
  assert.equal(RESTORE_UNCHANGED_EXIT, 3);
  assert.equal(LAUNCHER_RESTORE_UNCHANGED_EXIT, RESTORE_UNCHANGED_EXIT);
});

test("backup dumps the Temporal databases that exist next to the app database", async () => {
  const work = await mkdtemp(join(tmpdir(), "spaceapp-portable-backup-temporal-"));
  const shims = join(work, "bin");
  const dataRoot = join(work, "data");
  await mkdir(shims);
  await mkdir(join(dataRoot, "memory"), { recursive: true });
  await writeFile(join(dataRoot, "settings.json"), "{}");
  for (const leftover of [".spaceapp-restore-staging", ".spaceapp-restore-rollback", ".spaceapp-restore-previous"]) {
    await mkdir(join(dataRoot, leftover));
    await writeFile(join(dataRoot, leftover, "x"), "x");
  }
  await writeFile(join(shims, "psql"), "#!/bin/sh\nprintf 'temporal\\ntemporal_visibility\\n'\n");
  await writeFile(join(shims, "pg_dump"), `#!/bin/sh\necho "$PGDATABASE $*" >> ${join(work, "pg_dump.log")}\nfor arg; do case $arg in --file=*) echo "$PGDATABASE" > "\${arg#--file=}";; esac; done\n`);
  await chmod(join(shims, "psql"), 0o755);
  await chmod(join(shims, "pg_dump"), 0o755);
  const target = await createPortableBackup({
    env: { PATH: `${shims}:${process.env.PATH}`, SPACE_DATABASE_URL: "postgresql://spaceapp:pw@postgres:5432/spaceapp", SPACE_APP_VERSION: "1.1.7" },
    stdout: { write() {} }, now: new Date("2026-10-16T12:00:00.000Z"),
    backupRoot: join(work, "backups"), dataRoot, memoryRoot: join(dataRoot, "memory")
  });
  const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  // The core's own version (Claude review 1.1.7 F6: it was always "unknown").
  assert.equal(manifest.appVersion, "1.1.7");
  assert.deepEqual(Object.keys(manifest.files).sort(),
    ["data.tar.gz", "database.dump", "memory.tar.gz", "temporal.dump", "temporal_visibility.dump"]);
  assert.equal((await readFile(join(target, "temporal_visibility.dump"), "utf8")).trim(), "temporal_visibility");
  await assert.doesNotReject(() => validateBackupManifest(target));
  const archived = execFileSync("tar", ["--list", "--gzip", `--file=${join(target, "data.tar.gz")}`], { encoding: "utf8" });
  assert.match(archived, /settings\.json/);
  assert.doesNotMatch(archived, /spaceapp-restore-/);
  // Every dump gives up on a lock it cannot get instead of freezing the paused installation (1.1.8).
  const dumps = (await readFile(join(work, "pg_dump.log"), "utf8")).trim().split("\n");
  assert.equal(dumps.length, 3);
  for (const dump of dumps) assert.match(dump, /--lock-wait-timeout=120000/);
});
