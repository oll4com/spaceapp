---
name: space-cli-render-diagnostics
description: Inspect numeric browser terminal geometry and run fixed authenticated CLI render proofs with owned synthetic PTY fixtures, bounded resize and long-stream checks. Use for suspected clipped terminal grids, rendering faults, or explicit CLI render stress tests in Space.
---

# CLI Terminal Render Diagnostics

Use native tools first; protected Space access uses existing capability/MCP authentication and approval gates. This skill is a workflow, not an additional MCP tool. Full `space_ops` retains seven tools; readonly retains three.

## Start with the actual capability

Run `node /opt/spaceapp/scripts/space-cli-render-audit.mjs --capabilities`. An explicit mode is mandatory. Unknown flags exit 2 without authentication, fixtures or stress. Operational failures exit nonzero.

Read [the contract](references/contract.md) for evidence limitations and acceptance criteria. Before diagnostic state access, load `space-app-diagnostics` and call `space_status`. Do not take over another capture. Debug ON does not authorize recording.

## Inspect without changing the workspace

Use `space_inspect` with `section: "TERMINAL_RENDER"`, roomId and optional paneId. It returns actor/client-scoped observations with source, age and FRESH/STALE/UNAVAILABLE. Multiple clients remain separate. It does not activate a room or attach a terminal.

For a fresh one-shot read through the focused authenticated client:

```json
{"roomId":"room:example","requestId":"render:unique","waitForCompletion":true,"actions":[{"kind":"pane","operation":"visual_audit","target":{"paneIds":["pane:example"]},"captureScreenshot":false}]}
```

Use exactly one explicit terminal pane and one action. No mutation/watchdog path is entered. A disconnected client returns UNKNOWN/UNAVAILABLE, never a completed queued audit. No script, shell, selector, URL or path is accepted. `captureScreenshot:true` reports CAPTURE_UNAVAILABLE unless a matching protected source exists; it does not fabricate a screenshot or bypass capture consent.

The observer reports **geometry only**, not guaranteed glyph/stream correctness. Session identity and transport/parser/render progress that are not exposed by the browser remain null with reason codes. Canvas alone is UNKNOWN because guessing WebGL or opening a context would alter the surface. DOM is currently the measurable renderer.

## Fixed browser proofs (only when requested)

Run one profile at a time via the full `space_authenticated_ui_proof` interaction `PROVE_CLI_RENDER`, desktop, paneCount 1, timeoutSeconds 180, and renderProfile DIMENSIONS, RESIZE, STREAM, FULL or AI. The helper maps these flags to the protected entrypoint:

```bash
node /opt/spaceapp/scripts/space-cli-render-audit.mjs --test-dimensions
node /opt/spaceapp/scripts/space-cli-render-audit.mjs --test-resize-stress
node /opt/spaceapp/scripts/space-cli-render-audit.mjs --test-50k-stress
node /opt/spaceapp/scripts/space-cli-render-audit.mjs --full
# Codex + Gemini + OpenCode in one owned proof room:
node /opt/spaceapp/scripts/space-cli-render-audit.mjs --full --runtime all
# Separate real AI run, never included implicitly in --full:
node /opt/spaceapp/scripts/space-cli-render-audit.mjs --test-ai
```

Synthetic profiles accept only `--runtime codex|gemini|opencode|all`; the default is Codex. `all` creates one owned AGENT_PROOF room with exactly three fixed panes/sessions in Codex, Gemini and OpenCode order. The AI profile remains Codex-only.

The runner creates one owned AGENT_PROOF room, real pane/session per selected runtime and fixed synthetic PTY process. It waits for browser attachment before emitting the stream. UI geometry changes must propagate through the normal app fit/resize path to backend PTY geometry. Unsupported requested dimensions are reported with actual measurements; 20×8 is a target, not a product minimum.

Synthetic output includes 6,000 logical lines, Unicode, literal ANSI examples, split boundaries, alternate screen and an idle interval. Counted tokens use **space-fixture-unicode-lexical-v1**, not an AI provider tokenizer or bytes/4 estimate. Sequence, full payload digest and final DOM state are checked separately. Limits: 180 seconds, 16 MiB, six screenshots. Missing/corrupt/duplicate/out-of-order markers fail. Reaching a deadline before evidence is complete means INCOMPLETE.

Review synthetic screenshots with native vision. Never invoke Space vision MCP automatically. An automated geometry/marker PASS is not a native visual review. AI provider output >50k is a separate acceptance item; synthetic tokens never prove it.

The AI profile uses the configured Codex model and native quota, a synthetic repository without operator data, and one fixed no-tools prompt. Its conservative bounds are one turn and 150 seconds (within the design ceilings of four turns/15 minutes). It verifies submission, native task identity, native completion and the response marker. It does not change model or account settings. Current native observation does not expose trustworthy output usage, so token fields stay null and the >50k acceptance remains INCOMPLETE. Never retry automatically to chase token counts. The synthetic directory is task isolation, not an OS security sandbox.

## Runtime overhead and safety

- Before a live proof, confirm `/readyz` reports `cliHost: RUNNING`, no deployment or service restart is in progress, and no other render proof is active. If attachment is incomplete or fixture cleanup reports FAILED, **do not retry the live proof**. Reconcile the journaled room/session IDs, confirm the owned room is deleted and no fixture session remains hosted, then diagnose from existing evidence. A healthy host after recovery is not proof that repeating the stress test is safe.
- The initial browser attach phase has a 15-second ceiling and stops immediately if a pane reports `closed`; no synthetic stream may start before every selected pane has measurable geometry. If the pane host becomes unavailable or saturates a CPU, stop new proofs and preserve operator sessions while investigating. Never repeat a full/50k stress profile to chase a passing result.
- Debug OFF adds no periodic sampler, timer, observer, scan or capture. Explicit one-shot reads remain available.
- Debug ON uses the existing diagnostics RAF and batching: at most one sample/pane/second and four samples/tab/second; targets 2 ms/sample and 10 ms/second. Budget pressure backs off only this sampler.
- Numeric ring is bounded to 256 records; persistent anomaly deduplication is 10 seconds.
- The observer never calls fit, refresh, flush, reconnect, repair, truncate or warm eviction. Existing recovery remains unchanged.
- Hidden/minimized surfaces are NOT_APPLICABLE. Idle, literal ANSI, dark backgrounds, blank prompts and scrollback rollover alone are not FAULT.
- Preserve six warm rooms, 96-pane settings, disabled parking, existing xterms/sockets, PREFILL ordering, navigation, Harness, widgets and session/PIDs. The strict performance baseline is not permission to change them.

## Finish

Reuse owned fixtures and verify cleanup on success/failure/interrupt. The ownership journal supports reconciliation after hard failure; never delete a room by name alone. Leave operator rooms and unrelated captures untouched. If the proof owns Debug/Record, restore Debug OFF, captureId null and recorder IDLE, then verify with `space_status`.

Publish user-facing reports/screenshots to Space Agent Files and verify artifact IDs. Report PASS/FAIL/INCOMPLETE/UNSUPPORTED separately, plus unrun warm-room A/B and real AI gates. Do not declare production completion before joint live verification and the protected rollout gates pass.
