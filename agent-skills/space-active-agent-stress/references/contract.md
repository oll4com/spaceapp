# Fixed active-agent stress contract

## Tool boundary

`BENCHMARK_ACTIVE_AGENT_ROOMS` is available only through
`space_authenticated_ui_proof` in the full `space_ops` catalog. Full remains
exactly seven tools; readonly remains exactly three and does not advertise or
accept this interaction.

The request uses the normal proof fields only. `timeoutSeconds` defaults to
420 and accepts 360 through 480 for this interaction. Standard proof
interactions retain their existing 5 through 180 second limits. Do not add a
prompt, workspace, model, reasoning, cycle, browser script, output path, or
video field.

## Fixed workload

The runner:

1. requires live `model/list` evidence for `gpt-5.4-mini` with reasoning effort `low`;
2. creates six auxiliary `AGENT_PROOF` rooms with 1, 2, 3, 4, 5, and 6 Codex
   panes, accepting the fixed initial turn for each room before starting the
   next room so the 21 unique sessions/PIDs warm without a startup burst;
3. sends four repo-owned harmless story cycles across 180 seconds through the
   strict idempotent internal turns endpoint;
   the initial cycle alone may retry startup HTTP 409 responses for at most
   90 seconds with the same idempotency keys, while later cycles fail closed;
4. performs deterministic warm switches, uses the fixed `Open safely` action
   when a cold room reaches safe capacity, proves least-recent cold eviction,
   restores the cold room, runs `Page.reload` with cache ignored, verifies
   post-reload switches, and performs a real background/resume transition;
5. deletes only the six auxiliary rooms and preserves the persistent main proof
   room.

The interaction never returns or stores terminal text. Its JSON contains only
bounded identifiers, PIDs, durations, dimensions, and byte/event counters. The
screenshot must cover every visible terminal with a `Terminal text redacted`
veil. `domSnapshot` and `bodyText` are `null`.

## Acceptance

- Warm p95: at most 250 ms.
- Cold restore: at most 900 ms.
- Capacity: every measured transition satisfies
  `warmCount <= safeCapacity + 1` and the reported hard-capacity bounds.
- Controller proof: read `data-warm-room-safe-capacity`,
  `data-warm-room-hard-capacity`, `data-warm-room-connected-panes`,
  `data-warm-room-memory-source`, `data-warm-room-admission-state`, and
  `data-warm-room-recency-rank`; do not reproduce browser capacity policy in
  the runner.
- Eviction: deterministic eviction removes the hidden warm runtime with the
  oldest controller recency rank while preserving the active room.
- Both persisted recent rooms: warm within 2 seconds after the active-terminal
  barrier.
- First post-reload switch to each recent room: zero session requests.
- Hidden xterm writes: every hidden byte/event must be accounted for as a
  bounded pressure-triggered maintenance write into an already-mounted
  terminal; maintenance must not fit, resize, or force a full refresh.
- Geometry: positive dimensions, no collapsed terminal, and zero invalid
  resize frames.
- Atomic presentation: positive sampled-frame count and zero
  `blankFrameCount`, `doubleOpaqueFrameCount`, `targetVisibleBeforeReady`, or
  `staleSwapCount`.
- Output: positive numeric xterm write counters for all 21 panes.
- Continuity: all 21 stress session IDs remain stable; every pre-existing
  session ID/PID and the pane-host PID remain unchanged.
- Browser: no console errors, failed requests, or bad responses.
- Cleanup: all six auxiliary rooms deleted; main proof room retained; Debug OFF,
  `captureId=null`, and recorder `IDLE`.
