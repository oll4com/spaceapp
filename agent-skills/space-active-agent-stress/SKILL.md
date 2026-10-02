---
name: space-active-agent-stress
description: Run and interpret the fixed authenticated Space active-agent warm-room stress benchmark on public-host. Use for BENCHMARK_ACTIVE_AGENT_ROOMS, 21-agent room-switch load, hard-reload warm hydration, hidden terminal-output gating, or mini/low model fail-closed proof.
metadata:
  category: WORKFLOW_OPT_IN
---

# Space Active-Agent Stress

Use the fixed full `space_ops` proof. Never reproduce this workflow with an
operator room, arbitrary prompts, custom browser scripts, or a readonly agent.
Read [references/contract.md](references/contract.md) before running it.

Run only when this benchmark is requested. Native shell agents invoke the same
backend through `space-capability call`, passing `serverId: "space_ops"`, the
tool name and unchanged arguments on stdin. MCP registration is optional;
the fixed authenticated proof and its safety checks remain required.

## Establish scope

1. Target only `public-host:/opt/spaceapp` and `http://127.0.0.1:4911/`.
2. Call `space_status` first. Require a clean live tree, healthy services,
   Debug OFF, `captureId=null`, and recorder `IDLE`.
3. Record every pre-existing CLI session ID/PID and the
   `codex-pane-host.service` PID. Do not restart the pane host.
4. Use a persistent `AGENT_PROOF` room or allow the proof to create one. Never
   pass, select, clone, resize, attach to, or delete an operator room.

## Run the fixed interaction

Call `space_authenticated_ui_proof` from the full catalog:

```json
{
  "origin": "http://127.0.0.1:4911",
  "viewport": "laptop",
  "proofRoomId": "room:existing-agent-proof",
  "assertions": [
    {
      "type": "body_lacks_text",
      "value": "Sign in"
    }
  ],
  "interaction": "BENCHMARK_ACTIVE_AGENT_ROOMS",
  "timeoutSeconds": 420
}
```

Omit `proofRoomId` to create the persistent main proof room. Do not add prompt,
workspace, video, JavaScript, selector, cycle, model, reasoning, or output
fields. The interaction owns the harmless story turns and requires advertised
`gpt-5.4-mini` with reasoning effort `low`.

## Accept evidence

Require:

- six auxiliary rooms, 21 unique running session IDs/PIDs, and four accepted
  cycles;
- warm p95 at most 250 ms, cold restore at most 900 ms, and both recent rooms
  warm within two seconds after the active-terminal barrier;
- controller-owned capacity evidence proving `warmCount <= safeCapacity + 1`
  on every measured transition, with `data-warm-room-safe-capacity`,
  `data-warm-room-hard-capacity`, and `data-warm-room-connected-panes` read
  from the shell;
- deterministic eviction evidence derived from
  `data-warm-room-admission-state` and `data-warm-room-recency-rank`, with
  fixed `Open safely` admission whenever a cold room reaches safe capacity;
- zero post-reload session requests on the first switches to both recent rooms;
- zero unaccounted hidden xterm writes; bounded pressure-triggered maintenance
  writes may update an already-mounted terminal without fit, resize, or full
  refresh; also require zero invalid resize frames, collapsed terminals,
  console errors, failed requests, or bad responses;
- zero blank frames, double-opaque frames, target-visible-before-ready frames,
  or stale swaps during every measured room transition;
- numeric/ID-only output and geometry evidence, with terminal text redacted in
  the screenshot and absent from the JSON DOM/body fields;
- the main `AGENT_PROOF` room and redacted artifacts preserved, with only the
  six auxiliary rooms deleted.

Compare all pre-existing session IDs/PIDs and the pane-host PID after the proof.
Finish only when the live tree is clean, Debug OFF, `captureId=null`, recorder
`IDLE`, and no auxiliary stress room remains.
