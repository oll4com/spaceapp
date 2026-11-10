# Nous

Nous (Greek νους, "mind") is SpaceApp's own agent. It sees every room, pane,
copilot, plan and goal in your space and reads each pane's progress reports
instead of its screen, so it knows what every agent works on and what it waits
for. You talk to Nous in its dock instead of to every agent: it does the
routine work itself and brings you only the decisions that need you.

This page is for developers who run SpaceApp themselves: what Nous does, how
goals work, what it may do alone, which tools it has and how to switch it on
in a self-hosted install. Nous is **off** on a new install.

## What Nous does

- **Routine work.** It opens, steers, restarts and closes panes, sends them
  their next step, answers a CLI that waits at a prompt, runs helpers beside
  its own turn and saves finished work to Space Memory.
- **Goals.** A goal is your standing objective in your own words (see below).
- **Needs you.** When an agent needs your hands or an answer, you get one
  request with a question and options, in the Nous dock and as a notification.
  Requests wait for the morning during your quiet hours.
- **Plan map.** Every open plan, what it waits on, its dates, and what to
  unblock first.
- **Done and Requests.** Every message you send Nous is listed with its state;
  finished work lands in the Done tab with a short summary.

## Goals

Type `/goal <what you want>` in the Nous composer (or `/goals` to open the
list). Space records the goal from your exact words and starts a goal turn at
once. Nous breaks the goal into success criteria, plans, panes and helpers,
and keeps working on it in turns of its own until it is achieved with
evidence. The Goals tab shows each goal's status, progress, criteria, plans,
what it waits on, the next turn and what it cost.

- Only you create, edit, pause, reorder, drop or delete a goal; Nous only
  records progress, notes and evidence.
- The next goal turn starts a set gap after the previous one; a goal that did
  not change for two turns, or that waits on you or on a third party, backs
  off (30 minutes, doubling up to 2 hours) until something changes.
- Goals never widen what Nous may do alone: every rule below still applies.

All of this is under **Settings → Assistants & AI → Nous → Goals**.

## What Nous leaves to you

Nous asks you first, with a decision card (Approve or Decline; a plain yes or
no in words decides it too), before anything in these four kinds:

| Kind | Examples |
|---|---|
| **Releases** | publishing a version, pushing or tagging a release, promoting work |
| **Deletes** | deleting files, data, rooms or branches, anything irreversible |
| **Third parties and money** | an email, post, proposal or message that leaves SpaceApp, a payment, anything that costs money |
| **Direction** | choosing between two solutions, changing a plan's scope |

A decision card carries the exact action SpaceApp runs on your yes; nothing
runs before it. **Always approve** on a card lets that kind of decision run on
its own next time. It is never offered for releases or deletes, and you remove
a kind again under **Ask me again** in the settings.

A sign-in, a code or a CAPTCHA is not a decision: it reaches you as a Needs
you request on the pane that needs your hands.

## Allowances

Allowances let Nous do more alone. Every one is **off** by default, and only
you can turn one on, in **Settings → Assistants & AI → Nous** (an agent or an
automation session cannot).

