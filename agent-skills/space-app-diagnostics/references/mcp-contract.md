# Space App Diagnostics MCP contract

## Catalog boundary

- Full `space_ops`: exactly seven tools. Use `space_status`, `space_logs`, and
  `space_authenticated_ui_proof` for diagnostics; keep test/deploy tools for
  repository work only.
- Native `space-readonly`: exactly `space_status`, `space_logs`, and
  `space_authenticated_ui_proof`.
- Existing MCP sessions do not reload schemas dynamically. Start a fresh
  session to discover a newly deployed schema without terminating old sessions.

## Status

Call:

```json
{"worktree":"/opt/spaceapp"}
```

Read `appDiagnostics` from the structured result, or its equivalent bounded
summary under `/readyz`: `isEnabled`, `captureId`, `usageBytes`, `quotaBytes`,
and `recorderStatus`.

## Retained events

Use `space_logs` with exactly one source mode:

```json
{"source":"APP_DEBUG","minutes":60,"lines":200,"category":"ANOMALY","captureId":"app_debug_capture:example","roomId":"room:example"}
```

- `minutes`: integer `1..1440`; `lines`: integer `1..500`.
- Categories: `LIFECYCLE`, `NAVIGATION`, `SELECTION`, `PERFORMANCE`, `VISUAL`,
  `ANOMALY`, `NETWORK`, `INTERACTION`, `ERROR`.
- Optional filters: `captureId`, `clientId`, `correlationId`, `roomId`,
  `paneId`.
- Valid correlations start with `correlation:`, `req:`, `request:`, or
  `trace:`.
- Use `{service, minutes, lines}` for journal mode. Never send `service` with
  `source: "APP_DEBUG"`.

The result contains bounded `events` and `visualSegments`. Full agents may
receive absolute sanitized snapshot/video paths. Readonly agents receive
metadata only, with no `path` or `relativePath`.

Expired segments are inaccessible. An empty result can mean no capture,
retention expiry, a narrow time range, a filter mismatch, or dropped events.

## Fixed authenticated proof

Use only for an explicitly requested end-to-end proof:

```json
{
  "origin": "http://127.0.0.1:4911",
  "viewport": "laptop",
  "proofRoomId": "room:existing-agent-proof",
  "assertions": [
    {"type": "body_has_text", "value": "App diagnostics"}
  ],
  "interaction": "PROVE_APP_DIAGNOSTICS",
  "timeoutSeconds": 180
}
```

Omit `proofRoomId` to create a new persistent `AGENT_PROOF` room. Never use an
operator room, and never treat the deprecated `roomId` as a route to one. The
fixed interaction may enable Debug, request same-tab capture, record a bounded
WebM segment, stop recording, and disable Debug. Confirm with `space_status`
that Debug is OFF, `captureId` is `null`, and recorder status is `IDLE`.

## Fixed existing-workspace capture

Use only from full `space_ops`, and only after an explicit user request to
diagnose room switching in their already existing workspaces:

```json
{
  "origin": "http://127.0.0.1:4911",
  "viewport": "laptop",
  "assertions": [
    {"type": "body_has_text", "value": "App diagnostics"}
  ],
  "interaction": "CAPTURE_WORKSPACE_ROOM_SWITCHES",
  "timeoutSeconds": 420
}
```

- `timeoutSeconds` defaults to `420` and accepts only `60..480`.
- The interaction is absent from native `space-readonly`.
- Do not pass `roomId`, `proofRoomId`, `paneCount`, or caller-controlled text.
- It enumerates existing rooms and selects only `kind="WORKSPACE"`. It never
  creates, clones, attaches, resizes, or deletes rooms or panes and never
  creates a missing CLI or browser session.
- It fails closed with `DIAGNOSTICS_BUSY` if Debug is ON, `captureId` is
  non-null, or the recorder is not `IDLE`.
- A privacy mask covers every Terminal, Chat, and Browser pane body before the
  first visible app render. The screenshot and same-tab WebM retain only pane
  headers, application chrome, and structural geometry.
- Evidence is limited to room/pane/session identifiers, PIDs, numeric
  timing/request/frame/output counters, and WebM metadata. It must contain
  `bodyText=null`, `domSnapshot=null`, `terminalTextRedacted=true`, and no raw
  video path.
- Under an adaptive controller, cold-room admissions report
  `action=OPEN_SAFELY`, `automatic=true`, the target, the deterministic
  reverse-LRU eviction when one is eligible, reserve use, and a monotonic
  decision sequence. The reserved atomic cold-reveal slot may produce a valid
  admission without an eviction; no dialog or manual `+1` path exists.
- Under an adaptive controller, if every eligible workspace begins warm, the
  runner may create one browser-local cold opportunity through the existing
  terminal-output-pressure path. It sends a fixed numeric-only `PANE_LIMIT`
  signal for a real hidden warm Terminal runtime and requires the runtime to be
  genuinely evicted. This preparation does not mutate rooms, panes, sessions,
  capacity rules, server state, or CLI processes.
- Under the user-approved fixed six-room controller (`memorySource="fixed"`),
  the runner accepts the fixed budget and does not synthesize pressure or evict
  a warm runtime. It measures a cold sample only when an existing workspace is
  naturally outside the fixed warm set.
- Every admitted hidden warm room must report `terminalPrefillReady=true`
  within two seconds. Hidden initial replay writes are tagged `PREFILL`; live
  output received after initial replay status remains buffered under the
  existing pressure limits. Minimized panes and hidden browser tabs do not
  prefill.
- Acceptance requires two deterministic adjacent-pair `A → B → A` passes,
  warm p95 at most `250 ms`, any observed cold maximum at most `900 ms`,
  adaptive-controller cold samples with `OPEN_SAFELY` and `automatic=true`,
  prefill readiness within two seconds,
  `hiddenMaintenanceWritesAccounted=true`,
  `noUnaccountedHiddenXtermWrites=true`, zero blank/double/stale reveal frames,
  no fresh console/network failures, unchanged CLI session/PID identities and
  pane-host PID, and final Debug OFF, `captureId=null`, recorder `IDLE`.

## Interpretation rules

- Use event sequences and timestamps to align technical events with visual
  segments.
- Prefer sanitized structural snapshots before opening video.
- Treat video as potentially containing anything visible in the Space tab.
- Never broaden a technical investigation into user-content inspection.
