import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBackupId,
  createFileRecord,
  parseDatabaseEnvironment
} from "../portable-backup.mjs";
import {
  selectBackup,
  selectLatestBackup,
  validateBackupManifest
} from "../portable-restore.mjs";

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
    appVersion: "0.1.0-alpha.1",
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
