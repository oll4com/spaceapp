---
name: space-app-diagnostics
description: Inspect retained Space APP_DEBUG captures, recorder state, and fixed authenticated diagnostics proofs on public-host. Load for Space capture investigations, not ordinary browser checks.
metadata:
  category: DOMAIN_POLICY
---

# Space App Diagnostics

Use the existing `space_ops` or native `space-readonly` catalog to inspect the
global Space diagnostics capture safely. Keep the MCP catalogs at exactly seven
full tools and three readonly tools.

Native shell agents access the same backend through `space-capability call`
with JSON `{serverId:"space_ops",toolName,arguments}` on stdin; no MCP
registration is required. Other agents use their available MCP transport.
Keep authentication, privacy and fixed proof checks identical on either path.
Use native vision for screenshots when available; Vision MCP is text-only fallback.

## Establish scope

- Target only `public-host:/opt/spaceapp` and `http://127.0.0.1:4911/`.
- Read `/opt/spaceapp/AGENTS.md` before changing code or live state.
- Read [references/mcp-contract.md](references/mcp-contract.md) before querying
  `APP_DEBUG`, handling visual segments, or running the diagnostic proof.
- Treat Debug activation and video recording as admin state changes. Do not
  enable either merely to inspect already retained diagnostics.

## Inspect a capture

1. Call `space_status` first. Record Debug ON/OFF, `captureId`, usage/quota,
   recorder status, live commit, service health, and worktree cleanliness.
2. Call `space_logs` with `source: "APP_DEBUG"`. Start with the shortest useful
   window and add only known filters. Never combine `source` with `service`.
3. Correlate events by `captureId`, `clientId`, `correlationId`, `roomId`,
   `paneId`, event sequence, and timestamps. Prefer `ANOMALY`, `VISUAL`,
   `PERFORMANCE`, `ERROR`, and `NETWORK` filters for flicker investigations.
4. Treat structured output as sanitized technical evidence. Treat every
   `VIDEO` segment as sensitive visible-tab content.
5. State whether evidence is absent, expired, dropped, filtered out, or
   inconclusive. Do not infer user content from missing telemetry.

## Run the fixed proof

- Run `PROVE_APP_DIAGNOSTICS` only when the user explicitly requests a real
  enable/capture/disable proof.
- Use only a persistent `AGENT_PROOF` room and the laptop viewport. Never pass,
  select, clone, resize, attach to, or delete an operator room.
- Preserve the browser host, memory workers, pane host, and every existing CLI
  session.
- Require successful assertions, `bodyHasLogin=false`, `isolation.ok=true`,
  zero fresh console/network failures, at least one valid WebM segment, and
  final cleanup.

## Capture existing workspace room switches

- Run `CAPTURE_WORKSPACE_ROOM_SWITCHES` only when the user explicitly requests
  autonomous Debug/Record diagnosis of their existing rooms.
- This is a narrow full-`space_ops` exception to the normal proof-room
  isolation rule. It is not present in the readonly catalog.
- Use the laptop viewport. Do not pass a room id. The fixed runner enumerates
  only existing `WORKSPACE` rooms, excludes `AGENT_PROOF` and `CLI_RECOVERY`,
  requires at least two rooms, and never creates rooms, panes, or CLI sessions.
- The runner must fail with `DIAGNOSTICS_BUSY` when Debug or the recorder is
  already active. It uses a scoped `APP_DIAGNOSTICS` automation session whose
  non-diagnostic mutations fail closed.
- It records two deterministic adjacent-pair `A → B → A` passes, keeps
  terminal/chat/browser bodies opaque before the first app render, and returns
  only geometry, timing, request, output-counter, WebM metadata, and
  session/PID continuity evidence. Never expose raw terminal text, DOM/body
  text, or a raw video path; require `terminalTextRedacted=true`.
- Under an adaptive controller, cold selection must expose an automatic
  `OPEN_SAFELY` admission decision. When safe capacity is full, the expected
  reverse-LRU hidden runtime is evicted; when no eligible hidden runtime exists,
  the already reserved atomic cold-reveal slot may be used without an eviction.
  There is no dialog or manual `+1` admission.
- Under an adaptive controller, if all eligible workspaces begin warm, the
  runner may create one browser-local cold opportunity by sending a fixed
  numeric-only `PANE_LIMIT` signal through the existing terminal-output-pressure
  path for a real hidden warm Terminal runtime. The runtime eviction and
  following admission must be real, while rooms, panes, sessions, capacity
  rules, server state, and CLI processes remain unchanged. At least one cold
  sample and one automatic `OPEN_SAFELY` decision are mandatory.
- Under the user-approved fixed six-room controller (`memorySource="fixed"`),
  accept the fixed budget directly and never synthesize pressure or evict a
  warm runtime. Measure a cold sample only when an existing workspace starts
  naturally outside the fixed warm set; if all existing workspaces fit within
  six rooms, warm-only adjacent switching is the valid capture.
- Hidden warm layers must report `terminalPrefillReady=true` within two
  seconds. Initial replay may write headlessly only as tagged `PREFILL`;
  later live output remains buffered. Require
  `hiddenMaintenanceWritesAccounted=true` and
  `noUnaccountedHiddenXtermWrites=true`, with hidden writes equal to the sum of
  tagged `PREFILL` and bounded maintenance writes.
- Require warm p95 at most `250 ms`, any observed cold maximum at most `900 ms`,
  and zero blank, double, or stale reveal frames or fresh console/network
  failures.
- Require final Debug OFF, `captureId=null`, recorder `IDLE`, unchanged
  pre-existing CLI session IDs/PIDs, and an unchanged pane-host PID.

## Enforce the privacy boundary

- Never request, store, reconstruct, or report chat, terminal, clipboard,
  typed text, request bodies, cookies, credentials, tokens, passwords, file
  content, or arbitrary console/user text from structured diagnostics.
- Use visual paths only from the full `space_ops` catalog. Native readonly
  agents may receive sanitized events and metadata, never raw segment paths.
- Do not expose, attach, transcribe, or publish a raw video unless the user's
  current task explicitly requires inspection of that visual evidence.

## Finish safely

Call `space_status` again after any proof or state-changing workflow. Do not
finish until Debug is OFF, `captureId` is `null`, recorder status is `IDLE`,
the live worktree is clean, and required services remain healthy.
