# Restore, migrations and memory evaluation

Plan package 7 evidence, measured on 2026-10-11 on public-host. Redacted run reports
(names, counts, hashes, timings only) are in
`/var/lib/spaceapp-user/agent-workspace/reports/20261011-restore-drill/`.

## Backup scope today

Only one mechanism covers Space's PostgreSQL: the Proxmox `vzdump` of the whole
public-host (both disks: `scsi0` 262G and `scsi1` 200G). It is part of job
`backup-d1234567-0002-main-replacement`.

| Property | Value |
| --- | --- |
| Schedule | `Wed 02:30` (Europe/Athens), weekly |
| Mode | snapshot; guest agent `fs-freeze`/`fs-thaw`; lzo; `--bwlimit 20480` KiB/s; `max-workers=1` |
| Target | `hetzner-backup` (StorageBox, `/mnt/hetzner-backup/dump`), `keep-last=2` |
| Retained public-host archives | `vzdump-qemu-207-2026_09_16-09_03_22.vma.lzo` (110.5 GB), `vzdump-qemu-207-2026_10_07-09_03_36.vma.lzo` (142.2 GB) |

The job backs up guests one after another, so public-host's snapshot is taken about
6.5 h after the job starts (09:03 EEST). The last run (2026-10-07) read 462 GiB
in 6 h 26 min (20.4 MiB/s, archive 132.44 GB).

There is no logical dump, no WAL archiving (so no point-in-time recovery) and
no Space-specific backup timer. `space-db-cleanup.timer` prunes data; it is not a
backup.

The database cluster is the `space-postgres-1` container
(`pgvector/pgvector:0.8.7-pg17-trixie`, PostgreSQL 17.11), stored in volume
`space_space-postgres` under `/var/lib/docker` (ext4 on `/dev/sdb1`). It holds
three databases:

| Database | Size |
| --- | --- |
| `space` | about 299 MB |
| `temporal` | 26 MB |
| `temporal_visibility` | 18 MB |

## RPO

**From the schedule: up to 7 days.** One crash-consistent snapshot is taken per
week. Anything written after a snapshot is lost until the next successful run.

**Observed: 21 days.** public-host failed in two runs in a row:

- 2026-09-23: the job failed at `pve_backup_safety_hook.sh job-init`.
- 2026-09-30: public-host failed at the `backup-start` hook.

So the gap between restorable points was 2026-09-16 09:03 → 2026-10-07 09:03.
When the drill ran (2026-10-11 15:20 EEST), the newest restorable point was
4 days 6 hours old.

