# Workflow replay fixtures

These JSON files are synthetic histories recorded from the real production
workflows on Temporal's time-skipping test server. Activity implementations are
local stubs. No database, Docker, provider account or application credentials are
used. The SDK downloads its test-server executable on first use and caches it;
subsequent runs need no external service.

`npm test -w @space/worker` runs the sandbox and replay tests. The existing
`npm run test:public` and public CI include these tests through the worker
workspace. The replay test reads every committed JSON file and never records or
updates histories. Its negative test registers a test-only Dot workflow with an
extra unpatched timer and requires `DeterminismViolationError`, including the
workflow name and filename in the diagnostic.

The legacy supervisor fixture has no `room-background-continuation-v1` marker.
Recording selects that branch with the SDK 1.24.0 worker's
`patchActivationCallback`; replay supplies no callback and must select the old
branch from the history itself. Production workflow code is unchanged.

## Recording policy

Run the recorder from a checkout whose internal packages have been built (the
normal `npm run check` does this):

```
npm run temporal:record-histories -w @space/worker
```

This command creates the initial nine fixtures and refuses to overwrite existing
files. Re-recording is allowed only together with an intentional `patched()`
workflow change, never to make a failing replay pass. Keep all earlier fixtures
so running executions remain protected. To add histories for a reviewed patch:

```
npm run temporal:record-histories -w @space/worker -- --patch your-patch-id
```

That adds nine files with a patch suffix; it still refuses to overwrite. Review
the history changes, confirm the intended marker and command ordering, and run
the entire worker suite before committing. Do not replace the old JSON files or
use production histories containing user data.
