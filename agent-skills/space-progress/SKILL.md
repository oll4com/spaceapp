---
name: space-progress
description: "Report this pane's progress to Nous, SpaceApp's mind, so it knows what every pane does without reading screens: at task start, after each finished plan step, when blocked or needing a decision (with the options and your recommendation), when only the operator can act or answer (needs-you brings them to this pane), when you submit a merge-queue ticket, and when done or failed. Use in every Space CLI pane that works on a task or plan; never in a Chat pane or Dot conversation."
metadata:
  category: CORE_POLICY
---

# Space progress reports (to Nous)

Nous coordinates every pane for the operator. Space already records the end of every turn on its own (the turn's last
answer). Your reports add what only you know: where you are in the task and what you need.

## When to report

- `started`: you begin a task or plan (name it; `--plan` and `--step` when there is one).
- `progress`: a plan step is finished (`--step`, `--percent`), or you submitted a merge-queue ticket (`--ticket`).
- `blocked` / `needs-decision`: you cannot go on without someone. Put the options and your recommendation in `--needs`.
- `needs-you`: only the operator themselves can do or answer this (a choice only they can make, a check of your result before you
  go on, something outside the computer). Space brings them to this pane (Needs you, operator request 2026-10-24) and tells
  Nous. Their Needs you card asks ONE question (operator request 2026-10-27): put it in `--needs`, the answers to pick from in
  `--options "A | B | C"` (at most 6) and your pick in `--recommended`. Their answer comes back as your next prompt
  ("Operator's answer to your needs-you (...): ..."). Your next report of any other status ends it. For a decision Nous can
  make, use `needs-decision`.
- `waiting`: you wait for something that will happen on its own (a deploy, a ticket, a date).
- `done` / `failed`: the task ended. One line in the summary; the full report (what changed, tests, ticket, next,
  what is still needed) in `--report-file`.

Do not report every small action: at most a few reports per step (30 an hour per pane).

## How

```bash
node /opt/spaceapp/scripts/space-progress.mjs started "Pane reports slice 2: bridge route and script" --plan clipboard:<id> --step 2
node /opt/spaceapp/scripts/space-progress.mjs progress "Submitted slice 2" --plan clipboard:<id> --step 2 --percent 40 --ticket q-<ticket>
node /opt/spaceapp/scripts/space-progress.mjs needs-decision "Which VPN route for the browser?" --needs "Greece or Thailand; I recommend Greece (lower latency)"
node /opt/spaceapp/scripts/space-progress.mjs needs-you "The invoice is rendered" --needs "Send the invoice to Acme as it is?" --options "Send it | Change it first" --recommended "Send it"
node /opt/spaceapp/scripts/space-progress.mjs done "Slice 2 deployed on dev, tests green" --report-file /var/lib/spaceapp-user/agent-workspace/reports/<task>/report.md
```

The same report is the MCP tool `space_progress_report` on the `space_progress` server (`space_browser` still accepts it)
(`status`, `summary`, `plan`, `step`, `percent`, `ticket`, `next`, `needs`, `options`, `recommended`, `report`).

## Rules

- The summary is one line (at most 300 characters); the report at most 8 KB. Never put a password, token, cookie or
  other secret in a report: reports are stored and shown to Nous (Space redacts what looks like one).
- A report replaces Nous's "tell me what you did" questions: write it so Nous can act on it without reading your screen.
- Plan progress in the operator's clipboard stays recorded as before (`space-admin-action plan-progress`). The plan map (what the operator
  and Nous see as one picture of every plan) goes the same way: `node /opt/spaceapp/scripts/space-admin-action.mjs plan-progress <plan id>
  '{"dependsOn":["clipboard:<other plan>"],"dueAt":"2026-10-30T09:00:00.000Z","waitsOn":{"kind":"THIRD_PARTY","what":"the hosting company's mail server fix"}}'`
  (kinds OPERATOR, DATE, PROMOTE, THIRD_PARTY, NOUS, SERVER; a wait on another plan is `dependsOn`; `null` clears `dueAt`/`waitsOn`).