That point is a block-level snapshot taken with the filesystem frozen. Starting
PostgreSQL on it means WAL crash recovery. The 2026-10-07 archive was restored
and verified on 2026-10-12 without a VM boot; see
[VM archive restore drill](#vm-archive-restore-drill-2026-10-12).

## What backups exclude

The VM image includes everything on public-host's disks, up to the snapshot moment.
It excludes:

- other guests and the Proxmox host
- the StorageBox itself
- the job's `--exclude-path` entries, which are not Space paths

The logical dump used by the drill, and any future logical backup built on it,
contains only the three databases. It excludes:

- **Credentials and cluster globals.**
  - Roles, role passwords and memberships are not dumped. The drill recreates
    role names only, with no password.
  - Service credentials and the server secret live in `/opt/spaceapp/.env` and
    `secrets/`.
  - Connector tokens are in the dump but sealed with AES-256-GCM, using a key
    derived from the server secret. Without the original secret they cannot be
    decrypted.
- **Files.**
  - Agent Files and artifact bytes: `SPACE_ARTIFACT_ROOT`, by default
    `/opt/spaceapp/var/artifacts`. The database keeps only metadata and hashes.
  - Workspace and project directories, and CLI workspaces.
  - Canonical memory Markdown (`/opt/spaceapp/docs/space_memory*.md`) and memory graph
    snapshots (`/opt/spaceapp/var/memory-graph`).
- **Runtime state.**
  - Provider-native CLI session files, CLI host PTY/terminal buffers, and
    browser profiles.
  - Running processes, Docker images, systemd units and nginx configuration.
- **Other databases.** The `postgres` and template databases.

## Restore drill

`scripts/restore-drill.mjs` restores a live snapshot into a separate,
disposable environment.

**1. Consistent snapshot.** In the source container it opens a
`REPEATABLE READ, READ ONLY` session with `default_transaction_read_only=on`
and exports the snapshot. `pg_dump --snapshot` runs on that exact snapshot
(`--lock-wait-timeout=5000`). The same transaction then computes, for every
table:

- the row count
- a SHA-256 over the sorted MD5 of each row's text form

The digest does not depend on physical row order. All of this happens at one
consistent point while live writes continue.

**2. Restore.** The dump is streamed straight into a new container, never
touching the host disk. The container is named `space-restore-drill-<time>-<rand>`
and has:

- the same image as the source
- `--network none`, a Unix socket only
- `--cpus 2 --memory 2g`

It restores with `pg_restore --create --exit-on-error --jobs 2`.

**3. Verification.** Every table's count and digest is compared with the
source. The drill also compares:

- a catalog fingerprint: database locale, extensions, columns, constraints
  (pretty `pg_get_constraintdef`), indexes, triggers, function bodies, views,
  sequence definitions, owners and ACLs
- the `space_schema_migrations` rows (id, filename, `applied_at`)
- an orphan query for every foreign key
- index validity
- sequences: never rewound, and always ahead of the data they number

**4. Application check.** The restored `space` database is opened with
`PostgresSpaceStore`, through a direct socket pool. It never uses
`createSpacePgPool`, which may redirect to the live socket. The deploy
migration runner (`applyPendingMigrations`, the same code as `migrate.js`) then:

- applies pending migrations
- must leave every existing history row unchanged
- must apply nothing on a second pass

`listRooms()` must match the row count. A write probe creates a room and
checks that the event relay sequence advances.

**5. Drift report.** Outside the RTO window, a clean install of the
checkout's migrations is built next to the restore. Schema drift between the two
is reported.

**6. Cleanup.** The container, its anonymous volume and the socket directory are
always removed (`finally`, plus SIGINT/SIGTERM handling). Removal is verified and
written to the report.

```sh
npm run build -w @space/db
TMPDIR=/var/lib/spaceapp-user/agent-workspace/t node scripts/restore-drill.mjs \
  --source-container space-postgres-1 --source-user space \
  --databases space,temporal,temporal_visibility \
  --report-dir /var/lib/spaceapp-user/agent-workspace/reports/<task>
```

All source flags are required; there is no default live target. The report
directory must be outside the repository and `/opt/spaceapp`. Pure parts are
covered in `scripts/tests/restore-drill.test.mjs`, which is part of
`npm run test:deploy`.

**Pre-deploy use.** Run the drill from a checkout that contains a candidate's
new migrations. Step 4 then applies exactly those migrations to a restored copy
of live data and proves history is kept. This is the only data-bearing upgrade
test.

### Measured RTO

**Definition.** RTO is the wall time from starting an empty target to a
verified, store-opened database:

- target start
- `pg_restore` of all three databases
- full verification
- store and migration-runner checks

It excludes taking the dump (backup side), the clean-install comparison and
cleanup.

| Run (UTC) | Commit | RTO | Target start | Restore | Verify | Store + runner | Dump + source digests | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 12:19:41 | b97fa169a9 + script draft | 28.12 s | 1.88 | 8.19 | 9.90 | 8.15 | 17.81 | 47.42 |
| 12:22:38 | b97fa169a9 + final script | 13.52 s | 2.98 | 5.57 | 3.94 | 1.04 | 11.18 | 27.28 |
| 12:35:55 | 960aaa9bdb | **18.35 s** | 3.27 | 5.89 | 5.70 | 3.49 | 13.12 | 35.69 |

All times except RTO are in seconds.

**Conditions.**

- **Host.** public-host (20 vCPU Intel Xeon W-2295, 39.9 GiB RAM).
- **Disk.** Docker root is ext4 on the virtual disk `/dev/sdb1` (QEMU; reported
  as rotational).
- **Load.** Load average was 11–14 throughout, shared with the live services
  and other agents' builds.
- **Source.** Live and taking writes.
- **Dumps (custom format).**

  | Database | Dump size | Dump time |
  | --- | --- | --- |
  | `space` | 37.6 MB | 5.9 s |
  | `temporal` | 2.2 MB | 0.6 s |
  | `temporal_visibility` | 47 KB | 0.4 s |

The median RTO is 18.4 s and the maximum 28.1 s. It applies only when a logical
dump is at hand. The existing VM-level backup has no measured RTO.

### Verification results (run 3, commit 960aaa9bdb)

**`space`: all checks pass.**

- 148/148 tables have equal counts and digests (386,787 rows).
- The catalog fingerprint is equal: 1,650 columns, 913 constraints, 402
  indexes, 18 triggers, 16 functions, 4 extensions, 2 sequences, and owners.
- Migration history is identical: 154 rows, last `0152_dot_channels`.
- 217 foreign keys were checked, with 0 orphans; there are 0 invalid indexes.
- Sequences are neither rewound nor behind their data.
- The migration runner had 0 pending and 0 on the second pass.
- `listRooms()` equals the room rows. The write probe persisted a room and
  advanced the event sequence.

**`temporal`: pass.** 39 tables, 15,874 rows, all equal.

**`temporal_visibility`: pass.** 3 tables, 146 rows, all equal.

**Cleanup: confirmed.** The container and volume were removed, as was the
socket directory. The dumps existed only inside the removed container.

Runs 1 and 2 passed the same checks: 390,295 and 390,452 `space` rows.

**Continuation that is supported and proven:**

- new rooms and events continue after the restored data (sequences, unique
  `room_order`, `relay_sequence`)
- pending migrations apply on top of restored history

Continuation of CLI and provider-native sessions, artifacts and memory files is
not part of a database restore; see the exclusions above.

### Schema drift: live compared with a clean install (finding)

The drill compares the restored live schema with a clean install of the same
checkout. It found four differences.

**`pageinspect` extension.** Installed on live only, by manual DDL.

**`source_control_connections_repository_owner_check`.**

- Live: `repository_owner = 'oll4com'`.
- Clean install: `repository_owner ~ '^[A-Za-z0-9_.-]{1,160}$'`.

Migration `0056_admin_operations.sql` was edited (b829545c93, 2026-08-07) after
it had shipped (2026-07-23). Installed systems never re-run it. Migration CI now
fails if any file shipped since 0.2.0 is edited.

**Three live-only indexes.** `idx_cli_task_revisions_source_rev`,
`idx_cli_task_revisions_space_session` and `idx_pane_cli_sessions_cli_task_id`
appear in no migration or repository history: they were created by manual DDL.
A restore keeps them; a rebuild from migrations would lose them.

**History row without a file.** `0094_ui_feature_visibility` was applied, then
its file was reverted in a346161aa0. Its table does not exist on live. The
runner keeps the row, and CI covers that case.

## Migration CI

`packages/db/tests/migration-install-upgrade-postgres.test.ts` runs on a
disposable `pgvector/pgvector:0.8.3-pg17-trixie` container: no network,
`fsync=off`, socket only. Override the image with `SPACE_TEST_PG_IMAGE`.

**Clean install.**

- All 153 migrations apply once to an empty database, in filename order.
- History equals the applied list.
- A second pass applies nothing.

**Upgrades.** The supported sources are:

- platform release 0.2.0 (`b9706d9b7e`, 130 migrations)
- platform release 0.2.5 (`16936bdf76`, 132 migrations)
- tag `v2026.10.10.1` (`71f5dc7b21`, 137 migrations)

For each source, the test:

- applies that release's own migration files, read from git
- records a history row whose file was later removed
- upgrades to HEAD and checks that exactly the missing IDs are applied
- checks that every earlier history row is unchanged
- checks that a second pass applies nothing
- compares the resulting schema with the clean install, category by category
- deliberately adds a column, to show the comparison is not vacuous
- checks that shipped files are neither removed, renamed nor edited

**Identity rules.** The existing `migration-identities.test.ts` covers unique
new prefixes and deterministic full-ID order.

**Result:** 4/4 pass in about 6–8 s. Without Docker or the image, the file skips
and prints the reason on stderr, for example
`[migration CI] skipped: image … is not present locally`. A clone without a
release commit skips only that case, with a note. A skipped run is not
evidence.

**Adding a release.** When a new platform release is cut
(`version.json` `platform.gitCommit`), add it to `upgradeSources`.

```sh
cd packages/db
TMPDIR=/var/lib/spaceapp-user/agent-workspace/t ../../node_modules/.bin/vitest run \
  tests/migration-install-upgrade-postgres.test.ts tests/migration-identities.test.ts tests/migration-runner.test.ts
```

## Memory evaluation and lifecycle

### `npm run memory:eval`

Run at commit 960aaa9bdb (fixture hash `7b2b03a0…0599`). The fixture has 15
documents, 30 positive queries and 10 negative queries. Two runs gave the same
determinism hash (`a45d8d41…`).

| Metric | Repository threshold | Result |
| --- | --- | --- |
| recall@5 | ≥ 0.85 | 1.00 |
| mean reciprocal rank | ≥ 0.75 | 1.00 |
| false-positive rate | ≤ 0.05 | 0.00 |

The fixture is synthetic and small. It gates retrieval behavior, not production
memory quality.

### Lifecycle and concurrency tests

**Bug found and fixed.** Two overlapping `prepareMemoryConsolidation` attempts
on a run already in `RUNNING` each created an operation per finding. That is
the case of an activity retry running beside a slow attempt.

- With 8 concurrent writers, PostgreSQL got 8 operation rows.
- `finalizeMemoryRepair` then counted one archive as several applied
  operations.

`createMemoryConsolidationOperation` is now idempotent per (run, finding):

- PostgreSQL checks under the existing run-row `FOR UPDATE` lock.
- `InMemorySpaceStore` uses the same rule.

Workflow code is unchanged.

**`apps/worker/tests/memory-consolidation-lifecycle.test.ts`**

- Racing prepares, for both queued and already-`RUNNING` runs, leave one
  finding, one operation and one change set per issue.
- A canonical save between prepare and execution fails the repair closed and
  keeps the new record.
- An applied repair makes the persisted snapshot stale, and stale plans are
  refused.
- After a refresh, the next run has nothing left to repair.

**`apps/api/tests/memory-graph-service-lifecycle.test.ts`**

- The graph goes stale on save and on deletion, and rebuilds only current
  records after invalidation.
- Invalidation racing an in-flight build never reports or caches a pre-save
  graph as fresh.
- Concurrent readers share one build.

**`packages/db/tests/memory-concurrency-postgres.test.ts`** (real PostgreSQL,
all migrations)

- consolidation runs are deduplicated by key
- findings are unique per issue, and operations unique per finding
- change-set IDs are deterministic, and a different body under the same ID is
  rejected
- live personal memory compare-and-set: with 8 concurrent writers per revision,
  exactly one wins, and the journal has one row per revision

## VM archive restore drill (2026-10-12)

The newest weekly archive, `vzdump-qemu-207-2026_10_07-09_03_36.vma.lzo`
(132.44 GB, taken 2026-10-07 06:03:38 UTC), was restored and checked from
public-host itself, without touching the Proxmox host, `local-zfs` or the live
VM. Redacted reports (names, counts, hashes, timings) are in
`/var/lib/spaceapp-user/agent-workspace/reports/20261012-vm-restore-drill/`.

**1. Archive integrity and rebuild** (`vma-restore-drill.py`, an independent
VMA reader, because the Proxmox `vma` tool is not on public-host). The archive was
streamed through `lzop -dc` from the StorageBox and both disks were rebuilt
as sparse raw images in a root-only temporary folder on the StorageBox.

| Check | Result |
| --- | --- |
| Header MD5, every extent's magic, UUID, MD5 and block count | all pass, 130,508 extents |
| Each cluster appears exactly once (scsi0 4,292,608, scsi1 3,276,800) | complete, no duplicates |
| Data rebuilt | scsi0 183.5 GiB, scsi1 81.5 GiB (265 GiB decompressed) |
| Writer check | 278,400 blocks of the first 300 extents re-read equal to the stream |
| Throughput | 3 h 01 min, about 25 MiB/s, limited by StorageBox writes |

**2. Filesystems** (`e2fsck -fn`, read-only, on the images; no loop mount, so
no duplicate filesystem UUID appeared on the live host). Both filesystems are
whole: scsi0 6,307,139 inodes and 48.2 M blocks in use, scsi1 591,988 inodes
and 12.5 M blocks. `e2fsck` exits 4 on both, with only the differences a live
snapshot leaves before orphan processing (deleted inodes with zero dtime,
block/inode bitmap and directory-count differences, an unclean orphan file),
which a normal mount or `e2fsck -p` resolves. No structural damage was reported.

**3. Contents.** scsi1 is the `/opt/spaceapp` checkout at `main` →
`40c89725fb` (42 top-level entries). scsi0 holds the PostgreSQL volume
(`PG_VERSION` 17, owner 999, 946 MB).

**4. PostgreSQL from the archive.** The volume was copied out with `debugfs
rdump` and started in a throwaway `pgvector/pgvector:0.8.3-pg17-trixie`
container with `--network none`. It ran WAL crash recovery ("last known up at
2026-10-07 06:00:28 UTC", redo done in 0.37 s) and accepted connections in 5 s:

| Database | Size | Notes |
| --- | --- | --- |
| `space` | 361 MB | 134 migrations, last `0130_db_performance_tuning`; newest event 2026-10-07 06:02:05 UTC, 93 s before the snapshot |
| `temporal` | 25 MB | 95 executions |
| `temporal_visibility` | 17 MB | |

**5. Full logical drill against it** (`scripts/restore-drill.mjs` at
`75ff5fe68f`, the container above as source): dump, restore into a second
throwaway container, verification of all three databases (space 128 tables and
268,572 rows; temporal 39 and 15,316; temporal_visibility 3 and 107; 160
foreign keys without orphans; 0 mismatches), then the store check: the
checkout's 29 pending migrations upgrade the 2026-10-07 data from 134 to 163
history rows (`0159_job_applications`), a second pass applies nothing, the write
probe persists a room and advances the event sequence, 0 issues. Total 25 s;
RTO from target start to a verified, store-opened database 10.3 s. One history
row has no migration file in the checkout.

**6. Cleanup.** The throwaway containers, the local PostgreSQL copy and both
images on the StorageBox were deleted and their absence verified
(`cleanup.json`).

**What it proves and what it does not.** The archive restores to working
filesystems and a PostgreSQL that recovers, verifies and upgrades to HEAD; the
database RPO of that archive is its snapshot time. A full VM boot from the
archive, restarting Space services on it, and the time a `qmrestore` takes are
still unmeasured.

## Open limits

- **RPO.** The weekly VM snapshot alone gave 21 days in practice. Since
  2026-10-11 the daily validated logical dump (see
  [Daily logical backups](#daily-logical-backups-added-2026-10-11)) bounds the
  database RPO to 1 day; first runs `20261011T142920Z` and `20261012T001956Z`.
  - Both the daily dumps and the weekly snapshot source live on public-host, so losing
    public-host's storage still falls back to the last good `vzdump` (7–21 days).
  - Alert (since 2026-10-12): `scripts/vm-backup-watch.mjs` (daily user timer
    `space-vm-backup-watch.timer`) reads the Proxmox backup list and vzdump tasks
    through read-only `pvesh` and adds a Space clipboard note when the newest public-host
    backup is older than 8 days or the last vzdump task failed.
  - Off public-host since 2026-10-16: `space-db-backup-offsite.timer` (root, daily
    04:20 local, `deploy/space-db-backup-offsite.{sh,service,timer}`, script installed
    as `/etc/space-db-backup-offsite.sh`) copies every complete run to the
    StorageBox (`/mnt/hetzner-backup/space-vm207/db`, 35 days) and checks each dump
    against its manifest SHA-256 before the run counts. First run: 6 runs copied;
    second run: 0 copied. Read back from the StorageBox, `space.dump` of
    `20261016T001856Z` lists 1,281 archive entries with `pg_restore --list` in a
    `--network none` container, as its manifest records
    (`reports/20261016-offsite-restore-PiAl`). Still open: WAL archiving with PITR. As of 2026-10-12 the
    host task log shows the weekly job failed for public-host on 2026-09-23
    (`pve_backup_safety_hook.sh job-init`) and 2026-09-30, and succeeded on
    2026-10-07 (with one warning).
- **The real backup was restored once, without a VM boot** (2026-10-12; see
  [VM archive restore drill](#vm-archive-restore-drill-2026-10-12)). The
  archive is complete and verified, both filesystems and PostgreSQL come back,
  and the database upgrades to HEAD. Still unmeasured: booting a full VM from
  it (`qmrestore` needs storage no production guest uses; `local-zfs` is too
  full) and restarting API, worker and Temporal against restored data. The
  operator runbook for a full VM restore is unchanged: (1) attach at least
  500 GB of storage that no production guest uses; (2) `qmrestore` the newest
  `vzdump-qemu-207-*.vma.lzo` to a spare VMID with `--unique 1` and remove its
  network devices before first boot; (3) boot with 8 GB RAM, check `docker ps`,
  `pg_isready` and the row counts used by `scripts/restore-drill.mjs`, timing
  each step; (4) destroy the VMID and detach the storage.
- **The drill restores a fresh dump.** It uses a fresh read-only logical dump of
  live, not an existing backup artifact.
  - It holds `ACCESS SHARE` locks for about 10–20 s. A concurrent deploy
    migration taking `ACCESS EXCLUSIVE` would wait behind them. Run it outside
    deploys that add `ALTER TABLE` migrations.
- **Upgrade CI covers schema only.** Data-bearing upgrades are only exercised
  by the drill's pre-deploy use. Sources older than 0.2.0 are untested.
- **Memory gaps.** Remaining gaps found during review:
  - Embedding rows in `memory_graph_embeddings` for deleted canonical records
    are never deleted; search only filters them out.
  - `POST /api/memory` does not invalidate the all-months archive snapshot.
- **Hazard in older tests.** `createSpacePgPool` rewrites the host to
  `/var/run/space-postgres` whenever that socket is accessible. Older
  Docker-based tests (`dots-postgres`, `room-deletion-postgres`) pass an owned
  socket through it. The new tests and the drill use `pg.Pool` directly.
- **Flaky existing tests.** `apps/api/tests/memory-graph-service.test.ts` times
  out at the default 5 s under the current host load. This is pre-existing and
  not caused by this package.

## Daily logical backups (added 2026-10-11)

The recovery point no longer depends on the weekly VM snapshot alone.

- **What:** `scripts/space-db-backup.mjs` dumps `space`, `temporal` and `temporal_visibility` from `space-postgres-1` with `pg_dump --format=custom` over `docker exec` (read-only). Each dump is validated twice: the table of contents is counted with `pg_restore --list`, and every data block is read and decompressed with `pg_restore --file=/dev/null`. Only then is the archive renamed from `.partial`.
- **Where:** `/opt/spaceapp/backups/db/<UTC run>/{<database>.dump, manifest.json}`, with directory mode 0700 and file mode 0600. The manifest records bytes, SHA-256 and the archive entry count per database.
- **When:** the user-level timer `space-db-backup.timer` runs daily at 03:15 local time (randomized by up to 10 minutes, `Persistent=true`). Installation steps are in `deploy/user-systemd/README.md`.
- **Retention:** the newest run of each of the last 7 days and of each of the last 4 ISO weeks. Only complete runs (all three databases) prune.
- **RPO:** at most 1 day for the database while the timer runs. The weekly VM snapshot still covers files outside PostgreSQL. Since 2026-10-16 the daily dumps are also copied to the StorageBox (see Open limits), so losing public-host's storage no longer loses them.
- **Measured on 2026-10-11:**
  - The three dumps took 9.2 s: space 36.8 MB with 1,017 entries, temporal 2.2 MB, temporal_visibility 47 KB.
  - Restoring them into a disposable PostgreSQL 17/pgvector container (`--network none`) took 10 s.
  - The restore matched live: 158/158 public tables, 155/155 migration rows and identical room counts.
- **Restore:**

  ```sh
  docker exec -i <target> pg_restore -U space -d <database> --clean --if-exists < /opt/spaceapp/backups/db/<run>/<database>.dump
  ```

  Restore into a disposable container first, and verify with `scripts/restore-drill.mjs` before touching live.