| Allowance | What it lets Nous do |
|---|---|
| **May send to third parties** | A send Nous asks for (a pane's message, or approving a Mail, Freelance, Job or Marketing review) goes out without a card, as long as the files it names did not change since it asked. |
| **May delete what Nous created** | Agent Files and media that Nous itself added are deleted when it asks, after a copy is kept in its own folder. Your files and every other record stay yours. |
| **Shell** | Nous runs commands itself as your CLI user, like a pane, without sudo. Off: it asks a pane to run them. |
| **Copilot questions go to Nous first** | A copilot's question waits up to an hour for Nous, which answers what it can find itself; the rest comes to you. On by default. |
| **Talk to Nous from Telegram** | Your paired Telegram chat reaches Nous like the dock, with Approve and Decline buttons on its decisions. |

The other allowances in that list (promote, Warm changes, security hotfixes,
publish after a lab proof, guarded host restarts) act on SpaceApp's own
development workflow: its source repository, merge queue, release trains and
hosts. A self-hosted install does not run that workflow, so they have nothing
to act on there.

**Away mode.** Tell Nous you are away (or use its switch in the settings):
until you write again, it keeps working, holds its non-urgent alerts for one
summary when you return and still sends urgent ones at once. Away adds no
permission: publishing, payments, deletes and third-party sends stay as above.

## Tools

Nous works only through its own tools, served over MCP to each turn with a
token that lives as long as that turn. It does not edit your code or drive a
browser itself: that work goes to a pane.

| Area | Tools (examples) |
|---|---|
| The whole space | `space_world` (rooms, panes, plans, goals, decisions, holds), `space_room_status`, `space_pane_reports`, `space_pane_board` |
| Panes | `space_open_panes`, `space_send_to_pane`, `space_answer_pane`, `space_read_pane`, `space_look`, `space_stop_pane`, `space_restart_pane`, `space_close_pane`, `space_set_pane_model` |
| Plans, goals, tasks | `space_plans`, `space_plan_create`, `space_plan_update`, `space_goals`, `space_goal_update`, `space_tasks`, `space_task_add` |
| You | `space_ask_operator` (decision cards), `space_notify_operator` and `space_focus_pane` (Needs you), `space_reply_now`, `space_request_done` |
| Helpers | `space_subagents`: independent tasks at once, each a helper turn with most of Nous's tools (one at a time on a self-hosted install) |
| Memory and notes | `space_memory_recall`, `space_memory_save`, `space_notes`, `space_clipboard` |
| Copilots and studios | `space_copilot_items`, `space_copilot_brief`, `space_copilot_answer`, `space_design_request`, `space_video_request` (when those modules are on) |
| Reading | `space_files_read`, `space_web_read`, `space_web_search`, `space_db_query` (read only), `space_mail_search`, `space_mail_read` (read only) |
| Research Council | `space_council_start`, `space_council_run`, `space_council_answer`: several models answer one question independently and agree on a Top 3 |

Every call is a row in the Nous conversation, and refusals say why and what to
call instead. Space Control (`space_inspect`, `space_execute`) gives Nous the
same room and pane operations as you; the risky ones run only as a decision on
your yes.

A self-hosted install offers fewer tools: see
[Limits on a self-hosted install](#limits-on-a-self-hosted-install).

## Nous on a self-hosted install

Nous needs `run-spaceapp` **1.2.0** or later: its turns run in the
`spaceapp-cli` container, whose credential agent learned them in that version.
On an older install the dock says "update SpaceApp".

1. Install or update SpaceApp:

   ```bash
   npx --yes run-spaceapp@latest install   # or: update
   ```

2. Connect Claude Code under the CLI providers: sign in with your Claude
   subscription, or store an Anthropic API key with
   `npx --yes run-spaceapp@latest credentials set claude`.
3. Open the Nous dock and switch on **Work on my behalf**. It turns on only
   once Claude Code is signed in; until then the dock says what is missing.

Stop ends the current turn at once, and switching **Work on my behalf** off
stops all of its work.

### Which Claude login it uses

Each Nous turn is a headless Claude Code run in the `spaceapp-cli` container,
on **your own Claude Code login** (your subscription sign-in or your API key),
with only Nous's tools, plus Bash when Shell is on. It runs in every profile,
`small` included, and needs no extra service. A self-hosted install has no
Space Gateway, so the turns go from your CLI container straight to Anthropic;
none of it passes through SpaceApp's servers. Claude Code itself also calls
Datadog's log intake (`http-intake.logs.us5.datadoghq.com`) and
`raw.githubusercontent.com`; its opt-out,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, is not set by SpaceApp 1.2.0, and
a setting for it is planned.

### Lean defaults

Its turns count against your Claude plan like any Claude Code session, so a
self-hosted install starts lean:

- Claude Sonnet 5.5 for every turn (medium effort when you write to it, low
  for its own background turns);
- background turns follow new events with no hourly cap; Low-spend mode
  **Always on** keeps them to at most 6 an hour;
- an active goal gets at most one turn every 15 minutes;
- one helper at a time; no shell, no finished-pane sweeps, no daily review and
  no pane board summaries (a stalled plan still gets one reminder per stalled
  window).

Each of these is a setting, and a value you save always wins. A self-hosted
install cannot read your Claude quota, so Low-spend mode stays at normal on
**Auto**; **Always on** holds Nous to its low-spend limits all the time.

### Limits on a self-hosted install

A self-hosted install does not run Space Gateway, the Research Council, the
Vault broker or SpaceApp's own development workflow, so Nous is offered none
of the tools that need them:

| Not offered | Why |
|---|---|
| `space_web_search`, `space_ops_gateway` | No Space Gateway. `space_web_read` still reads a public page. |
| `space_council_*` | The Research Council's members run through Space Gateway. |
| `space_vault_fill`, `space_vault_list`, `space_vault_save` | No Vault broker. |
| `space_git`, `space_queue_status`, `space_release` | No source repository, merge queue or release trains of SpaceApp itself. Your own repositories are a pane's work. |
| `space_browser_set_route`, `space_cli_update` | No network routes; CLI versions come with `run-spaceapp update`. |

Also:

- Nous runs only on Claude Code. Without a Claude Code login it stays off.
- Its turns use your Claude plan or API key, and SpaceApp cannot read that
  quota, so it cannot slow down by itself before the quota runs out. Use
  **Always on** in Low-spend mode, or switch Nous off, when your plan is low.
- One helper at a time.
- On an install without user accounts, its file tools read the panes'
  workspace volume, and the files it writes are in its `nous` folder there.

## A goal from start to finish

An example on a self-hosted install. You have a Node project in your
workspace, `shop-api`, whose tests fail since you moved it to Node 26.

1. **Switch Nous on.** Connect Claude Code, then switch on **Work on my
   behalf** in the Nous dock.
2. **Give it the goal.** In the Nous composer type:

   ```text
   /goal Make the shop-api test suite pass on Node 26, then push the fix to a new branch
   ```

   Space answers "Goal recorded" at once (no model turn for that) and starts
   a goal turn.
3. **Nous plans it.** In that turn it writes success criteria (for example:
   `npm test` passes on Node 26, no test skipped, the branch is pushed),
   creates a plan with steps, opens a Claude Code pane on `shop-api` and sends
   it the first step. The Goals tab shows the criteria, the plan and what the
   goal waits on.
4. **The pane works; Nous follows.** Nous follows the pane through its
   progress reports, not its screen. It answers the questions it can answer
   itself, sends the next step when one is done, and brings a choice between
   two real fixes to you as a decision card. While nothing changes, the goal
   backs off instead of spending turns.
5. **You approve the push.** Pushing leaves your machine, so before it Nous
   asks you on a decision card with the exact text it will send the pane. You
   press **Approve**, or answer "yes" in the chat.
6. **Done with evidence.** The pane pushes and reports the test output and
   the branch. Nous checks them against the criteria, records the goal as
   achieved with that evidence. The Goals tab
   shows the goal's work history and what it cost.

At any point you can edit, pause, reorder or drop the goal in the Goals tab,
press Stop to end the current turn, or switch **Work on my behalf** off.

## How a turn works

For contributors, the pieces are:

- **Turns.** Your message, a decision answer, a batch of inbox events (pane
  reports, monitor events, notifications), a goal or a standing check each
  start a turn. Your own turn never waits behind a background or goal turn.
- **The world.** Each turn starts from a text snapshot of your space (rooms,
  panes with their last reports, plans, goals, open decisions, Needs you
  requests, your clock and quiet hours) and reads more with its tools.
- **The run.** The API starts headless Claude Code with
  `--output-format stream-json`, no built-in tools (Bash only with Shell on)
  and one MCP server, `/api/cli/nous/mcp`, authenticated with that turn's
  token. The draft streams into the dock while it writes.
- **The gates.** The server, not the model, decides what needs you: a decision
  is stored with its exact action and runs only on your yes or under an
  allowance you turned on.
- **The code.** `apps/api/src/nous/` (service, tools, goals, world, gates),
  `packages/contracts/src/nous*.ts` (settings, goals, the turn stream) and
  `apps/web/src/features/nous/` (the dock).

## See also

- [Getting started → Nous (optional)](getting-started.md#nous-optional)
- [CLI providers](cli-providers.md) for connecting Claude Code
- [Security model](security-model.md)
