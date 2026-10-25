# Upload confirmation and reconciliation

After file/hash validation, artifact uploads persist a private, mode-0600
`.upload-record-<uuid>.json` journal beside the complete file, then call the
artifact store once. The journal and file directory entries are synchronized
before the database call. A successful reply removes the journal. If that reply
is lost, `UPLOAD_RECORD_UNCERTAIN` (HTTP 503) reports the reconciliation ID and
retains both files. This does not prove the transaction failed, and clients must
not automatically retry the upload. Partial-file cleanup still runs for failures
before the store call. No distributed exactly-once guarantee is claimed.

The journal contains the storage URI, expected hash/size, request ID and timestamp,
not attachment text or credentials. Journal files must not enter user exports.
Disk exhaustion may still prevent journaling; in that case the database is never
called and the incomplete operation is cleaned up. Power-loss durability depends
on the underlying filesystem/storage honoring fsync.

## Read-only inspection

Build `@space/api` and its workspace dependencies from the candidate checkout.
Using the service's existing protected database environment, run:

```sh
node scripts/inspect-upload-record.mjs --root /configured/artifacts --record /configured/artifacts/path/.upload-record-UUID.json
```

The script requires `SPACE_DATABASE_URL` without printing it, opens a read-only
connection, uses a parameterized, five-second lookup with at most two rows, and
reads file bytes through bounded, no-follow descriptors. It never modifies the
database, resubmits an upload or deletes a file. Exit 0 means `CONFIRMED`, 2 means
operator intervention, and 1 means inspection itself could not finish.

| Result | Interpretation and operator action |
| --- | --- |
| `CONFIRMED` | Exactly one active row matches the URI/hash/size and the retained file verifies. Use that artifact ID; the private journal may be removed after review. |
| `AWAITING_CONFIRMATION` | No active row was observed. The original transaction may still be settling. Preserve both files, establish that it has ended, and inspect again before deciding recovery. |
| `CONFLICT` | Duplicate rows or metadata mismatch. Preserve evidence and investigate; do not choose a row automatically. |
| `FILE_DAMAGED_OR_MISSING` | Expected bytes are unavailable. Restore from the source or a verified backup after reviewing the row. |

Lost-acknowledgement tests cover generic and Agent Files routes: the simulated
store commits and then throws; the file remains downloadable, the callback runs
once, and read-only reconciliation returns the existing artifact. Additional
tests cover absent rows, corruption, conflicting rows and malicious journal paths.
These deterministic tests do not replace the real PostgreSQL restart/restore
matrix. JSON Control media/files publishing has separate containment and lost-ACK
regressions, and uses the same admission and persistence boundary.

A separate opt-in PostgreSQL test now drops the actual server acknowledgement
after COMMIT, and inside the transaction after INSERT. It verifies exactly one
committed artifact/event in the first case, no committed rows in the second,
one writer connection, retained bytes/journal and read-only reconciliation.
See [postgres-proofs.md](postgres-proofs.md); arbitrary restart and application
restore acceptance remain separate.

## File manager uploads (`POST /api/files/upload`)

The Files pane upload is not an artifact upload and has no journal. Every file
of a request is first staged to a hidden temporary file; a parse, size or
validation failure publishes nothing. The staged files are then published one
by one with `rename`. Since review 2026-10-14 (ChatGPT finding 3), a failure
after the first file stops there and answers 500 `UPLOAD_PARTIALLY_SAVED`,
naming the files that were saved and the file that was not; the Files pane
refreshes its listing so the saved files are visible. Saved files are not
rolled back: a rename may have replaced an existing file, which cannot be
restored atomically. Every Admin Mode upload, write, create, rename, chmod and
delete is recorded in the audit log (`files.<action>`).
Test: `apps/api/tests/files-upload-http.test.ts`.
