# Temporal history fixtures

`npm test -w @space/worker` runs `tests/temporal-workflows.test.ts`, including
real time-skipping executions and replay of every JSON file in this directory.
The existing `test:public` / public CI workspace suite includes this test. No
database, Docker daemon, credentials or model provider is used. The SDK downloads
its ephemeral test-server binary on first use; subsequent runs use its cache.

The eight production workflows are bundled from `tests/temporal/workflows.ts`,
which only re-exports their source implementations. Activities are synthetic
stubs. Supervisor regression tests also reuse the existing in-memory continuation
fixture to assert the same store effects as the mocked tests.

## Recording

After installing dependencies and building the workspace packages (as in
`CONTRIBUTING.md`), run:

```sh
npm run temporal:record-histories -w @space/worker
npm test -w @space/worker -- tests/temporal-workflows.test.ts
```

The first command explicitly enables writing histories and skips replay while
recording. The second command performs the replay gate without modifying files.
Do not run the recording command in CI.

**After the initial fixtures are committed, re-recording is allowed only together
with a reviewed `patched()` workflow change. Never overwrite a fixture merely to
make a failing replay pass.** Keep old histories so both sides of the patch remain
covered; add a new named fixture/scenario for the new behavior. Review every
fixture diff and explain the patch and recording in the PR.

`supervisor-legacy-*` files come from the real legacy supervisor implementation.
A test-only webpack preloader removes exactly the branch selection introduced by
`room-background-continuation-v1`; it neither mocks Temporal APIs nor changes the
legacy body. These executions contain no marker for that patch and are replayed
using the **unmodified current production bundle**. The loader fails if its source
anchor changes, requiring explicit review of the historical fixture.

JSON is the generated protobuf `History.toObject` format (string enums, base64
payload bytes and string int64 values), read with `History.fromObject` before
replay. This avoids the SDK 1.24.0 protojson helper's dependence on a shared
protobufjs `Type` constructor when multiple protobufjs versions are installed.
Only worker identity and failure stack-trace fields are redacted; workflow inputs,
payloads, commands and patch markers are retained. All inputs are synthetic.

Long-lived supervisors are terminated after their assertions. Continued histories
are fetched by the original run ID so they include the actual continue-as-new
command and its carried state. History file names appear in replay assertion
failures. The test-only `incompatible-workflows.ts` adds a timer to the dummy turn;
the negative control must report `DeterminismViolationError`, proving that replay
is executing and detects incompatible command sequences.
