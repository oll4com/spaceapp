# Workflow histories

`npm run temporal:record-histories -w @space/worker` writes one JSON history per workflow into this directory, plus `supervisor-pre-patch-polls.json` for the legacy monitoring loop. The histories are synthetic: fake room ids, no prompts from a real user, no model output.

`npm test -w @space/worker` replays every history here with `Worker.runReplayHistories` against the current workflow code. A failing replay names the history file and the workflow id.

Both commands bundle the workflows with webpack, which loads the workspace packages from their `dist/` output. Run `npm run build` at the repository root first. The root `npm test` (`test:public`) builds them before it runs every workspace's tests.

Re-record only together with a `patched()` change. Do not re-record to make a failing replay pass. A history that was recorded before a patch stays the proof that the old branch still replays.
