import type { NousTurnFacts } from "@space/contracts";
import { SPACE_DATABASE_DOWN } from "../room-agent-tools.js";

type NousToolCounts = NousTurnFacts["tools"][string];
/** A tool's error texts in one turn; rows before 8/11 kept only the first, as `error`. */
export const toolErrorSamples = (tool: NousToolCounts): string[] => tool.errors ?? (tool.error ? [tool.error] : []);

/**
 * Historical facts keep the refusal flags from when they ran. Recognize the caller/state answers tools.ts now holds, using only the
 * recorded cause (often 200 characters). Never infer an unseen failure from another call's sample or a cut-off batch's first line.
 */
/** planDependencyProblem's answers (@space/contracts plan-map.ts): the dependencies a plan update names are not open, itself or a loop. */
export const PLAN_MAP_ANSWER = /^Plan \S+ is not an open plan\.$|^A plan cannot depend on itself\.$|^The dependency would loop: /;

export function historicalToolHold(name: string, error: string): boolean {
  if (/^Invalid arguments:|^No (?:open pane|room) named "/.test(error)) return true;
  if (SPACE_DATABASE_DOWN.test(error) && !/statement timeout|\b57014\b/i.test(error)) return true;
  // tools.ts's catch holds these for every tool (PANE_READY_GATE, NAMES_NEXT_CALL).
  if (/question changed since it was inspected|has not opened its input yet|is not waiting for an answer \(state (?:RUNNING|EXITED)\)|^Repositories: stable, dev\b|^Appointment refused, |\nNearest paths at \S+: |: call again with repo "|^Only copilot panes \(/.test(error)) return true;
  // Slice 15: the operator's control lease on a CLI pane (tools.ts OPERATOR_HOLDS_CONTROL).
  if (/^[^\n]*?Take control of this CLI pane before changing its active session\./.test(error)) return true;
  switch (name) {
    case "space_db_query":
      // 23/11: a restricted table or secret column (42501) answers its readable columns since a749d1cd67.
      return /\(code (?:42P01|42703|42702|42601|42883|42804|42501|22P02|2201B|21000)\)/.test(error)
        || /^space_db_query (?:only reads|reads only)/.test(error);
    case "space_task_update":
      return /^Task item \S+ was not found\.|^No task \S+\.|^\S+ is no task id\./.test(error);
    case "space_pane_checked": return /^WAITING_DATE needs nextCheckInMinutes:/.test(error);
    case "space_plan_update":
      return /^Clipboard item \S+ was not found\.|^Give a status, a percentage, a step,|^Not parked\.|^No such condition\.| is not parked(?: with a condition|, so it has no condition)/.test(error)
        // 20/11: the plan map's answers; tools.ts holds them since, and a completed plan is dropped since 74f9bc2079.
        || PLAN_MAP_ANSWER.test(error);
    case "space_copilot_answer":
      return /^The question was not found\.$|has no open question\.$|is neither the id nor the words of an open (?:MAIL|MARKETING|FREELANCE|JOB|DESIGN|APP_STUDIO|VIDEO|SECURITY|MONITORING) question\./.test(error);
    case "space_answer_pane":
      return /is not waiting for an answer \(state (?:IDLE|RUNNING|EXITED)\)|^The pane's question changed since it was inspected;|is a copilot pane with no question and no CLI prompt waiting now/.test(error)
        // 27/11: a pane without a CLI (23/11 19:46Z Work/Iris) goes to its card or its page since 19730513ca, else the answer naming its tools is held.
        || / pane without a CLI: there is no prompt to answer\./.test(error);
    // 27/11: the release train's conflicts (26/11 07:33Z "join it instead of cutting your own version") are held in tools.ts since.
    case "space_release":
      return /: join (?:it|\S+) instead of cutting your own version\.$|^No \S+ release is open\. Open one with op open\.$|^Only the captain|^Give the |^Name the (?:captain|new captain) pane|^Name the pane that leaves/.test(error);
    case "space_send_to_pane":
      return /^Not sent: [^\n]+: The CLI (?:has not opened its input yet|kept the text as an unsent draft after Enter)/.test(error)
        // 20/11: a pane that stays closed is a refusal (slice 19 r2); one closed between read and send takes that path, and Space Control's no-match
        // names the open panes (slice 24), so the bare "No panes match this selection. (read the pane" no longer occurs.
        || /^\S[^\n]* is closed and did not reopen \(|^Not sent: [^\n]*No panes match this selection\. \(read the pane/.test(error)
        // 20/11 (fifth pass): the bare sentence (15/11 01:40Z, Bob closed between the check and the send) re-routes to the closed-pane path
        // since 16/11, and noPanesMatch always names the open panes since slice 24 (cec6653163), so it no longer occurs.
        || /^No panes match this selection\.$/.test(error)
        // 22/11: a CLI that exited between lookup and keystroke (21/11 17:22Z) holds the text and resumes the CLI since db3fc76bd3, never this failure.
        || /^Not sent: [^\n]*?: CLI session \S+ is not active\. \(read the pane/.test(error)
        // 22/11: a pane id Space Control no longer finds in the room (21/11 16:26Z Dino/Finn moved to Cleo) goes to its new room since 9a092ee81d, else a refusal.
        || /^No pane named "pane:[^"]+" in this room\./.test(error);
    case "space_execute":
      // Daily Nous errors 14/11 slice 6: Space Control's answer goes on with its JSON receipt on the next line, so a line ends there, not the sample.
      return /^FAILED status(?: [^:\n]+:[^\n]+)?: Watch (?:ID is required|not found)\.(?:\n|$)/.test(error)
        || /^FAILED configure pane:[^:\s]+: (?:The CLI session changed during the model switch|Pane has no active session|Antigravity account profile "[^"]+" is not found)\.(?:\n|$)/.test(error)
        // 23/11 19:57Z: a model the CLI's menu lacks; the answer lists what it offers and tools.ts holds it since.
        || /^FAILED configure pane:[^:\s]+: (?:"[^"]*" is (?:not available in the CLI's current model menu|no Claude model)|\S+ has no effort (?:"[^"]*"|set)(?: in the CLI's current model menu)?): (?:this CLI|Claude) offers /.test(error)
        // R84 (12/11 ×4: mail_copilot, job-copilot, job, jobcopilot): panes.open reads a guessed pane-type key as its type (paneCountsByName).
        || /^FAILED panes\.open: \[\s*\{\s*"code": "unrecognized_keys"/.test(error)
        // Slice 14 (browser.content ×6 in 7 d): the Vault fence holds a page with a fill until it moves on; tools.ts says when to read again.
        || /^FAILED browser\.content\b[^\n]*?: This browser holds a Vault fill/.test(error)
        // Slice 23: a one-action stop still finishing its step is re-read and answered STOP PENDING or stopped since a564072422 (slice 27 b).
        || /^NOT CONFIRMED stop pane:\S+: Native stop is not yet confirmed; process is still yielding\. \(it may have run: [^\n]*\)$/.test(error)
        // Nous errors 24/11 (reopen ×2, both panes then ran): a reopened CLI still loading is read again and answered from that read since (tools.ts readAfterReopen).
        || /^NOT CONFIRMED (?:reopen|start|resume) pane:\S+: CLI readiness has not been confirmed\. \(it may have run: [^\n]*\)(?:\n|$)/.test(error)
        // 18/11 (files.preview ×11): id given in input or path
        || /^FAILED files\.preview: (?:Invalid input: expected string|\[\s*\{\s*"expected": "string")/.test(error)
        // 17/11 and 14/11: a screenshot another call is taking, a schedule of another room; Space Control's answer names the state.
        || /^FAILED (?:capture: Another Space screenshot is being captured|status: Schedule belongs to another room)/.test(error)
      // 20/11: Space Control's room cap wording is ROOM_CAP's since 15/11 (a refusal); a slash command waits for a starting CLI since slice 24 (b47a77b004).
      || /^FAILED panes\.open: Room capacity exceeded: |^FAILED native_command pane:\S+: Native state is unknown\.$/.test(error)
      // 20/11 (fifth pass): ops.logs ×9 of 15/11 04:38-04:44Z were SCHEMA_HASH_NOT_ALLOWLISTED (audit:CWeiGrKGatsw), which mcpHeld holds
      // since 16/11; the generic text names the adapter's status since, so this wording no longer occurs.
      || /^FAILED ops\.logs: The protected adapter did not complete this control\.(?:\n|$)/.test(error)
      // 23/11 REVIEW (22/11 15:20Z ×3): a shell pane moves since 1e2d7cc1de (the adapter text is gone), a closed pane's move is ok since 25b752ea55 and
      // a missing id is held since 6f489c737a; a batch with another failure (next line) still fails.
      || /^FAILED panes\.move: (?:This CLI adapter is not supported\.|panes\.move needs id: |Pane [^\n]+ is already closed and cannot be moved\.)[^\n]*(?:\n(?!FAILED |NOT CONFIRMED |CANCELLED )|$)/.test(error);
    // The receipt's detail starts near character 170 of the 200 kept: its first words decide.
    case "space_set_pane_model":
      return /"detail":"(?:The CLI session changed during|Claude is working;|Codex rejected the requested|Live Codex model control is un|This Claude Code version canno|\\"[^"\\]*\\" is no Claud)/.test(error)
        || /The CLI rejected the model selection/.test(error)
        // 14/11 slice 11: a catalogue that lists no such id, and the paid key while Max has room, name the pane to open instead.
        || /^This CLI cannot list \S+; open a |bills the paid Claude API key, and (?:a )?Claude Max (?:account )?still has room/.test(error)
        // 22/11 06:06Z (pane:sh994CSitcEw cli:gemini asked for claude-opus-5-5): loaded-catalog/Gemini switches now refuse before /model.
        || /^FAILED pane:\S+: The requested menu selection could not be verified \(no row names "[^"]+"\)/.test(error);
    // Slice 14 (×2 before 13/11 11:27 UTC): web.ts answers a check with no answer in time as its finding.
    case "space_net_check": return /^(?:This operation|The operation) was aborted|aborted due to timeout| within \d+ s\.$|^PTR takes a public IP address\.$|^getaddrinfo ENOTFOUND | does not resolve\.$/.test(error)
      // 20/11: a missing PTR record answers "no reverse DNS" (web.ts), a redirect loop names its chain (231f92a1c1); the old wordings no longer occur.
      || /^getHostByAddr ENOTFOUND |^Too many redirects\.$/.test(error);
    // 15/11: a scope the link lacks, an older build, a name no link has; tools.ts holds them since. 20/11: samples before f7b2a09147 are the
    // link's line (no status shown); their calls (15/11 01:24-06:18) were 403 for a scope and MOBILE_BODY, VALIDATION_ERROR, an unknown room,
    // which f7b2a09147 refuses before sending and f44f4583b4 leads with the scope; the line leads no result since.
    // 27/11: a route the link does not serve ("A linked SpaceApp answers only …", 26/11 11:05Z) is a held "Not sent:" since ebcaa3f413.
    case "space_remote": return /^A linked SpaceApp answers only |^Needs the \w+ scope: |^Not open to a link on |^No linked SpaceApp is |^\d+ linked SpaceApps are named |^Acting on a linked SpaceApp is unavailable to this turn$|^POST \/api\/version-sync answered 400 INVALID_INPUT/.test(error)
      || /^- .+ \(link:[A-Za-z0-9_-]+\) at \S+: may [^;]*; (?:last answered \S+(?:, connected)?|never connected yet)$/.test(error);
    // Slice 23: helpers' link calls are holds with guidance; an ended host session is a done stop; a pane one room holds names its room.
    // 23/11: a name no link has answers with the linked ones in every link tool (tools.ts linkError), as space_remote's since 15/11.
    // 25/11 REVIEW: a remote folder returns its listing (ok:true), and 400/404 invalid or missing remote paths are held with guidance.
    case "space_remote_file": return /^Files with a linked SpaceApp are unavailable to this turn$|^No linked SpaceApp is |^\d+ linked SpaceApps are named | is a folder there; give one of its files: |^It answered 400: \{"error":\{"code":"(?:MOBILE_BAD_PATH|INVALID_INPUT)"|^It answered 404: \{"error":\{"code":"NOT_FOUND"/.test(error);
    // 27/11 Daily Nous errors (23/11 ×4): Kimi's desktop release read as its CLI (b77fa171da), a rolled-back CLI failing the whole run (a100c3a384)
    // and cli:harness missing from the result's enum (e03c918045) are fixed; another CLI's rollback or invalid value still counts.
    case "space_cli_update": return /^CLI update of every managed CLI: FAIL \(\d+ checked\): Kimi Code CLI UPDATE_FAILED_ROLLED_BACK: Kimi Code CLI update failed \(Kimi Code stable release asset ids are invalid\.\)/.test(error)
      || /^The update of (?:every managed CLI|cli:harness) failed: \[ \{ "code": "invalid_value", "values": \[ "cli:codex", (?![^\]]*"cli:harness")/.test(error);
    case "space_link_parity": return /^Syncing a linked SpaceApp is unavailable to this turn$|^No linked SpaceApp is |^\d+ linked SpaceApps are named /.test(error);
    case "space_link_lend": return /^No linked SpaceApp is |^\d+ linked SpaceApps are named /.test(error);
    case "space_stop_pane": return /^CLI host session \S+ is EXITED\.$/.test(error);
    case "space_inspect": return /^A selected pane is not in this room\.$/.test(error);
    case "space_close_pane": return /"detail":"Pane pane:\S+ stays o/.test(error);
    case "space_notify_operator": return /^A pane is found in its room: give `room` with `pane`\.$| is no plan of yours: | has options and no recommended one: |is the fallback the card offers, never a prediction/.test(error);
    case "space_notes": return /^No note has the key /.test(error);
    case "space_clipboard_note": return /^(?:A new note needs its text\.$|Not saved: no item and no text\b)/.test(error);
    case "space_browser_set_route": return / is TERMINAL; browser sessions require |^BROWSER_ROUTE: another pane uses this browser account|^Browser navigation target must use http or https\./.test(error);
    // 18/11: a Design pane's run_start (Design and Video have no run routes); copilot-control.ts refuses it before the call since.
    case "space_copilot_control": return /^Protected control failed \(HTTP 404\)\.$| works on requests, not runs: /.test(error);
    case "space_web_read": return /, not a text page\.$|^Too many redirects\.$/.test(error);
    case "space_mail_campaign_resume": return /^"[^"]*" is [A-Z_]+(?: and not approved)?\.$/.test(error);
    case "space_mail_campaign_submit": return /^Fix the failed checks first:/.test(error);
    case "space_create_room": return /^The operator has no room yet\.$/.test(error);
    case "space_browser_close_tab": return /^No open tab \S+ in that browser|^The Browser Host is unavailable\.$|^This pane's Chrome (?:left a command unanswered|lost its DevTools connection)/.test(error);
    // 22/11: a 40 s search runs the free search and its first words since d9bc59a333/9cdff1112f (21/11); a slow one is a hold worded "search again with fewer words".
    case "space_web_search": return /Web search is out of quota until |^The search took longer than \d+ s; try fewer words\.$/.test(error);
    // 22/11: a non-domain site (21/11 02:22Z, the schema's ZodError) is answered with a note or the stored site whose domain holds it since 26da4a64a5/b618c3787c.
    case "space_site_signin_get": return /"message": "Use a public site domain or http\(s\) URL without credentials"/.test(error);
    case "space_request_done": return /^No such plan$/.test(error);
    case "space_settle_decision": return / is not one of your decisions\.|: nothing to settle\b/.test(error);
    case "space_tool_result": return /^No (?:long answer of call|answer of) \S+ is kept/.test(error);
    case "space_resolve_notification": return /^No (?:open )?notification \S+/.test(error);
    case "space_nous_share_file": return /^No Agent File [A-Za-z0-9_-]{6,80} in your rooms/.test(error);
    case "space_subagents": return /^Give tasks to start helpers, or the runId/.test(error);
    case "space_nous_followup": return /^Give exactly one trigger|^no change, keep nous_followup:/.test(error);
    // Retired 14/11 (only the operator spends reset credits): its past refusals stay refusals in the 7-day facts.
    case "space_codex_reset_redeem": return /a credit now would be wasted\. Nothing spent\.|^No Codex account is named/.test(error);
    case "space_mail_read":
    case "space_mail_search":
      // 27/11: a messageId of another thread, or of none, reads a thread since 794f0c9a2b/de1e04d56a (24/11 07:20Z "No message … in thread").
      if (name === "space_mail_read" && /^No message \S+ in thread \S+\. Its messages: /.test(error)) return true;
      return /is not a mail account of this pane\.|: Gmail no longer has that message or thread\.|Attachment was not found\./.test(error);
    case "space_look":
      return /has no live browser session: nothing to look at\.$|^The Browser Host is unavailable\.$|^No Xvfb display is available for a headed browser session\.$|^BROWSER_ROUTE: another pane uses this browser account on another network route;|, not an image \(PNG, JPEG, WebP or GIF\):/.test(error);
    // 14/11: every upsert/add_mail problem checks the entry given (its fields, a twin, an operator lock) and saves nothing; tools.ts holds them all.
    case "space_programs":
      return /^No program \S+(?:\.|$)|^Only Nous (?:can (?:write|change)|changes the programs registry)|^(?:delete needs id|add_mail needs id and mail|upsert needs entry)\b/.test(error)
        || /^(?:[a-z0-9][a-z0-9-]*: )?[a-z][A-Za-z]*(?:\.\w+)*: (?:Invalid |Not a |Too (?:big|small)|Unrecognized key|Required|Expected )/.test(error)
        || /^[a-z0-9][a-z0-9-]*: (?:a new program needs parent, program and status|locked names no field: )| is already recorded as \S+; update \S+ instead| locked by the operator; change or unlock it only with a new source/.test(error);
    // 14/11: a short id several objects share, a revision no repository has, a path not at that revision; git.ts's answer names the next call for each.
    case "space_git":
      return /^git: (?:error: short object ID \S+ is ambiguous|fatal: ambiguous argument '[^']+': unknown revision or path not in the working tree|fatal: bad revision '|fatal: bad object |fatal: invalid object name '|fatal: no such path \S+ in |fatal: path '[^']+' (?:does not exist in|exists on disk, but not in) ')/.test(error);
    case "space_ask_operator":
      // 20/11: a copilot decision the item does not take is held (tools.ts) and names the ones it takes.
      if (/ is not a decision a [\w ]+ copilot's \w+ takes: use |^An approved decision cannot decide a /.test(error)) return true;
      // 22/11 09:31Z: a call without checked is held as "Invalid arguments: checked: …" since 52eb9985b4, so this answer no longer occurs.
      if (/^checked is required: Ask last /.test(error)) return true;
      if (/^The action approves no ticket\.|^The action's (?:room|pane) ".* (?:is not one of|is not in) |^replaces names \S+, which is not an open decision| approved this exact action at |^prediction\.answer .* Nothing asked\.$/.test(error)) return true;
      // File refs use the same reader's boundary, missing-file and binary-text refusals as space_files_read.
      return historicalToolHold("space_files_read", error);
    // 18/11 (×5 EACCES on a pane's file in the own folder, now replaced through a copy; "exists" names mode replace or append): the answer names the next call.
    case "space_files_write":
      return /exists: replace it \(mode replace\) or add to it|is not writable by Space: |is not a regular file: choose another name|^EACCES: permission denied, open '\/proc\/self\/fd\//.test(error);
    case "space_files_read":
    case "space_files_list":
      // 27/11: another key name for the file (22/11 13:46Z {artifact}) is read since tools.ts maps it to path or artifactId.
      return /^Give a path or an artifactId \(Ignored (?:artifact|artifact_id|id|file|filePath|file_path|filename|name): /.test(error) || /looks like a secret \(keys, tokens|is private to the agent that wrote it|a folder the agent that made it keeps private|^Only files under .* can be read\.|leads outside the agent workspace|(?:^|: )No file or folder .* under the agent workspace\.|^No Agent Files or Media artifact \S+ in your rooms\.| is a folder; name its files one by one| is a binary(?: file|…)| is \d+(?:\.\d+)? MB; files up to \d+ MB are read\./.test(error);
    // 20/11: a restarted CLI still starting is read again for 30 s (tools.ts); its answer adds what the reads showed, so the bare line no longer occurs.
    case "space_restart_pane": return /^UNKNOWN [^\n]+: CLI readiness has not been confirmed\.(?:\n|$)/.test(error);
    default: return false;
  }
}

/** A turn's failed-but-not-refused calls of one tool whose recorded cause today's rules hold as a refusal (the score, progress and review agree). */
export function heldToolFailures(name: string, tool: NousToolCounts): number {
  // Samples are the failed-but-not-refused calls, repeats included (the first 3 a turn before 14/11; migration 0338 filled the rest). Legacy error is one call.
  return Math.min(Math.max(0, tool.failed - tool.refused), toolErrorSamples(tool).filter((error) => historicalToolHold(name, error)).length);
}
