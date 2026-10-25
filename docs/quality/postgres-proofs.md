# Isolated PostgreSQL evidence

These checks use PostgreSQL 17 / pgvector 0.8.7 in the pinned image
`pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d`.
The disposable container has no network, no published ports, one CPU, 512 MiB
memory and a 256 MiB tmpfs database. Its only host mount is a task-owned Unix
socket directory. No production database, artifact root or credential is used.

## Existing integration suites

At implementation SHA `929388d598e6e573a8bdda339c4a63a63cd2b34a`, five real database
suites passed: room-pane commands (4), continuation persistence (8), CLI host
output (3), Codex native references (5) and task titles (5). Each used a fresh
database and applied all 127 historical migrations. These are database state
proofs; they do not execute or resume an authenticated upstream CLI.

The socket environment variables and path guards are defined in
`packages/db/tests/*-postgres.integration.test.ts`. Run suites sequentially on a
fresh disposable database, with a short task-owned TMPDIR. Do not set a live
`DATABASE_URL` or `SPACE_DATABASE_URL`.

## Real transport loss during artifact recording

`apps/api/tests/upload-record-postgres.integration.test.ts` is opt-in through
`SPACE_UPLOAD_RECORD_TEST_PG_SOCKET`. It uses the production PostgreSQL pool and
store, with a local Unix socket proxy that parses server protocol frames.

- On `CommandComplete(COMMIT)`, the server has committed, but the proxy destroys
  the connection before forwarding the acknowledgement. Upload recording returns
  `UPLOAD_RECORD_UNCERTAIN`; independent read-only inspection confirms exactly
  one artifact and its event. Complete bytes and the private journal remain.
- On `CommandComplete(INSERT)`, the connection is destroyed inside the open
  transaction. No artifact/event commits; inspection returns
  `AWAITING_CONFIRMATION`, preserving bytes and journal. Absence alone is not a
  recovery decision.

Both cases assert one writer connection and one injected disconnect. Inspection
does not repeat the write or remove evidence. This is real database transport
failure, not a store callback throwing after an in-memory write. It does not
prove arbitrary network faults, host power loss or every application transaction.

```sh
SPACE_UPLOAD_RECORD_TEST_PG_SOCKET=/var/lib/spaceapp-user/agent-workspace/reports/OWNED-TASK/pg-socket \
TMPDIR=/short/owned/tmp \
npm test -w @space/api -- tests/upload-record-postgres.integration.test.ts
```

The fixture installs migrations when needed, creates only synthetic artifact
identities and removes those identities on teardown. An unset socket skips the
suite; a skipped run is not database evidence.

## Restart during execution intent

`packages/db/tests/execution-intent-postgres-restart.test.ts` (added 2026-10-11)
restarts a real server while the production `PostgresSpaceStore` is writing a
Chat submission: the messages, the QUEUED run and the session status, in one
transaction keyed by the client's submission key. It uses the shared helper
`packages/db/tests/support/disposable-postgres.ts`: image
`pgvector/pgvector:0.8.3-pg17-trixie`, `--network none`, a Unix socket in a
task-owned `TMPDIR`, every migration applied. The helper now offers
`restart("graceful")` (`docker restart`, the image's fast shutdown) and
`restart("crash")` (SIGKILL of every server process, then start with WAL
recovery). It skips with a reason when Docker or the image is missing, and the
container and socket directory are removed afterwards.

- **Open transaction.** A trigger holds the transaction at the run INSERT, after
  both messages were written. The test waits until `pg_stat_activity` shows the
  backend waiting, then restarts. The caller receives the connection error:
  57P01 after a graceful restart, "Connection terminated unexpectedly" after a
  crash. Nothing of the intent survives: no messages, no run, session status
  unchanged. The client's retry with the same key creates exactly one run; a
  second retry replays it (`created: false`, same run ID).
- **Unacknowledged COMMIT.** A Unix-socket proxy withholds the server's
  `CommandComplete(COMMIT)` and triggers the restart at that moment. The caller
  sees "Connection terminated unexpectedly", but exactly one run and both
  messages are durable. The keyed retry returns that run instead of writing a
  second one.
- **Stranded-run sweep.** A Chat run left QUEUED, with no workflow, is listed;
  a Room Agent turn waiting in its supervisor queue is not. The same holds for
  stale RUNNING runs. Failing a run is a compare-and-set on its status, so a
  second call, or a call after a worker moved the run on, changes nothing.
- **Pool survival.** The canonical-memory embedding pool serves queries after a
  restart without an unhandled idle-client `error`.

Measured on the shared VM: 6 cases in about 45 s, including four restarts.
Before the fixes in this change, the sweep case failed, and the restart left an
unhandled 57P01 `error` from the embedding pool. A lost connection also
surfaced as the ROLLBACK error ("Client has encountered a connection error and
is not queryable") instead of the original error.

```sh
cd packages/db
TMPDIR=/var/lib/spaceapp-user/agent-workspace/reports/OWNED-TASK/t \
  ../../node_modules/.bin/vitest run tests/execution-intent-postgres-restart.test.ts --hookTimeout=240000
```

Not covered: other store transactions under restart (they share
`withTransaction` but were not restarted one by one), multi-statement work
outside a transaction, host power loss with `fsync=off` (the fixture disables
fsync), and authenticated end-to-end submission through the API.

## Dump/restore

A custom-format `pg_dump` of the final synthetic task-title database was restored
to a separate empty database with `pg_restore --exit-on-error`. The proof checked:

- 125 table identities, 187 rows and SHA-256 hashes of sorted JSONB row bytes;
- column definitions, sequence positions, and normalized constraint definitions;
- all 157 foreign keys validated by PostgreSQL;
- a deliberate changed migration row is detected, then undoing it restores parity.

The initial comparator saw PostgreSQL flatten equivalent CHECK-expression
parentheses during restore. Using PostgreSQL's own pretty constraint output
resolved this representational difference; no data mismatch was ignored.

Measured once: dump 0.336 s, database creation/restore 1.002 s, restore including
verification 17.992 s. No committed fixture rows were lost while the source was
quiescent. These values are not production RTO/RPO guarantees: the fixture is
small, uses tmpfs and has no concurrent writes. Full results, hashes and the
task-owned runner are included in the published evidence pack.

Excluded: artifact/workspace files, credentials, native provider session files,
live processes, external integrations, physical storage durability, concurrent
writes, production scale, and authenticated continuation after restore. A full
application backup/restore and supported-version upgrade matrix remain open.
