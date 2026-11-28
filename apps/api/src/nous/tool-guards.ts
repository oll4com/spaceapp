import type { NousToolContext } from "./tool-deps.js";
import { clipText } from "./tool-definitions.js";
import type { OwnerQuietState } from "../owner-clock.js";
import { DEVICE_APPROVAL, OPERATOR_HANDS, OPERATOR_ORDER_ID, RESET_ASK, resetRefusal, VAULT_SIGNIN_ASK, vaultSigninHold } from "../signin-readback.js";
import { siteSigninDomain, publicSiteHost } from "@space/contracts";
import type { SiteSigninsRepository } from "@space/db";
import { type InstanceLinkView, type LinkParity } from "../instance-link/routes.js";
import type { LinkSyncCategory } from "../instance-link/settings-sync.js";
import { needsOperatorHandsText } from "@space/contracts";
import { z } from "zod";
import { resolveControlSettingsAction } from "../space-control-settings.js";
import {
  controlActionSchema,
  NOUS_TURN_REASONS,
  type NousDecisionAction,
  type NousDecisionCategory, type Pane, type SpaceNotification, type TaskItem,
  type NousTurnReason
} from "@space/contracts";
import { DEFERRAL_FOLLOWUP_MIN_MS, deferralHold } from "./daily-review.js";
import { roomAgentControlRisk } from "../room-agent-tools.js";
import { CLAUDE_PANE_MODEL_PREFIX, claudePaneModelFamily } from "../cli-native-model-picker.js";
import { classifyNousOutgoing, type NousAllowances } from "./guardrails.js";
import {
  sameCardSubject
} from "./pane-notices.js";
import type { CouncilRun } from "@space/contracts";
import { type NotificationRaiseInput } from "@space/contracts";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/** R20-fail-1 (a): why Space Control would refuse a decision's batch on the operator's yes (its schema, settings.update's domains), or null. */
export function controlBatchProblem(actions: ReadonlyArray<Record<string, unknown>>): string | null {
  for (const [index, raw] of actions.entries()) {
    const parsed = controlActionSchema.safeParse(raw);
    if (!parsed.success) { const issue = parsed.error.issues[0]!; return `actions.${index}${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}.`; }
    // R21-2: a delete runs on its route's :id, and Agent Files and Media check the artifact by the action's own id.
    if (parsed.data.kind === "resource" && ID_DELETES.has(parsed.data.operation) && !deleteId(parsed.data)) {
      return `actions.${index}: ${parsed.data.operation} names nothing to delete: put the id in the action's "id".`;
    }
    if (parsed.data.kind !== "resource" || parsed.data.operation !== "settings.update") continue;
    try { resolveControlSettingsAction(parsed.data); }
    catch {
      const domain = String((parsed.data.input as { domain?: unknown }).domain ?? "");
      return `actions.${index}: settings.update takes the domains appearance, voice, task_titles, tools and plugins with a patch${domain ? `; "${clipText(domain, 40)}" is not one` : ""}. `
        + "Nous, its allowances and the quiet hours are the operator's to set in Settings (Assistants & AI → Nous; Notifications → Quiet hours): ask without an action and name the path and the values.";
    }
  }
  return null;
}

/** The public-address gate of web reads and network checks (a security refusal, never a failed check). */
export const PUBLIC_ADDRESS_GATE = /private or local address|Private and local addresses|This address is not fetched|URLs with credentials|PTR takes a public IP address/;
// Designed refusals, not mistakes: private or mode-700 files, the workspace boundary, and guards whose answer names the next call (nearest real paths, branches, the repo holding it) (R84).
export const NAMES_NEXT_CALL = /^Repositories: stable, dev\b|^Appointment refused, |\nNearest paths at \S+: |: call again with repo "|\nNo path at \S+ shares its words; |\nNearest branches and tags to |\nNo branch, tag or commit .+ in this repository: | names several objects: call again with a longer id|^Only copilot panes \(/;
export const SECRET_OR_PRIVATE_GATE = /looks like a secret \(keys, tokens|is private to the agent that wrote it|a folder the agent that made it keeps private|^Only files under .* can be read\.|leads outside the agent workspace/;
// Guards that keep an answer off a changed question or a running turn, and input off a CLI not ready or stopped, are no mistakes; the answer names the pane's state.
export const PANE_READY_GATE = /question changed since it was inspected|has not opened its input yet|is not waiting for an answer \(state (?:RUNNING|EXITED)\)/;
// The operator holds this CLI pane's control lease in a browser tab, so Space keeps Nous off it.
export const OPERATOR_HOLDS_CONTROL = /^Take control of this CLI pane before changing its active session\./;
// routes.ts linkOf: a name no linked SpaceApp has, or several share.
export const NO_SUCH_LINK = /^No linked SpaceApp is |^\d+ linked SpaceApps are named /;
/** The room's pane cap in both wordings: the pane store's, and Space Control panes.open's (plan BZ0hO3NkNbqV, 15/11 01:26Z: charged as a failure). */
export const ROOM_CAP = /is capped at (\d+) active panes|maximum capacity is (\d+) panes/;
/** Slice 29: client.ts's answers when the link itself is down (not a peer's refusal): the next call is held until the link answers again. */
export const LINK_DOWN = /^(?:No address of that SpaceApp answered|That SpaceApp did not answer in time|The link to that SpaceApp (?:broke|is closed))/;
export const PANE_READY_NEXT = " Read the pane (space_read_pane) and act on what it shows now: answer its current question, or try again in a minute if it is still starting.";
const ID_DELETES = new Set(["files.delete", "media.delete", "tasks.delete", "links.delete"]);
const deleteId = (action: Record<string, unknown>): string | null => {
  const input = action.input && typeof action.input === "object" ? action.input as Record<string, unknown> : {};
  return typeof action.id === "string" ? action.id : typeof input.id === "string" ? input.id : null;
};
/** The operator's yes is each delete's confirmation, so an approved batch runs with confirm and an approvalReason naming the decision (R21-2). */
export function confirmedControlBatch(actions: ReadonlyArray<Record<string, unknown>>, decisionId: string): Array<Record<string, unknown>> {
  return actions.map((action) => {
    if (action.kind === "clipboard" && action.operation === "delete") return { ...action, confirm: true };
    const operation = String(action.operation);
    if (action.kind !== "resource" || !(ID_DELETES.has(operation) || operation === "settings.rollback")) return action;
    const id = ID_DELETES.has(operation) ? deleteId(action) : null;
    return { ...action, ...(id ? { id } : {}), confirm: true, approvalReason: `The operator's yes on ${decisionId}` };
  });
}

export const tokenModelReason = (ctx: NousToolContext): NousTurnReason | "HELPER" | undefined => {
  const reason = ctx.turn?.reason;
  return reason === "HELPER" || NOUS_TURN_REASONS.some((value) => value === reason) ? reason as NousTurnReason | "HELPER" : undefined;
};

/** A page image a look may carry (Claude takes images up to 5 MB; a masked viewport PNG is well under 1 MB). */
export const NOUS_LOOK_MAX_BYTES = 4 * 1_048_576;
/** One page of a tool answer stays within what the CLIs accept as an MCP result; the rest is paged. */
export const NOUS_TOOL_RESULT_MAX_CHARS = 40_000;
// A pane read that hangs (15/11: two reads of Emma passed the 55 s tool answer) answers FAILED well before it, so the turn goes on.
export const NOUS_PANE_READ_MS = 20_000;
/** A paged answer stays readable this long: a turn runs at most 20 minutes, its helpers within it. */
export const RESULT_PAGES_KEEP_MS = 60 * 60_000;
/** R64: what Claude Code shows of an answer it saved to a file (its 2,000-character preview); every longer answer is kept for the turn. */
export const CLI_PREVIEW_CHARS = 2_000;
/** Space Memory matches a space_memory_recall page holds (the memory list's page). */
export const NOUS_MEMORY_PAGE = 25;
/** A pane whose task runs this soon (or is overdue) stays open: closing it would only reopen it (operator order 2026-10-24: task panes close too). */
export const TASK_SOON_MS = 60 * 60_000;
/** A task holds its pane when RUNNING, scheduled and due within TASK_SOON_MS or overdue, or a one-off that ran and is not DONE; one reading for close tools and Standing orders (plan clipboard:CTVaL1V3kAFM). */
export function taskHoldsPane(task: TaskItem, at: number): boolean {
  if (task.status === "DONE" || task.status === "ARCHIVED") return false;
  if (task.status === "RUNNING") return true;
  if (!task.schedule) return false;
  if (Date.parse(task.schedule.nextRunAt ?? "") - at < TASK_SOON_MS) return true;
  return Boolean(task.schedule.lastRunAt && !task.schedule.nextRunAt);
}
/** Technical bound (one tool answer, under NOUS_TOOL_RESULT_MAX_CHARS): a space_conversation page; the answer names the next offset. */
export const NOUS_CONVERSATION_PAGE_CHARS = 30_000;
/** Notes a space_notes page holds (one tool answer). */
export const NOUS_NOTES_PAGE = 40;
// Old facts were told as current, so the warning is said where the old fact is read.
export const DATED_FACTS = "Each entry was true on its date: before you state a balance, credit, renewal, token, risk or pane state from an older one as current, check it on its real surface now, or give its date and say you did not re-check it.";
// 14/11 (UpCloud's €5.000 wait, Hetzner's credit: told from older notes and reports): a note older than today carries it too.
export const datedNotes = (notes: Array<{ updatedAt: string }>) => notes.some((note) => note.updatedAt.slice(0, 10) < new Date().toISOString().slice(0, 10)) ? `${DATED_FACTS}\n\n` : "";

type ZodIssue = z.ZodError["issues"][number];
/** A union's refusal lists the issues of the branch nearest the input (fewest issues, the last on a tie), each with its full path, so the next call is right (R17-4). */
export function nearestIssues(issues: readonly ZodIssue[], path: PropertyKey[] = []): Array<{ path: string; message: string }> {
  return issues.flatMap((issue) => {
    const at = [...path, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length) return nearestIssues(issue.errors.reduce((best, branch) => branch.length <= best.length ? branch : best), at);
    return [{ path: at.join(".") || "arguments", message: issue.message }];
  });
}

/** On a tool whose schema was not in the prompt, the one key the schema does not know fills the one missing required key, JSON text parsed (R84). */
export function renamedArgs(schema: unknown, raw: Record<string, unknown>, issues: readonly ZodIssue[]): Record<string, unknown> | null {
  if (!(schema instanceof z.ZodObject)) return null;
  const shape = schema.shape as Record<string, z.ZodType>;
  const missing = [...new Set(issues.filter((issue) => issue.path.length === 1 && raw[issue.path[0] as string] === undefined).map((issue) => String(issue.path[0])))];
  const extra = Object.keys(raw).filter((key) => !(key in shape));
  let named = raw;
  if (missing.length === 1 && extra.length === 1) { const { [extra[0]!]: value, ...rest } = raw; named = { ...rest, [missing[0]!]: jsonText(value) }; }
  // A value that does not fit its field is tried as JSON text, as its one item, or as a list of it.
  const fitted = Object.fromEntries(Object.entries(named).map(([key, value]) => [key, shape[key] ? fitArg(shape[key], value) : value]));
  return named !== raw || Object.keys(fitted).some((key) => fitted[key] !== raw[key]) ? fitted : null;
}

function jsonText(value: unknown): unknown {
  if (typeof value === "string" && /^\s*[[{]/.test(value)) try { return JSON.parse(value) as unknown; } catch { /* kept as text: the schema names what is wrong */ }
  return value;
}

function fitArg(field: z.ZodType, value: unknown): unknown {
  if (field.safeParse(value).success) return value;
  const given = jsonText(value);
  const tries = Array.isArray(given) ? [given, ...given.length === 1 ? [given[0]] : []] : [given, [given]];
  return tries.find((one) => field.safeParse(one).success) ?? given;
}

/** A call to a tool whose schema was not yet in the prompt is held, not a mistake; the answer gives the schema in one line so the next call is right. */
export function missingArgsShape(schema: unknown, raw: Record<string, unknown>): string | null {
  if (!(schema instanceof z.ZodObject)) return null;
  const required = requiredArgs(schema);
  return !required.length || required.some((key) => raw[key] !== undefined) ? null : argsShape(schema);
}

const requiredArgs = (schema: z.ZodObject) => Object.keys(schema.shape).filter((key) => !(schema.shape[key] as z.ZodType).safeParse(undefined).success);

/** A tool's arguments in one line, `?` on the optional ones. */
function argsShape(schema: z.ZodObject): string {
  const required = requiredArgs(schema);
  const json = z.toJSONSchema(schema, { unrepresentable: "any" }) as { properties?: Record<string, { type?: string; enum?: unknown[] }> };
  const type = (key: string) => { const p = json.properties?.[key]; return p?.enum ? p.enum.map(String).join("|") : p?.type ?? "value"; };
  return `{${Object.keys(schema.shape).map((key) => `${key}${required.includes(key) ? "" : "?"}: ${type(key)}`).join(", ")}}`;
}

/** zod silently drops keys a tool does not take, so misnamed arguments reach the handler missing; a failed call names the keys it dropped and the shape. */
export function ignoredArgsNote(schema: unknown, raw: Record<string, unknown>): string {
  if (!(schema instanceof z.ZodObject)) return "";
  const ignored = Object.keys(raw).filter((key) => !(key in schema.shape));
  return ignored.length ? ` (Ignored ${ignored.join(", ")}: not arguments of this tool, which takes ${argsShape(schema)}.)` : "";
}

// A card recommending a quiet-hours slot while another option is a daytime slot is held; ruleDiffers says why the night one.
// Shortcut: the offered options are taken as before the deadline (the card names none); read a deadline from the item when a card carries one.
export function nightSlotNote(item: { options?: string[]; recommended?: string }, quiet: Pick<OwnerQuietState, "enabled" | "zoneSet" | "start" | "end" | "night">): string | null {
  if (!item.recommended || !item.options?.length || !quiet.enabled || !quiet.zoneSet || quiet.start === quiet.end) return null;
  const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  const [from, to] = [minutesOf(quiet.start), minutesOf(quiet.end)];
  const inQuiet = (at: number) => from < to ? at >= from && at < to : at >= from || at < to;
  const time = (text: string) => { const match = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(text); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };
  const night = (text: string) => { const at = time(text); return at !== null ? inQuiet(at) : /\b(?:tonight|overnight)\b|απόψε|αποψε/i.test(text) || (quiet.night && /\bnow\b|τώρα|τωρα/i.test(text)); };
  if (!night(item.recommended)) return null;
  const day = item.options.find((option) => option !== item.recommended && time(option) !== null && !night(option));
  return day ? `The card recommends "${clipText(item.recommended, 80)}", inside the operator's quiet hours (${quiet.start}-${quiet.end}), while "${clipText(day, 80)}" is a daytime slot. `
    + "Recommend the daytime slot; nothing was raised. Only if the night slot is needed (the deadline falls before the day one), raise the item again with ruleDiffers saying so." : null;
}

/** The kinds of an ask only the operator's hands answer (15/11 nous_msg:9f70dbbe); a one-time code and Nous's own pane/plan cards are asks too. */
const HANDS_ASK = /^(NEEDS_HANDS|NEEDS_YOU|NEEDS_USER|HANDOFF_REQUESTED|BROWSER_HANDOFF_REQUESTED|SIGN_IN)$/;
export const HANDOFF_ASK = /^(HANDOFF_REQUESTED|BROWSER_HANDOFF_REQUESTED)$/;
export const ASK_PANE_KEY = /^(?:nous:pane:|nous:closed-pane:|browser-handoff:|job-apply:handoff:)(pane:[A-Za-z0-9_-]+)$/;
export const operatorAsk = (item: Pick<SpaceNotification, "kind" | "source" | "dedupeKey" | "payload">) => HANDS_ASK.test(item.kind)
  || Boolean((item.payload.ask as { code?: unknown } | undefined)?.code)
  || (item.source === "NOUS" && /^nous:(pane|plan|closed-pane):/.test(item.dedupeKey ?? ""));
/** Null when Nous may close a Needs you item with a reason, else what makes it the operator's: a sign-in or code, pairing, a Vault change, payment or KYC, their own interview or test (nous_msg:6573b247). */
const PAIRING_ASK = /\bpairing\b|\bpair (?:a |the |this |my |his )?(?:device|phone|app|browser)\b|σύζευξ/i;
const VAULT_ASK = /\bvault\b/i;
const PAYMENT_ASK = /\b(?:pay(?:ment|ing)?|paid|invoice|billing|checkout|purchase|credit card|debit card|card details|bank transfer|wire transfer|top[- ]?up|kyc|identity verification|verify (?:your|my|his) identity|passport|id document)\b|πληρω|ταυτοποίησ/i;
const OWN_TEST_ASK = /\binterview|\bassessment\b|\bexam\b|\b(?:coding|skills?|online|technical|take[- ]home|aptitude|personality) (?:test|challenge|quiz)\b|συνέντευξ/i;
export const securityAsk = (item: Pick<SpaceNotification, "kind" | "source" | "title" | "body" | "payload">): string | null => {
  const text = `${item.title}\n${item.body ?? ""}`;
  if (item.kind === "SIGN_IN" || HANDOFF_ASK.test(item.kind) || /\bsign[- ]?in\b|\blog[- ]?in\b|captcha/i.test(text)) return "a sign-in";
  if ((item.payload.ask as { code?: unknown } | undefined)?.code || codeAsk([text]) || MFA_ASK.test(text)) return "a one-time code";
  if (PAIRING_ASK.test(text)) return "device pairing";
  if (VAULT_ASK.test(text)) return "a Vault change";
  if (PAYMENT_ASK.test(text)) return "a payment or KYC";
  if (OWN_TEST_ASK.test(text)) return "the operator's own interview or test";
  // Operator 27/11 (nous_msg:766ca4f6): Nous closed a held Crosschq ID.me check with a reason; an identity check is theirs alone too.
  return needsOperatorHandsText(`${text}\n${(item.payload.ask as { question?: unknown } | undefined)?.question ?? ""}`) ? "the operator's own identity check" : null;
};
/** A report that says the ask's work is done: a DONE report, or one that is no wait and says done or ok. */
export const reportSaysDone = (report: { status: string; summary: string }) => report.status === "DONE"
  || (!/^(WAITING|BLOCKED|NEEDS_DECISION|NEEDS_YOU|QUESTION|FAILED)$/.test(report.status) && /\b(done|ok|okay)\b/i.test(report.summary) && !/\bnot (done|ok|okay)\b/i.test(report.summary));

/** Queue item 38: a pane close past the working/open-work guards (Space Control knows no `force`); never past a needs-you request (15/11). */

/** Words that make Space's safety guard read a pane text as destructive (named back to Nous when it holds one, queue item 28). */
export const DESTRUCTIVE_WORDS = /\b(?:delete[sd]?|deleting|drop(?:ped|s)?|remove[sd]?|removing|rm\s+-r\w*|wipe[sd]?|truncate[sd]?|purge[sd]?|destroy(?:ed|s)?|reset|kill(?:ed|s)?|prune[sd]?|erase[sd]?|force[- ]push|overwrite[sd]?|uninstall(?:ed|s)?|format)\b/gi;
/** R22-5: a DATE wait Nous just set on a plan or goal is a deferral the daily REVIEW weighs (tool row meta). */
export const deferralMeta = (kind: "PLAN" | "GOAL", id: string, waits: { kind: string; what: string; until: string | null } | null | undefined) =>
  waits?.kind === "DATE" ? { meta: { deferral: { kind, id, until: waits.until, what: waits.what } } } : {};

const EFFORT_SUFFIX = /^(.+)-(minimal|low|medium|high|xhigh|max|ultra)$/i;
/** The catalogue entry an asked id names: the same id in any case, or on a Claude Code pane the family a full id or bare name gives, as the room controller's findNativeCliModel maps it. */
export function catalogueModel<T extends { id: string }>(modelId: string, models: readonly T[]): T | undefined {
  const wanted = modelId.trim().toLowerCase();
  const family = claudePaneModelFamily(wanted) ?? /^(opus|sonnet|haiku|fable)$/.exec(wanted)?.[1];
  return models.find((entry) => entry.id.toLowerCase() === wanted) ?? (family ? models.find((entry) => entry.id === `${CLAUDE_PANE_MODEL_PREFIX}${family}`) : undefined);
}
/** A modelId with a -high/-xhigh/-max suffix moves the suffix into reasoningEffort when the base model id is in the CLI's catalogue. */
export function effortSuffixed(modelId: string, models?: ReadonlyArray<{ id: string; supportedReasoningEfforts: readonly string[] }>): { modelId: string; reasoningEffort: string } | null {
  if (!models?.length || models.some((entry) => entry.id.toLowerCase() === modelId.toLowerCase())) return null;
  const match = EFFORT_SUFFIX.exec(modelId.trim());
  if (!match) return null;
  const base = match[1]!, rawEffort = match[2]!;
  const found = catalogueModel(base, models);
  if (!found) return null;
  const effort = rawEffort.toLowerCase();
  const supported = found.supportedReasoningEfforts;
  const mapped = !supported.length || supported.includes(effort) ? effort
    : (effort === "xhigh" || effort === "max" || effort === "ultra") && supported.includes("max") ? "max"
    : (effort === "xhigh" || effort === "max" || effort === "ultra") && supported.includes("high") ? "high" : effort;
  return { modelId: found.id, reasoningEffort: mapped };
}
/** 2026-11-06 REVIEW: the pools a quota-reset wait may name, by tokens.ts' pool keys; a pool with this much of a window left has room. */
export const QUOTA_POOLS: Array<[string, RegExp]> = [["claude", /\bclaude\b|\bopus\b|\bsonnet\b/i], ["codex", /\bcodex\b/i], ["gemini", /\bgemini\b|\bantigravity\b/i]];
export const QUOTA_ROOM_PERCENT = 10;
/** A wait on a provider's room that names no reset ("when Claude has room", "no provider room now", noRoomGuard's refusal). */
export const ROOM_WAIT = /\bno (?:provider )?room\b|\bhas room\b|\bnoRoomGuard\b|\bwithout room\b|χωρίς (?:όριο|χώρο)/i;
/** A freeze names a period work must not run and only the operator sets one; a freeze with no period (a UI freeze bug) passes. */
/** An operator message that holds work back: a freeze, pause, wait or stop, or a date it waits for (the loose check on a cited freeze order). */
export const PLAN_HOLD_ORDER = /freez|pause|\bhold|\bstop|\bwait|\buntil\b|\bafter\b|\bembargo|π[άα]γ[ωώ]|σταμ[άα]τ|περ[ίι]μεν|μ[έε]χρι|μετ[άα]|\d{1,2}\/\d{1,2}/i;
export const PLAN_FREEZE = /\b(?:code|deploy(?:ment)?|release|change|merge|sales?|bf|cm|holiday)[ -]freeze\b|\bfreeze (?:until|till|through|ends?)\b|\bfreeze\b[^.\n]{0,20}\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}[^.\n]{0,20}\bfreeze\b|\bembargo\b|(?:μετά|πριν|λόγω)(?: (?:το|του))? π[άα]γ[ωώ]μ|π[άα]γωμα (?:έως|μέχρι|ως) |π[άα]γ[ωώ]μ[^.\n]{0,20}\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}[^.\n]{0,20}π[άα]γ[ωώ]μ/i;
/** A time wait over an hour whose words name no real hold (R31's classifier) is refused; an explicit reason overrides it (goal 35813e48). */
export function runNowProblem(what: string, until: string | null | undefined, reason: string | undefined): string | null {
  // 14/11 REVIEW item 6: a wait whose time already passed holds nothing, whatever its words or reason (a follow-up's past time fails in followups.ts).
  if (until && Date.parse(until) <= Date.now()) return `Run it now: ${until} already passed, so "${what.replace(/\s+/g, " ").trim().slice(0, 160)}" waits on nothing. `
    + "Do it in this turn, or set the time it really waits for (clear the wait when nothing holds it). Nothing was set.";
  // A DATE wait with no time is held only by a hold its words name or a reason; the REVIEW counts each one naming no hold as a miss (deferralLines).
  if (reason || (until && Date.parse(until) - Date.now() <= DEFERRAL_FOLLOWUP_MIN_MS) || deferralHold(what)) return null;
  return `Run it now: nothing here needs a later time. "${what.replace(/\s+/g, " ").trim().slice(0, 160)}" names no fixed date or time from a third party or a deadline, `
    + "no quota or allowance reset, no merge-queue ticket, no running job's ETA and not the operator's hands. Do it in this turn; if something real holds it, "
    + "say so in the text or give reason (kept in the record). Nothing was set.";
}

/** R13-3: what a held pane text asks for, read from its words: a release, a send or payment, else a delete. */
export const GUARD_RELEASE = /\b(?:npm\s+publish|publish(?:es|ed|ing)?|hotfix|promote[sd]?|space-queue\s+(?:promote|approve))\b/i;
export const GUARD_EXTERNAL = /\b(?:send|sends|sending|e-?mail|reply|replies|tweet|pay|pays|payment|invoice|refund|transfer|charge)\b/i;
/** R13-12: the sites an EXTERNAL ask names (refs.site, then hosts in its texts; file names and e-mail addresses' domains left out), at most 5. */
export const FILE_SUFFIXES = new Set(["md", "json", "txt", "ts", "tsx", "js", "mjs", "cjs", "html", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "csv", "log", "sh", "yml",
  "yaml", "sql", "zip", "toml", "py", "css", "mp4", "mp3", "eml", "lock", "env",
  // systemd units (31/10 17:00 BKK: "Sign-ins for space-browser-host.service"); .target is also a real TLD.
  "service", "socket", "timer", "target", "mount", "automount", "path", "slice", "scope", "swap", "device"]);
/** No operator address on a card or decision: every string of `value` except the `keep` keys (ids, targets, actions) gets each `own` address replaced by its kind, e.g. "your Gmail". */
export function withoutOwnAddresses<T>(value: T, own: readonly string[], keep: readonly string[] = []): T {
  if (!own.length) return value;
  const pattern = new RegExp(`(?<![\\w.+-])(?:${own.map((address) => address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-]|\\.\\w)`, "gi");
  const label = (address: string) => /@(?:gmail|googlemail)\.com$/i.test(address) ? "your Gmail" : `your ${address.split("@")[1]!.toLowerCase()} mailbox`;
  const walk = (entry: unknown): unknown => typeof entry === "string" ? entry.replace(pattern, label)
    : Array.isArray(entry) ? entry.map(walk)
    : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).map(([key, inner]) => [key, keep.includes(key) ? inner : walk(inner)])) : entry;
  return walk(value) as T;
}
export const CARD_KEEP = ["room", "pane", "ref", "target", "steps"];
export const ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** An account a text names: a Reddit user (u/name) or an e-mail address. */
export const ACCOUNT_NAMED = /(?<![\w/@.+-])(?:u\/[\w-]{3,}|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi;
// A sign-up or enrolment brief for a company domain with no email named (nous_msg:fa4290a8).
export const ENROLL_ACCOUNT_ACTION = /\b(?:sign[- ]?up|enrol(?:l|ment|ling)?|register|registration|create (?:an? )?(?:\S+ ){0,2}account|apply|application|partners?|onboard(?:ing)?)\b|(?<!\p{L})(?:εγγραφ|δημιουργ\p{L}* λογαριασμ|αιτησ)/iu;

export function namedSites(site: string | undefined, texts: string[]): string[] {
  const found = new Set<string>();
  const add = (host: string) => { const named = FILE_SUFFIXES.has(host.split(".").at(-1)!.toLowerCase()) ? null : publicSiteHost(host); if (named) found.add(named); };
  if (site) add(site.replace(/^[a-z]+:\/\//i, "").split(/[/:]/)[0]!);
  for (const text of texts) for (const match of text.matchAll(/(?<![\w./@-])(?:[a-z0-9-]+\.)+([a-z]{2,24})(?![\w-])/gi)) add(match[0]);
  // R21-3: a link's host too (a hands card's steps carry the https link; the bare-host match skips what follows "//").
  for (const text of texts) for (const match of text.matchAll(/\bhttps?:\/\/([a-z0-9.-]+)/gi)) add(match[1]!);
  return [...found];
}
/** R20-ask-1: what makes an ask about accounts: the word, signing in or up, creating one, Google. */
export const ACCOUNT_ASK = /\b(?:accounts?|sign(?:ed|ing)?[ -]?(?:in|up)|log(?:ged|ging)?[ -]?in|register|google)\b|λογαριασμ|σύνδεσ|εγγραφ/i;
export const CREATE_ACCOUNT = /\b(?:create|open|register|make|set up)\b[^.\n]{0,30}\baccount\b|\bnew\b[^.\n]{0,20}\baccount\b|\bsign[ -]?up\b|δημιουργ[^.\n]{0,30}λογαριασμ|εγγραφ/i;
export const SIGN_IN_ASK = /\bsign(?:ed|ing)?[ -]?in\b|\blog(?:ged|ging)?[ -]?in\b|\bhandoff\b|σύνδεσ|συνδεθ/i;
/** R21-asklast-pendings (lessons-1031-do-it-yourself: a pendings list put a Vault unlock on the operator): agents fill with no unlock. */
/** R21-3: hands work an agent does itself where the Vault holds a login or Space signed in before (a sign-in, its password or code, a handoff). */
const HANDS_SIGN_IN = new RegExp(`${SIGN_IN_ASK.source}|password|passcode|\\b2fa\\b|\\bmfa\\b|\\botp\\b|verification code`, "i");
/** R60: what only the operator does at a site (money, tax or bank data, an ID, a camera): he lands on a page an agent signed in to. */
export const OPERATOR_ONLY = /\b(?:card|pay|payment|paid|iban|tax|bank|passport|selfie|camera|id check|identity)\b|κάρτα|καρτα|πληρω|πληρώ|φορολογ|ΑΦΜ|τράπεζ|κάμερα|ταυτότητ|διαβατήρ/i;
/** Hands work at a site beyond signing in: tests, forms, uploads, a password or code, and the parts only the operator does (R60). */
export const HANDS_SITE_WORK = new RegExp(`${HANDS_SIGN_IN.source}|\\btests?\\b|assessment|\\bforms?\\b|upload|τεστ|φόρμα|κωδικ|στοιχεί|ανέβ|${OPERATOR_ONLY.source}`, "i");
/** R60: a `checked` item saying an agent signed in and the page is open where he works. */
export const PAGE_READY = /\b(?:signed|logged) in\b[^.\n]{0,80}\b(?:page|open)|\bpage\b[^.\n]{0,40}\bopen|συνδεδεμέν|συνδέθηκ[^.\n]{0,80}σελίδα/i;
/** R21-3: a `checked` item that says why an agent cannot do it (it tried, it failed, the code goes to his phone). */
/** 13/11 (a root install card held by rule 4d47dcab for spaceapp.example): no agent has sudo, so root work is the operator's. */
export const ROOT_WORK = /\bsudo\b|\bas root\b|\broot (?:shell|access|terminal|user)\b|\bsu\s+-|\bsystemctl\s+(?!--user)\w/i;
export const AGENT_CANNOT = /\b(?:cannot|can't|can not|unable|failed|fails|tried|blocked|refused|rejected|phone|sms|passkey|hardware key|biometric)\b|δεν μπορ|απέτυχ|κινητό/i;
// A key named by its last characters, the way cards and reports name keys ("...mFuf", "…z2k0").
export const KEY_TAIL = /(?:\.{3}|…)\s?([A-Za-z0-9]{4,8})\b/g;
export const VAULT_UNLOCK_ASK = /\b(?:unlock|open)\b[^.\n]{0,30}\bvault\b|\bvault\b[^.\n]{0,30}\bunlock|ξεκλείδ[^.\n]{0,30}vault|vault[^.\n]{0,30}ξεκλείδ/i;
/** 2/11 rule 5: a card asking the operator for a one-time code (2FA, OTP, SMS, a login or verification code). */
// Setting up an authenticator key (a setup QR or secret key) is no code to type.
const TOTP_SETUP = /\bqr\b|authenticator key|\b(?:setup|secret) key\b|\bimport\b[^\n]{0,60}\bvault\b/i;
const CODE_ASK = /\b2fa\b|\bmfa\b|\botp\b|one[- ]time (?:code|password)|(?:verification|security|login|sign[- ]?in|confirmation) code|\bsms\b|κωδικ[όο]ς? (?:επαλήθευσης|μιας χρήσης)/i;
export const codeAsk = (texts: string[]) => CODE_ASK.test(texts.join("\n")) && !TOTP_SETUP.test(texts.join("\n"));
/** A `checked` item saying the mailbox was read for it. */
export const MAIL_READ = /\b(?:e-?mails?|mail(?:box)?|inbox|gmail)\b|αλληλογραφ|εισερχ/i;
/** Step 23: a card about signing in, a bot check or a browser handoff (or of such a kind: SIGN_IN, LOGIN, CAPTCHA, HANDOFF). */
const HANDS_ACCOUNT_ASK = /\bsign[-_ ]?in|\blog[-_ ]?in|captcha|i am human|verify (?:that )?you are human|bot check|turnstile|puzzle|hand-?off|σύνδεσ|συνδέσ|συνδεθ|παζλ/i;
/** A card asking for a one-time code is mid sign-in at a site that sent it: no account check (mailCodeHold reads those). */
const ONE_TIME_CODE = /\bcodes?\b|\botp\b|\b2fa\b|\bmfa\b|passcode|κωδικ/i;
/** A `checked` item saying the account exists, or how. */
const ACCOUNT_KNOWN = /\baccount (?:exists|is open|was created|created)\b|\bsigned up\b|\bregistered\b|λογαριασμ[όο]ς υπάρχει/i;
/** An applicant tracking system's guest apply page takes an application with no account, so its bot check is no account's (Lever, Greenhouse, Ashby, Workable, BambooHR, iCIMS, Workday). */
const ATS_GUEST_APPLY = /^https?:\/\/(?:jobs\.lever\.co\/[^?#\s]+\/apply\b|(?:boards|job-boards)\.greenhouse\.io\/|jobs\.ashbyhq\.com\/|apply\.workable\.com\/|[a-z0-9-]+\.bamboohr\.com\/careers\b|(?:[a-z0-9-]+\.)*icims\.com\/|(?:[a-z0-9-]+\.)+myworkdayjobs\.com\/[^?#\s]*\/apply\b)/i;
/** A `checked` item naming a guest form (no account there): "guest form: <url>". */
const GUEST_FORM = /^\s*guest form:\s*https?:\/\//i;
/** Card-entry items only: a checkout or billing page or URL, a card form or number, adding a payment method, an amount to pay; a bare "card", payout or Connects is none (R83-1). */
export const CHECKOUT_PAYMENT_ASK = new RegExp([
  // An identity, 2FA, sign-in or pairing page under a payments path, and an "ID card", are no card entry.
  String.raw`\bcheck-?out\b|https?:\/\/(?!\S*(?:identity|verif|2fa|two-?factor|security|log-?in|sign-?in|pair))\S*\b(?:billing|payments?|pay)\b`,
  String.raw`(?<!\b(?:id|identity)\s)\b(?:billing|payment|card|credit card|debit card)\s+(?:page|form|details|info(?:rmation)?|fields?|input|entry)\b`,
  String.raw`\b(?:credit|debit) card\b|\bcard\s*(?:number|no\.?|#)|\bcvc\b|\bcvv\b|\bexpiry date\b`,
  String.raw`\badd\s+(?:a\s+|the\s+)?(?:new\s+)?(?:payment method|card|credit card|billing)\b`,
  String.raw`(?<!\b(?:did|have|has) (?:you|they|we) )\b(?:pay|paying|purchase|buy|top[ -]?up|charge[sd]?)\b[^.\n]{0,40}?(?:[$€£]\s?\d|\d[\d.,]*\s?(?:usd|eur|€|connects?|credits?)\b)`,
  String.raw`\b(?:amount|total)\s+(?:to pay|due)\b|\b(?:buy|purchase)\b[^.\n]{0,40}?\bconnects\b`,
  String.raw`(?:στοιχεί?α|αριθμ\S*|φόρμα|φορμα|πεδία|πεδια)\s+κ[άα]ρτας|πληρωμ\S*\s+(?:με|μέσω|μεσω)\s+κ[άα]ρτα`,
  String.raw`(?:πλήρωσε|πληρωσε|πληρώστε|πληρωστε)(?!\p{L})[^.\n]{0,40}?(?:[$€£]\s?\d|\d[\d.,]*\s?€)`,
].join("|"), "iu");
/** R83-1: intermediate steps an agent must complete before bringing the operator to the card-input form. */
export const CHECKOUT_INTERMEDIATE_STEP = /\b(?:log[ -]?in|sign[ -]?in|cloudflare|turnstile|captcha|bot check|select\b[^.\n]*(?:package|bundle|tier|plan)|choose\b[^.\n]*(?:package|bundle|tier|plan))\b|σύνδεσ|συνδεθ|επιλογή πακέτου/i;
/** R83-1: a `checked` item confirming the browser is already at the final card-input form. */
export const CHECKOUT_CARD_FORM_READY = /\b(?:final\b[^.\n]*(?:card|payment|checkout|form)|card(?:[ -]?input)?\b[^.\n]*(?:form|fields?|page)|at the (?:card|checkout|payment)|page open at (?:card|checkout|payment)|card details|form open)\b|φόρμα κάρτας|πεδία κάρτας/i;
/** A card entry is handed over as focus on the card field, never as steps for the operator (enter it yourself, open the page, a new tab, press Pay) (nous_msg:866da6d6). */
export const CARD_ENTRY_STEPS = /\benter (?:it|them|the card|your card) yourself\b|\bopen (?:the|its|a|this)\b[^.\n]{0,30}\b(?:page|tab|link|url)\b|\bnew tab\b|\b(?:press|click|tap|hit)\s+(?:the\s+)?["«“']?(?:pay|subscribe|buy|purchase|place order)\b|(?:^|\s)1[.)]\s[\s\S]*?(?:^|\s)2[.)]\s/i;
/** R83-1: a `checked` item naming the verified amount or package/tier on the live page. */
export const CHECKOUT_VERIFIED_AMOUNT_TIER = /\b(?:\$|€|£|\b(?:usd|eur)\b|\d+\s*(?:connects?|credits?|tokens?)|amount|total|tier|package)\b/i;
export interface AccountEvidence {
  /** Mail with the site's domain in the connected mailboxes: null when that cannot be told (an own or mail-provider domain, a failed read). */
  mail?(owner: string, site: string): Promise<boolean | null>;
  signins?: Pick<SiteSigninsRepository, "list">;
  vaultLogins?(owner: string, site: string): Promise<number>;
}
/** A sign-in, bot-check or handoff card goes to the operator only when the site shows an account (mail from its domain, a working Space sign-in, a Vault login, or `checked`); unknown passes. */
export async function accountHold(evidence: AccountEvidence, owner: string, card: { text: string; target?: string | null; checked?: readonly string[] }): Promise<string | null> {
  if (!HANDS_ACCOUNT_ASK.test(card.text) || ONE_TIME_CODE.test(card.text) || (card.checked ?? []).some((line) => ACCOUNT_KNOWN.test(line) || GUEST_FORM.test(line))) return null;
  const page = card.target?.startsWith("url:") ? card.target.slice(4) : undefined;
  const links = [...(page ? [page] : []), ...[...card.text.matchAll(/\bhttps?:\/\/[^\s"'<>)\]]+/gi)].map((match) => match[0])];
  if (BOT_CHECK_ASK.test(card.text) && links.some((link) => ATS_GUEST_APPLY.test(link))) return null;
  const sites = [...new Set(namedSites(page, page ? [] : [card.text]).flatMap((host) => { try { return [siteSigninDomain(host)]; } catch { return []; } }))];
  if (!sites.length) return null;
  const records = evidence.signins ? await evidence.signins.list(owner).catch(() => null) : null;
  for (const site of sites) {
    if (!records || records.some((record) => record.site === site && record.successCount > 0)) return null;
    if (!evidence.vaultLogins || await evidence.vaultLogins(owner, site).catch(() => 1) > 0) return null;
    if (!evidence.mail || await evidence.mail(owner, site).catch(() => null) !== false) return null;
  }
  return `Not raised: nothing shows an account at ${sites.join(", ")}: no mail with ${sites.length === 1 ? "that domain" : "those domains"} in the connected mailboxes `
    + "(30 days), no sign-in by Space that worked there and no Vault login. Check that the account exists, or create it first (sign up with the "
    + "address the task uses, read the site's welcome or code mail, save the login in the Vault and record the sign-in); find out what the site "
    + "refuses before asking for a bot check (6/11: the operator ticked one five times while the site rejected the address). Then raise only the "
    + "step that needs the operator. If the account exists, say how in `checked` (\"account exists: …\"). Nothing raised.";
}
/** 7/11 REVIEW item 1: a card asking for a bot check (CAPTCHA, "I am human", Turnstile, a puzzle). */
export const BOT_CHECK_ASK = /captcha|i am human|i'm human|(?:verify|confirm) (?:that )?you are human|not a robot|bot check|turnstile|puzzle|παζλ|ρομπότ/i;
/** A line saying the page's fields are filled and only the bot check is left. */
const FORM_FILLED = /\b(?:all|every|each)\b[^.\n]{0,20}\bfields?\b[^.\n]{0,20}\bfilled|\b(?:form|fields?)\b[^.\n]{0,30}\b(?:filled|completed)\b|\bonly (?:the )?(?:captcha|bot check|puzzle|check)\b[^.\n]{0,20}\b(?:left|remains)|συμπληρώθηκ|συμπληρωμέν/i;
/** A bot-check card goes to the operator only once its text or `checked` says every field is filled; the operator gives focus only for the CAPTCHA. */
export function botCheckHold(card: { text: string; checked?: readonly string[] }): string | null {
  if (!BOT_CHECK_ASK.test(card.text) || [card.text, ...card.checked ?? []].some((line) => FORM_FILLED.test(line))) return null;
  return "Not raised: a bot check comes last. Fill every field of the page yourself first (the Vault, Space Memory, the task's facts; what none of them "
    + "holds goes to the operator as one list before the page), up to the bot check, and keep the page fresh. Then raise the card for the bot check "
    + "alone and say so in `checked` (\"all fields filled: …\") (7/11: the operator answered «fill everything, give focus only for the CAPTCHA» on "
    + "UpCloud, YZi, lablab, Oracle and Vonage cards). Nothing raised.";
}
/** An ask that needs the operator's hands on hardware: USB or other physical media, or a server's own screen or console. */
const PHYSICAL_ASK = /(?:^|\s)(?:to|on|onto|into|from|σε|από|στο) (?:a |an |the |ένα )?USB\b|\bUSB (?:stick|drive|key|disk|flash)|flash drive|thumb drive|στικάκι|physical (?:media|access|console|disk|drive|key)|(?:local|physical|serial|server'?s?|host'?s?) (?:console|screen|monitor|keyboard)|φυσικ(?:ό|ή) (?:μέσο|πρόσβαση)|τοπική κονσόλα|οθόνη του (?:server|host)/i;
/** The operator has only a PC and a phone, so a card or decision asking for USB, physical media or a server's local screen is refused unless `checked` holds the operator's order. */
export function physicalAskHold(card: { text: string; checked?: readonly string[] }): string | null {
  if (!PHYSICAL_ASK.test(card.text) || (card.checked ?? []).some((item) => OPERATOR_ORDER_ID.test(ORDER_ITEM.exec(item)?.[1] ?? ""))) return null;
  return "Not raised: the operator has only a PC and a phone, no USB, physical media or server screen within reach. Offer a step they can take there: "
    + "a file downloaded to the PC (Agent Files or the app), an escrow copy in the Vault or cloud storage, a console the browser opens. "
    + "Only the operator's own order in `checked` (\"operator order nous_msg:<id>\") raises it as written. Nothing raised.";
}
/** A card or decision asking the operator for a document (statement, certificate, invoice, tax notice); the Greek certificate stem matches only at a word start, not inside the word for confirmation (DEV3D-035). */
export const DOCUMENT_ASK = /\b(?:download|send|upload|give|provide|share|attach|need)\b[^.\n?]{0,60}\b(?:statements?|certificates?|invoices?|receipts?|tax\s+(?:forms?|returns?|notices?)|documents?|pdf)\b|εκκαθαριστικ|(?<!\p{L})βεβαίωσ|αποδεικτικ|κίνηση\s+λογαριασμ/iu;
// The card-shape rules (focus-need.ts's (c) and the 21/11 no-question gate) live here so tools.ts imports no focus-need module (cycle).
export const FOCUS_REFUSED = (why: string) => `Not raised: ${why} (operator rule 13/11 nous_msg:83c0acb8: focus only when it is needed, for a CAPTCHA the internal solver cannot pass or data the agent cannot know, such as a card). Nothing raised.`;
export const DATA_ASK = /\b(?:your|the operator'?s)\s+(?:(?:full|legal)\s+name|(?:phone|mobile|telephone)\s+number|(?:home\s+|postal\s+|billing\s+|street\s+)?address|post\s?code|zip(?:\s+code)?|iban|vat(?:\s+(?:number|id))?|tax\s+(?:id|number)|date\s+of\s+birth|birth\s?date|passport(?:\s+number)?|id\s+(?:card\s+)?number|national\s+id|bank\s+account(?:\s+number)?|e-?mail\s+address)\b|τηλέφωνό\s+σου|διεύθυνσή\s+(?:σου|σας)|(?<!\p{L})(?:ΑΦΜ|ΑΜΚΑ)(?!\p{L})|ημερομηνία\s+γέννησης|διαβατηρίου|αριθμό\s+ταυτότητας/iu;
const STEP_VERB = String.raw`(?:open|go\s+to|visit|navigate|click|tap|press|hit|select|choose|pick|enter|type|paste|fill|sign\s+in|log\s+in|copy|scroll|approve|confirm|accept|tick|upload|download|install|run|switch|ανοίξτε|άνοιξε|πήγαινε|πάτα|πατήστε|πάτησε|επίλεξε|επιλέξτε|γράψε|πληκτρολόγησε|συνδέσου|μπες|κάνε\s+κλικ|αντίγραψε|επικόλλησε|βάλε)(?!\p{L})`;
const NUMBERED_STEP = new RegExp(String.raw`(?:^|\s)(?:\d{1,2}[.)]|step\s+\d{1,2}:?|βήμα\s+\d{1,2}:?)\s*(?:then\s+)?${STEP_VERB}`, "giu");
const STEPS_LABEL = /(?:^|\n)\s*(?:steps|instructions|βήματα|οδηγίες)\s*:/iu;
const WHEN_QUESTION = /\b(?:when|what time)\b[^?\n]{0,60}\b(?:focus|bring you|hand (?:it )?over|(?:are|will) you (?:be )?(?:free|available|around))\b|(?:πότε|τι ώρα)(?!\p{L})[^?\n]{0,60}(?:focus|διαθέσιμ|ελεύθερ|μπορείς)/iu;
const NOW_OPTION = /^\s*(?:(?:right|go)\s+)?now(?![a-z])|^\s*τώρα/i;
const TIME_OPTION = /\b(?:later|tonight|tomorrow|this (?:evening|afternoon|morning)|in the (?:evening|afternoon|morning)|batch|\d{1,2}:\d{2}|\d{1,2}\s?(?:am|pm))\b|(?:^|\s)at \d{1,2}\b|αργότερα|απόψε|αύριο|το (?:βράδυ|πρωί|απόγευμα)|στις \d/i;
// Cards asking whether the operator is ready now miss: the operator wants the act and its link (nous_msg:d1f0bc5e).
const READY_QUESTION = /(?:\bare\s+you\s+ready\b|\bready\s+now\b|(?:^|[:\n]\s*)ready\s+to\b|(?:είσαι|είστε)\s+[εέ]τοιμ\p{L}*|[εέ]τοιμ(?:ος|η|οι)\s+τώρα)[^?;\u037e\n]{0,240}[?;\u037e]/iu;
// Readiness offered as an option ("Ready now") still predicts readiness, so a card asking the act itself missed too.
const READY_OPTION = /^\s*(?:i'?m\s+|i\s+am\s+|είμαι\s+)?(?:ready\s+(?:now|to)\b|[εέ]τοιμ(?:ος|η|οι)(?!\p{L})|[εέ]τοιμ\p{L}*\s+τώρα)/iu;
// Cards asking whether or when the operator will do the act always missed; the operator wants it opened with focus, done by the agent, or its link (plan clipboard:USQ6ktIIN_1D).
const WILL_YOU_QUESTION = /(?:\bwill\s+you\b|\bwhen\s+(?:do|can|could|would|are)\s+you\b|(?:^|[\s«"(])πότε\s+\p{L}+(?:εις|είς|άς)(?!\p{L})|\b(?:can|could)\s+you\b[^?\n]{0,200}\bnow\b|(?:^|[\s«"(])θα\s+\p{L}+εις(?!\p{L})|\p{L}+(?:εις|είς|άς)\s+(?:ξανά|τώρα)(?!\p{L}))[^?;\u037e\n]{0,240}[?;\u037e]/iu;
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** What the card asks the operator, without what it says was checked: Nous's items, or the agent's summary, needs and options. */
export function cardAsk(input: Pick<NotificationRaiseInput, "title" | "body" | "payload">): { texts: string[]; options: string[][]; steps: string[] } {
  const items = Array.isArray(input.payload?.items) ? input.payload.items as Array<Record<string, unknown>> : null;
  if (items) return { texts: [input.title, ...items.flatMap((item) => [item.text, item.question].filter((text): text is string => typeof text === "string"))],
    options: items.map((item) => stringList(item.options)), steps: items.flatMap((item) => stringList(item.steps)) };
  return { texts: [input.title, input.body], options: [stringList(input.payload?.options)], steps: [] };
}

/** (c) Steps for the operator or a time of day for the focus; the operator's own order in `checked` overrides. */
export function stepsOrTimingRefusal(ask: ReturnType<typeof cardAsk>): string | null {
  const text = ask.texts.join("\n");
  if (ask.steps.length || (text.match(NUMBERED_STEP)?.length ?? 0) >= 2 || STEPS_LABEL.test(text)) {
    return FOCUS_REFUSED("a card carries no steps for the operator. Do every step yourself up to the one only they can do, then hand them focus there with no list");
  }
  if (WHEN_QUESTION.test(text) || ask.options.some((options) => options.some((option) => NOW_OPTION.test(option)) && options.some((option) => TIME_OPTION.test(option)))) {
    return FOCUS_REFUSED("focus is never scheduled for a time of day. Raise the card when the step is ready, and only then");
  }
  if (READY_QUESTION.test(text) || ask.options.some((options) => options.some((option) => READY_OPTION.test(option)))) {
    return FOCUS_REFUSED("a card never asks whether the operator is ready. Ask for the act itself with its link or target (a fresh code, link or QR made the moment they press Go now is fine); they answer by doing it");
  }
  if (WILL_YOU_QUESTION.test(text)) {
    return FOCUS_REFUSED("a card never asks whether or when the operator will do the act. Do it yourself when the Vault, mail or memory hold what it needs; otherwise bring the page to the one step only they can do and ask for that act with its link (\"Enter the card at the Cartesia checkout\"); they answer by doing it");
  }
  return null;
}

// A card asks a concrete question or names the act only the operator can do; status, FYI, words for Nous or an after-the-fact "did you do it?" are no card.
const NO_ASK = (why: string) => `Not raised: ${why} (operator 21/11: a card asks the operator something, a concrete question with options and your recommendation, `
  + "or the act only they can do with its link; status, FYI and what is done or decided go to a report or log, never a card). Nothing raised.";
// A Greek question often ends in a plain semicolon, after a Latin word too («…για την INTRATRADE;»).
const QUESTION = /\?(?![\w%.-]*=)|\u037e|\p{Script=Greek}[»"')]?;(?=\s|$)|;[»"')]*\s*$/mu;
const ACT_VERB = String.raw`(?:${STEP_VERB}|(?:solve|scan|pair|link|pay|sign|give|send|provide|reply|answer|review|decide|allow|grant|verify|complete|enable|turn\s+on|insert|plug|touch|record|join|attend|take|call|add|set|connect|authori[sz]e|unlock|reset|renew|top\s+up|share|forward|check|read|decline|reject|δώσε|δώστε|στείλε|στείλτε|σάρωσε|σκάναρε|έγκρινε|εγκρίνετε|άναψε|ανάψτε|ενεργοποίησε|ενεργοποιήστε|απάντησε|απαντήστε|συμπλήρωσε|πλήρωσε|υπόγραψε|επιβεβαίωσε|επιβεβαιώστε|αποδέξου|διάλεξε|σύνδεσε|συνδέστε|έλεγξε|ελέγξτε|ανέβασε|κατέβασε|τρέξε|ακύρωσε|διάβασε)(?!\p{L}))`;
// An imperative at the start of a sentence: "Approve the npm sign-in…", "The build is ready. Press Link SpaceApp…".
const ACT = new RegExp(String.raw`(?:^|[\n.!:—–]\s*)(?:please\s+|παρακαλώ\s+)?${ACT_VERB}`, "iu");
// The act named as what the card waits for: "The key needs your approval on the site".
const YOUR_ACT = /\b(?:needs?|waits?\s+(?:for|on))\s+your\s+(?:approval|sign[- ]?in|log[- ]?in|signature|consent|security\s+key|passkey|fingerprint|code)\b/i;
// After the fact: "Did you turn both switches on?", «Άναψαν και οι δύο διακόπτες;» (card fc39ac2e). The operator acted or not; the pane reads it.
const DONE_QUESTION = /(?:\bdid\s+you\b|\bhave\s+you\s+(?:already\s+)?\p{L}+(?:ed|en|t)\b|\bis\s+it\s+(?:done|on|set)\b|(?:^|[\s«"(])(?:το\s+)?(?:έκανες|εκανες|έγινε|εγινε|άναψαν|άναψε|ολοκλήρωσες|πάτησες|ενεργοποίησες|ενεργοποιήθηκ\p{L}*|μπήκες|συνδέθηκες)(?!\p{L}))[^?;;\n]{0,240}[?;;]/iu;
// A note addressed to Nous or an agent ("Nous: through space_remote act, hand Nik…", card 32dff8fe): their work, never the operator's card.
const TO_AGENT = /^\s*(?:nous|agent)\s*[:,]|\b(?:through|via)\s+(?:the\s+)?space_[a-z_]+/i;

/** A card with no question and no act only the operator can do; the operator's own order in `checked` overrides (as in focusNeedHold). */
export function noQuestionRefusal(ask: ReturnType<typeof cardAsk>): string | null {
  const texts = ask.texts.filter(Boolean);
  if (texts.some((text) => TO_AGENT.test(text))) return NO_ASK("these words are for Nous or an agent. Do that work yourself (or send it to the pane); the operator gets a card only for what they must answer or do");
  const text = [...texts, ...ask.steps].join("\n");
  if (DONE_QUESTION.test(text)) return NO_ASK("a card never asks whether the operator did something. Read the page, setting or pane yourself; if it is not done, ask for the act itself with its link");
  if (QUESTION.test(text) || ACT.test(text) || YOUR_ACT.test(text) || CHECKOUT_PAYMENT_ASK.test(text) || BOT_CHECK_ASK.test(text) || DATA_ASK.test(text) || DOCUMENT_ASK.test(text)
    // 27/11 (the Crosschq ID.me card took 3 tries): an identity check or the operator's own interview or test is an act only they can do, however worded.
    || needsOperatorHandsText(text)) return null;
  return NO_ASK("it has no question and no act for the operator. Put the concrete question (\"Which plan do we buy?\") with options and your recommendation, or the act only they can do (\"Approve the npm sign-in at the link\")");
}
const DOCUMENT_SOURCES: Array<[string, RegExp]> = [["a mail search", /\bmail|inbox|gmail|αλληλογραφ/i],
  ["a try at the portal that issues it (AADE, the bank's e-banking)", /portal|\baade\b|taxis|e-?banking|web\s?banking|internet\s+banking|gov\.gr|signed\s+in|logged\s+in/i]];
/** An agent fetches a document itself: why an ask for one waits (sources `checked` does not name yet) or null; the operator's order overrides. One rule for agents' cards (focusNeedHold) and Nous's decisions. */
export function documentAskMissing(text: string, checked: readonly string[] = []): string | null {
  if (!DOCUMENT_ASK.test(text) || checked.some((item) => OPERATOR_ORDER_ID.test(ORDER_ITEM.exec(item)?.[1] ?? ""))) return null;
  const missing = DOCUMENT_SOURCES.filter(([, named]) => !checked.some((line) => named.test(line))).map(([name]) => name);
  return missing.length ? `an agent fetches a document itself. Name ${missing.join(" and ")} and what each showed in \`checked\`; ask only for the step only the operator can do there (a sign-in, a code)` : null;
}
const SLIDER_ASK = /\bslider\b|\bslide (?:to|the|it)\b|\bdrag (?:the )?(?:slider|piece|bar|puzzle)|σύρ[εσ]|ολισθ/i;
/** Options that only acknowledge ("OK", "Noted", «Εντάξει»): no choice, so the card still needs a question. */
export const ACK_OPTION = /^\s*(?:ok(?:ay)?|got it|noted|seen|thanks|fine|ack(?:nowledged)?|εντάξει|οκ|ok|το είδα|ενημερώθηκα|ευχαριστώ)\s*[.!]?\s*$/iu;
/** A decision's title is its yes/no proposal ("Restart the build VM"); a title that reports ("… are on", "… waits on you", "FYI") proposes nothing. */
export const REPORT_TITLE = /\b(?:is|are|was|were|has|have|had|did|waits?\s+on\s+you|fyi|status|update|done|finished|completed|ready)\b|για\s+ενημέρωση|είναι|έγινε|ολοκληρώθηκε|περιμένει/iu;
export const FAILED_ANSWER = /^(?:failed|απέτυχε)/i;
const AT_COMPUTER = /\b(?:computer|desktop|pc|laptop)\b|υπολογιστ/i;
/** A slider card the operator answered "Failed" within 7 days waits for a computer; `form` is the answering device, a desktop "Failed" holds nothing, one with no device counts. */
export async function phoneSliderHold(card: { text: string; checked?: readonly string[] },
  answers: () => Promise<ReadonlyArray<{ title: string; answer: string; at: string; form?: string | null }>>): Promise<string | null> {
  if (!SLIDER_ASK.test(card.text) || (card.checked ?? []).some((line) => AT_COMPUTER.test(line))) return null;
  const failed = (await answers()).find((row) => FAILED_ANSWER.test(row.answer.trim()) && row.form !== "DESKTOP" && sameCardSubject(row.title, card.text));
  if (!failed) return null;
  return `Not raised: the operator answered "Failed" to "${clipText(failed.title, 100)}" at ${failed.at.slice(0, 16).replace("T", " ")} UTC${failed.form ? ` from a ${failed.form.toLowerCase()}` : ""}; a drag slider fails on a phone's touch screen. `
    + "Solve it in the pane (space_browser_slider_captcha), or hold the card until they are at a computer and raise it then with `checked` saying so "
    + "(\"at a computer: …\"). Nothing raised.";
}
const CHANGED_LINE = /^\s*(?:changed|what changed|(?:τι )?(?:αλλαξε|άλλαξε))\s*:/i;
/** A card on a subject the operator answered "Failed" within 7 days fails the same way and waits until `checked` names what changed ("changed: …"); sliders stay with phoneSliderHold. */
export async function failedRepeatHold(card: { text: string; checked?: readonly string[] },
  answers: () => Promise<ReadonlyArray<{ title: string; answer: string; at: string }>>): Promise<string | null> {
  if (SLIDER_ASK.test(card.text) || (card.checked ?? []).some((line) => CHANGED_LINE.test(line))) return null;
  const failed = (await answers()).find((row) => FAILED_ANSWER.test(row.answer.trim()) && sameCardSubject(row.title, card.text));
  if (!failed) return null;
  return `Not raised: the operator answered "Failed" to "${clipText(failed.title, 100)}" at ${failed.at.slice(0, 16).replace("T", " ")} UTC; the same ask fails the same way. `
    + "Find why it failed (the site's error, the open case, the mail it waits on) and clear that first; raise it again only with a `checked` line "
    + "\"changed: <what is different now>\". Nothing raised.";
}
const SITE_BLOCKED = /\bblock(?:s|ed|ing)?\b|security risk|unusual activity|μπλοκ/i;
const BLOCKED_WHERE = /\b(?:server|ip|network|connection|datacenter|data center|(?:your|own|another) (?:own )?(?:device|pc|computer))\b|σέρβερ|δίκτυ|συσκευ/i;
// DEV3D-017: the block is a site's on an account or sign-in, not an ops card's "deploy blocked … server".
const SITE_ACCESS = /sign[- ]?(?:up|in|on)|log[- ]?in|\baccount|captcha|registration|εγγραφ|σύνδεσ|λογαριασμ/i;
const VPN_ROUTE = /\b(?:vpn|mullvad|nord(?:vpn)?|greece|thailand)\b/i;
/** A card handing the operator a site that blocked this server waits until the pane tried a CLI VPN route. */
export function vpnRouteHold(card: { text: string; checked?: readonly string[] }): string | null {
  const text = [card.text, ...card.checked ?? []].join("\n");
  if (!SITE_BLOCKED.test(card.text) || !BLOCKED_WHERE.test(card.text) || !SITE_ACCESS.test(card.text) || DEVICE_APPROVAL.test(card.text) || VPN_ROUTE.test(text)) return null;
  return "Not raised: the site blocked this server, and no CLI VPN route was tried. Have the pane retry on the routes (space_browser_set_route mullvad, nord, "
    + "greece, thailand, with a fresh profile); raise it again only if every route is blocked, naming them in `checked` (\"vpn: mullvad, nord … blocked\"). Nothing raised.";
}
export const CARD_ENTRY_STEPS_REFUSAL = "Not raised: a card entry is never a list of steps for the operator (open the page, a new tab, enter it yourself, press Pay). "
  + "The pane does every step up to the card field; once the card field is open, it hands them focus on that field (space_focus_pane, a browser handoff) with no steps. Nothing raised.";
/** A card-entry ask with steps in its text or the agent's report file is refused; the focus handoff at the card field replaces it. */
export function cardEntryStepsHold(card: { text: string; report?: string }): string | null {
  return CHECKOUT_PAYMENT_ASK.test(card.text) && CARD_ENTRY_STEPS.test(`${card.text}\n${card.report ?? ""}`) ? CARD_ENTRY_STEPS_REFUSAL : null;
}
/** The first sentence setting focus for a time of day or after an event, or null; quoted and negated sentences set none, and a bare "at HH:MM" is left out as past events read the same (nous_msg:83c0acb8). */
const TIMED_FOCUS_WHEN = new RegExp([
  String.raw`(?<!\p{L})(?:γυρω|περιπου|μετα|ως|εως|πριν)(?: απο)? (?:(?:τις|στις) \d{1,2}(?:[:.]\d{2})?(?!\d)|\d{1,2}[:.]\d{2})`,
  // DEV3D-040: English times take a colon or am/pm (DEV3D-051: "6.30pm"); "about 12.50 USD" or "after 1.12 shipped" is a price or a version.
  String.raw`\b(?:around|about|after|by|until|before)\s+\d{1,2}(?::\d{2}|(?:[:.]\d{2})?\s?[ap]\.?m\b)`,
  String.raw`\bafter (?:the |your |his |her |their )?(?:interviews?|meetings?|calls?)\b|(?<!\p{L})(?:μετα (?:τις|τη|την|το|τα)|αφου τελειωσ\p{L}* (?:οι |τα |η |το )?) ?(?:συνεντευξ|συναντησ|κλησ|ραντεβου)`,
  String.raw`\b(?:later today|tonight|tomorrow|this (?:evening|afternoon|morning))\b|(?<!\p{L})(?:αποψε|αυριο|αργοτερα σημερα)`,
].join("|"), "u");
// A space_nous_outcome summary (accents folded) that opens by calling itself a repeat: "Duplicate of …", "Same correction: …", "Again?! …" or the Greek forms.
export const SELF_REPEAT = /^[^\p{L}\p{N}]*(?:duplicate|repeat(?:ed|s)?|same (?:correction|complaint|request|mistake)|again|ιδι[αοε]\p{L}* (?:διορθωσ|παραπον|αιτημ|λαθ)\p{L}*|επαναληψ\p{L}*|ξανα)(?!\p{L})/u;
// The operator's "only"/"just" clause (Greek forms too) limits the act and "nothing else" limits the clause before it; "by yourself", "not only", "only if" and "only <number>" limit nothing.
const SCOPE_LIMIT = /(?<![\p{L}\p{N}])(?:μ[οό]ν[οό]|only|απλ[αά]|απλ[ωώ]ς)(?![\p{L}\p{N}])/giu;
const SCOPE_NOTHING_ELSE = /(?<![\p{L}\p{N}])(?:τ[ιί]π[οό]τα [αά]λλο|nothing else)(?![\p{L}\p{N}])/giu;
const SCOPE_SIGN_OFF = /^(?:ok|οκ|ενταξει|thanks?|thank you|ευχαριστω|ναι|yes|no|οχι)$/u;
const SCOPE_CUT = /[.!?;:,()·\n]|\s-{2,}|-{3,}/u;
const SCOPE_NOT_BEFORE = /(?:^|[^\p{L}])(?:οχι|not|απο|δεν (?:ειναι|ηταν))\s*$/u;
// «απλά δεν δουλεύει» ("it simply doesn't work") is a complaint, not a limit; «απλά μην …» still limits.
const SCOPE_NOT_AFTER = /^(?:(?:σου|του|της|μου|τους|εσυ|αν|οταν|if|when|δεν|δε)(?![\p{L}\p{N}])|(?:\p{L}+\s+)?\d+\s*%)/u;
const SCOPE_STOP = new Set(["για", "στο", "στα", "στη", "στην", "στον", "στις", "των", "τον", "την", "της", "του", "τις", "και", "απο", "που", "οτι", "μου", "σου", "μας", "σας",
  "τους", "the", "for", "and", "with", "from", "that", "this"]);
const foldScope = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** The operator's limit clauses (as written) a brief keeps under half of the words of (a stem: a long word's first 4 letters). */
export function scopeLimitsLost(message: string, brief: string): string[] {
  const own = message.split("[[Attachments")[0]!;
  const said = foldScope(brief);
  const lost = (clause: string, label: string) => {
    const words = foldScope(clause).split(/[^\p{L}\p{N}]+/u).filter((word) => /\d/.test(word) || (word.length >= 3 && !SCOPE_STOP.has(word)));
    const kept = words.filter((word) => said.includes(word.length >= 5 ? word.slice(0, 4) : word)).length;
    return words.length && kept * 2 <= words.length ? [label] : [];
  };
  const after = [...own.matchAll(SCOPE_LIMIT)].flatMap((match) => {
    const clause = own.slice(match.index + match[0].length).split(SCOPE_CUT)[0]!.trim().split(/\s+/).slice(0, 6).join(" ");
    const folded = foldScope(clause);
    if (!folded || SCOPE_NOT_AFTER.test(folded) || SCOPE_NOT_BEFORE.test(foldScope(own.slice(0, match.index)))) return [];
    return lost(clause, `${match[0]} ${clause}`);
  });
  const before = [...own.matchAll(SCOPE_NOTHING_ELSE)].flatMap((match) => {
    const clause = own.slice(0, match.index).replace(/[\s.!?;:,·\-–—]+$/u, "").split(SCOPE_CUT).at(-1)!.trim().split(/\s+/).slice(-6).join(" ");
    // A clause already holding "only"/"just" was named above; "Thanks, nothing else" closes a message and limits nothing.
    return !clause || SCOPE_SIGN_OFF.test(foldScope(clause)) || new RegExp(SCOPE_LIMIT.source, "iu").test(clause) ? [] : lost(clause, `${clause} ${match[0]}`);
  });
  return [...after, ...before];
}
// "Focus on step 3 until 14:00" is the pane's own work, not the operator's focus.
const TIMED_FOCUS_WORD = /(?<![\p{L}_])focus(?![\p{L}_])(?! on (?!(?:the |το |στο )?(?:card|field|form|pane|page|checkout)))|εστιασ/u;
const TIMED_FOCUS_NEGATED = /(?:^|\s)(?:δεν|μην|οχι|ουτε|not|never|no longer|instead of)(?=\s|$)/u;
// A negation counts only before the time ("δεν βάζω ώρα 13:00"); one after it ("... και μετά θα ελέγξω ότι δεν πάγωσε") negates something else.
const timedSentence = (word: RegExp) => (text: string): string | null => {
  const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").replace(/[*_`]/g, "").toLowerCase();
  return text.replace(/«[^»]*»|"[^"\n]*"|“[^”]*”/g, "\"\"").split(/(?<=[.!?;…])\s+|\n+/).map((sentence) => sentence.trim()).find((sentence) => {
    const plain = fold(sentence);
    const when = TIMED_FOCUS_WHEN.exec(plain);
    return word.test(plain) && when !== null && !TIMED_FOCUS_NEGATED.test(plain.slice(0, when.index));
  }) ?? null;
};
export const timedFocusSentence = timedSentence(TIMED_FOCUS_WORD);
/** Nous must not delay a promote without reason, e.g. by timing it after the operator's interviews (correction 87b8e25d). */
// At most one promote an hour, so a sentence tying the next one to that hour is not a timed promote.
const PROMOTE_HOURLY = /(?:μια|1|60) (?:ωρα|λεπτ)\p{L}* (?:μετα|απο) (?:το |τον |την )?(?:τελευται|προηγουμεν)|ανα ωρα|την ωρα|ωριαι|\b(?:an?|one|1) hour (?:after|since) the (?:last|previous)|\b60 min\p{L}* (?:after|since) the (?:last|previous)|\bper hour\b|\bhourly\b/u;
const timedPromote = timedSentence(/(?<![\p{L}_])promot/u);
export const timedPromoteSentence = (text: string): string | null => {
  const sentence = timedPromote(text);
  return sentence && PROMOTE_HOURLY.test(sentence.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()) ? null : sentence;
};
/** An error code a flow answered (STEP_UP_REQUIRED, PAIRING_FAILED, ...); upper case only, so prose about a failure does not count. */
const FLOW_ERROR_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:REQUIRED|FAILED|DENIED|FORBIDDEN|INVALID|EXPIRED|ERROR|UNAUTHORI[SZ]ED)\b/;
const FLOW_PROVEN = /\b(?:passe[sd]|works|worked|succeeded|verified|fixed)\b/i;
/** A card recommending acting now waits while its text or `checked` names an error code and no `checked` line shows the flow passing since; `ruleDiffers` lets it through. */
export function unprovenNowHold(items: ReadonlyArray<{ text: string; question?: string; recommended?: string; ruleDiffers?: string }>, checked: readonly string[] = []): string | null {
  for (const item of items) {
    if (!item.recommended || item.ruleDiffers || !/\bnow\b|τώρα|τωρα/i.test(item.recommended)) continue;
    const code = [item.text, item.question ?? "", ...checked].map((line) => FLOW_ERROR_CODE.exec(line)?.[0]).find(Boolean);
    if (!code || checked.some((line) => FLOW_PROVEN.test(line) && !FLOW_ERROR_CODE.test(line))) continue;
    return `The card recommends "${clipText(item.recommended, 80)}" while the flow it names answered ${code} and nothing in \`checked\` shows it passing since. `
      + "Fix it and prove it passes (say so in `checked`), or recommend waiting; nothing was raised. Only if going now is right despite it, raise the item again with ruleDiffers saying why.";
  }
  return null;
}
/** A Vault fill that missed its field (sealed-fill's own codes, or the words an agent writes for it), English or Greek. */
const VAULT_FILL_GAP = /\b(?:FIELD|QR)_NOT_FOUND(?:_AFTER_RELOAD)?\b|\bvault(?:'s)?(?: fill)? (?:cannot|can't|could not|couldn't|does not|doesn't|did not|didn't|fails? to|failed to) (?:fill|type)|\bvault fill (?:fails|failed)|vault\S* δεν (?:γεμίζ|συμπληρών|μπορεί να (?:γεμίσ|συμπληρώσ))/i;
/** A sign-in the Vault holds but cannot fill is Space's code to fix, never the operator's hands; `ruleDiffers` lets it through. */
export function vaultFillGapRefusal(texts: readonly string[]): string | null {
  const gap = texts.map((text) => VAULT_FILL_GAP.exec(text)?.[0]).find(Boolean);
  if (!gap) return null;
  return `"${gap}" is a Vault fill gap: Space's code to fix, never the operator's hands (operator 29/10 «Μην με ρωτας εμενα να περασω τους κωδικους», 27/11 NBG Business). `
    + "Brief a pane with the fix in apps/api/src/vault/sealed-fill.ts (the role it missed and the page's field markup), then the agent fills again. "
    + "Nothing was shown. Only if the operator must act despite it, raise the item again with ruleDiffers saying why.";
}
/** A sign-in or password card for a site whose login the Vault holds waits for the agent's fill and masked readout (signin-readback.ts) (nous_msg:fcea1c9e). */
export async function vaultReadBackHold(evidence: { signins?: Pick<SiteSigninsRepository, "list">; vaultLogins(owner: string, site: string): Promise<number | null> },
  owner: string, card: { text: string; target?: string | null }): Promise<string | null> {
  if (!VAULT_SIGNIN_ASK.test(card.text) || OPERATOR_HANDS.test(card.text)) return null;
  const page = card.target?.startsWith("url:") ? card.target.slice(4) : undefined;
  const sites = [...new Set(namedSites(page, page ? [] : [card.text]).flatMap((host) => { try { return [siteSigninDomain(host)]; } catch { return []; } }))];
  const records = sites.length && evidence.signins ? await evidence.signins.list(owner).catch(() => []) : [];
  for (const site of sites) {
    const step = await vaultSigninHold(owner, site, records.find((record) => record.site === site && record.accountLabel === "main") ?? null, () => evidence.vaultLogins(owner, site));
    if (step) return `Not raised: ${step} Nothing raised.`;
  }
  return null;
}
/** A `checked` item carrying the operator's explicit order for a reset: "operator order nous_msg:<id>". */
export const ORDER_ITEM = /\boperator order (nous_msg:[A-Za-z0-9_-]{6,80})\b/i;
/** A card, decision or support message asking a password reset or account recovery at a site whose stored sign-in works is refused unless `checked` holds the operator's order (nous_msg:fe72e061). */
export async function workingSigninHold(signins: Pick<SiteSigninsRepository, "list"> | undefined, owner: string,
  card: { text: string; target?: string | null; site?: string; checked?: readonly string[]; code?: boolean },
  totpSeed?: (site: string) => Promise<boolean | null>): Promise<string | null> {
  // A one-time code card that says "password filled" asks no reset, so only RESET_ASK holds it.
  const codeAsk = card.code || MFA_ASK.test(card.text);
  if (!signins || !(RESET_ASK.test(card.text) || (!codeAsk && SUPPORT_ASK.test(card.text) && /password|κωδικ/i.test(card.text)))) return null;
  const page = card.target?.startsWith("url:") ? card.target.slice(4) : card.site;
  const sites = [...new Set(namedSites(page, page ? [] : [card.text]).flatMap((host) => { try { return [siteSigninDomain(host)]; } catch { return []; } }))];
  if (!sites.length) return null;
  const order = (card.checked ?? []).map((item) => ORDER_ITEM.exec(item)?.[1]).find((id): id is string => Boolean(id && OPERATOR_ORDER_ID.test(id)));
  const records = await signins.list(owner).catch(() => []);
  for (const site of sites) {
    const record = records.find((entry) => entry.site === site && entry.accountLabel === "main") ?? null;
    // A one-time code is never a sign-in or reset: a `code` item passes where the stored MFA is the operator's authenticator or SMS and the Vault holds no TOTP seed for the agent to fill.
    if (card.code && PHONE_MFA.test(record?.mfa ?? "") && await totpSeed?.(site).catch(() => null) !== true) continue;
    const guard = resetRefusal(record, order);
    if (guard.refusal) return `Not raised: ${site}: ${guard.refusal} Nothing raised.`;
  }
  return null;
}
/** A site recipe's `mfa` naming a code only the operator's phone shows. */
const PHONE_MFA = /authenticator|\bsms\b|text message|phone|κινητ/i;
export const NOUS_MAIL_CODE_RULE = "a code that reaches a connected mailbox is an agent's (operator 2/11 10:15 BKK: Twitch 2FA and PayPal SMS cards whose codes also come by mail)";
const MFA_ASK = /\b(?:2fa|mfa|t?otp|one[- ]time (?:code|password|passcode)|two[- ]factor|2[- ]step|authenticator|verification code|security code|sign-in code|passcode)\b|κωδικ\S* (?:επαλήθευσης|επαληθευσης|μίας χρήσης|μιας χρησης|ασφαλείας|ασφαλειας)/i;
export const SUPPORT_ASK = /\b(?:password|reset|locked|access|support|recover(?:y)?)\b|υποστήριξ|υποστηριξ|κωδικ|επαναφορ/i;
// Handlers answer whole; a long answer is paged in execute (space_tool_result reads on), never cut (operator 31/10 «Βγάλε όλα τα όρια»).
export const clip = (text: string, max = Infinity) => text.length > max ? `${text.slice(0, max - 20)}\n…(truncated)` : text;
/** R65: what only the operator's hands do (sign in, a code, camera, ID, a call, pay, upload, video): a memory fact never answers such an item. */
export const CARD_HANDS = /sign[- ]?in|log[- ]?in|\bsign\b|signature|captcha|password|passcode|\b2fa\b|\botp\b|\bcode\b|camera|selfie|\bid\b|passport|\bcall\b|\bpay|upload|video|install|handoff|authenticator|ready|συνδ[εέ]σ|υπογρ|κωδικ|κ[αά]μερα|ταυτ[οό]τ|διαβατ|κλ[ηή]σ|τηλεφ[ωώ]ν[ηή]σ|τηλεφωνικ|πλ[ηή]ρω|αν[εέ]βα|β[ιί]ντεο|[εέ]τοιμ/i;
/** An item asking someone to send or approve a drafted mail, message or post (a dispatch verb with a draft word, or a thread: target); narrow on purpose. */
export const DRAFT_DISPATCH = /\b(?:send|dispatch|approve|post|publish|submit)\b|στ[εέ][ιί]λ|αποστολ|αποστ[εέ][ιί]λ|[εέ]γκρι|εγκρ[ιί]ν|δημοσ[ιί]ευ/i;
export const DRAFT_WORD = /\bdrafts?\b|πρ[οό]χειρ/i;
/** What stays the operator's hands even beside a draft: sign-in, 2FA, a CAPTCHA, a camera, a payment. */
export const DRAFT_HANDS = new RegExp(`${HANDS_SIGN_IN.source}|captcha|${OPERATOR_ONLY.source}`, "i");
/** An item asking for a phone number, and a labelled number in a memory, so a card never asks for a number memory holds (R66). */
export const PHONE_ASK = /\b(?:phone|mobile|telephone)\b|τηλ[εέ]φων|κινητ[οόή]/i;
export const PHONE_VALUE = /(?:phone|mobile|\btel\b|τηλ[εέ]φων\p{L}*|κινητ\p{L}*)[^\d+\n]{0,40}(\+?\d[\d ().-]{6,18}\d)/giu;
/** R66 (4/11 «δεν μου εμφανισε εκδοση σε κανενα απο τα 2 app»): a question about which app version is installed. */
export const APP_VERSION_ASK = /\bversion\b|\bv?\d+\.\d+\.\d+\b|[εέ]κδοσ/i;
// An item asking someone to run a command on a host, the hosts it names, and a memory entry's access words, so a card never asks for access memory holds.
// shortcut: hosts are IPs, dotted names and pve/vm/ct ids, add a fleet name the cards write otherwise.
export const RUN_ASK = /\b(?:run|execute|ssh|sudo|as root|root shell|command|shell)\b|εκτ[εέ]λεσ|τρ[εέ]ξ|εντολ/i;
export const HOST_NAMED = /(?<![\w.-])(?:\d{1,3}(?:\.\d{1,3}){3}|pve(?:-\w+)?|(?:vm|ct)\d+|[a-z][\w-]*(?:\.[a-z][\w-]+)+)(?![\w-])/gi;
export const ACCESS_WORDS = /\bssh\b|\broot\b|\bsudo\b|\baccess\b|πρόσβασ|προσβασ/i;
export const APP_WORD = /\b(?:app|apk|application)\b|εφαρμογ/i;
/** R66 (4/11 X @oll4com: σύνδεση while the Vault held an x.com login): an item asking someone to sign in (accents folded; «σύνδεσμος» is a link). */
export const SIGN_IN_ITEM = /\bsign(?:ing)?[ -]?in\b|\blog(?:ging)?[ -]?in\b|\blogin\b|συνδεσ(?!μ)|συνδεθ|συνδεου|\b(?:enter|type)\s+(?:in\s+)?(?:your\s+|the\s+)?(?:password|credentials)\b/;
/** An account's name (a login label), not an ask to sign in; case-sensitive on purpose. */
export const ACCOUNT_LABEL = /(?<!\p{L})(?:[Ll]ogin|LOGIN|[Σσ]ύνδεση)\s*:?\s+(?=\p{Lu}|\d)\S+/gu;
/** A site's name as cards write it: its host; in a text naming no host, its brand as a whole word, a one- or two-letter brand only in capitals; a named host decides alone (R66). */
/** Only a host the card names (its link, steps or url: target) is its site, since matching by word hits unrelated words and address fragments. */
export function namesSite(hosts: readonly string[], site: string): boolean {
  return hosts.some((named) => named === site || named.endsWith(`.${site}`) || site.endsWith(`.${named}`));
}
/** What names a card item's subject exactly: its ref (task, decision, notification), its target (page, thread or tab; bare browser/activity/setup names none) and the sites its words or page name. */
export function subjectKeys(item: { text?: unknown; question?: unknown; ref?: unknown; target?: unknown }): string[] {
  const text = (value: unknown) => typeof value === "string" ? value : "";
  // 13/11 (a root install card held as a resolved QR pairing card's subject): a site's bare home page names its host, not a subject.
  const home = (value: string) => { try { const url = new URL(value.slice(4)); return value.startsWith("url:") && url.pathname === "/" && !url.search && !url.hash; } catch { return false; } };
  const target = text(item.target).includes(":") && !home(text(item.target)) ? text(item.target) : "";
  return [...(text(item.ref) ? [`ref ${text(item.ref)}`] : []), ...(target ? [`target ${target}`] : []),
    // The site is its registrable domain: app.meridial.com and meridial.com are one site; namedSites gave only public hosts.
    ...new Set(namedSites(undefined, [text(item.text), text(item.question), target.startsWith("url:") ? target : ""]).map((site) => `site ${siteSigninDomain(site)}`))];
}

/** A Council run as Nous reads it: where it stands, what the coordinator asks, the plan, the answer and the plan record. */
export function councilRunText(run: CouncilRun): string {
  const open = run.qa.at(-1);
  const waiting = open && open.questions.some((question) => !(question.id in open.answers)) ? open.questions.filter((question) => !(question.id in open.answers)) : [];
  return [
    `${run.id} · ${run.status} · stage ${run.stage} · coordinator ${run.coordinatorModelId}${run.error ? ` · error: ${run.error}` : ""}`,
    `Question: ${run.question}`,
    waiting.length ? `Open questions (answer with space_council_answer):\n${waiting.map((question) => `- ${question.id}: ${question.text}`).join("\n")}` : null,
    run.plan ? [`Plan: ${run.plan.understanding}`, `Members: ${run.plan.members.map((member) => member.modelId).join(", ")} · review rounds ${run.plan.reviewRounds}`,
      `Criteria: ${run.plan.criteria.map((criterion) => criterion.label).join(", ")}`, `Personal text shared: ${run.plan.personalContext ? `"${run.plan.personalContext}"` : "none"}`,
      run.estimate ? `Estimate: ${run.estimate.calls} calls, about ${run.estimate.minutes} minutes` : null].filter(Boolean).join("\n") : null,
    run.final ? `Final answer (Top ${run.final.top.length}: ${run.final.top.map((entry) => `${entry.title} ${entry.mean.toFixed(1)}`).join("; ")}):\n${run.final.text}` : null,
    run.clipboardPlan ? `Clipboard plan: ${run.clipboardPlan.status}${run.clipboardPlan.itemId ? ` ${run.clipboardPlan.itemId}` : ""}${run.clipboardPlan.error ? ` (${run.clipboardPlan.error})` : ""}` : null,
    `Recent: ${run.events.slice(-4).map((event) => `${event.at.slice(11, 16)} ${event.text}`).join(" · ")}`
  ].filter(Boolean).join("\n");
}
export const norm = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/^@/, "").trim();
/** Levenshtein distance (a task id with a slip, Daily Nous errors 13/11). */
export const editDistance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
};


/** What Nous runs itself although the Room Agent asks first (operator request 2026-10-17): pane close/stop/restart, rooms, clipboard saves. */
function nousRunsItself(action: Record<string, unknown>): boolean {
  const kind = String(action.kind ?? "");
  const operation = String(action.operation ?? "");
  return (kind === "pane" && ["close", "restart", "stop", "cancel"].includes(operation))
    || (kind === "room" && ["create", "rename", "activate"].includes(operation))
    || (kind === "clipboard" && ["save", "complete"].includes(operation));
}

/** A copy of `record` without `keys`. */
export function without<T extends object, K extends keyof T>(record: T, ...keys: K[]): Omit<T, K> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !(keys as PropertyKey[]).includes(key))) as Omit<T, K>;
}
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

/** A space_execute batch for Nous is RUN, ASK (a SPACE_CONTROL decision run on the operator's yes: deletes, publishing, settings, CLI/VPN switches, tests, releases, third-party sends) or REFUSE (deploys: merge queue only). */
/** The pane id a pane ref holds ("pane:abc", "Andy (pane:abc)"), or null for a plain name. */
// A pane id may end in "-": a trailing \b would cut it off (CI 42885561245 read pane:mKVw4mfJ0JK- as pane:mKVw4mfJ0JK).
/** space_link_parity's answer, one line per category. */
export function parityLines(parity: LinkParity): string {
  const when = (at: string | null) => at ? ` (${at})` : "";
  const category = (name: string, entry: LinkSyncCategory | undefined) => `- ${name}: ${entry?.error ? `failed: ${entry.error}`
    : entry?.same === true ? `matches${when(entry.at)}` : entry?.same === false ? `differs${when(entry.at)}` : "not compared yet"}`;
  const { version, sync } = parity;
  return [
    `- version: ${!version ? "not asked yet" : version.commit && version.commit === parity.commit ? "same commit"
      : `it runs ${version.commit ?? "an unknown commit"}, this one ${parity.commit ?? "an unknown commit"}${version.error ? ` (${version.error})` : ""}`}`,
    `- Vault: ${!parity.vault ? "sync off (Settings > Account > Linked SpaceApps)" : parity.vault.error ? `failed: ${parity.vault.error}` : `synced${when(parity.vault.syncedAt)}`}`,
    `- AI accounts: ${parity.ai === null ? "no Gateway here" : parity.aiError ? `failed: ${parity.aiError}` : parity.ai ? "lent" : "not lent"}`,
    ...(!sync ? ["- settings, memory, sign-ins: not synced yet"] : sync.waiting ? ["- settings, memory, sign-ins: wait until both run the same commit"]
      : [category("settings", sync.settings), category("Space Memory", sync.memory), category("site sign-ins", sync.signins)])
  ].join("\n");
}
/** A linked SpaceApp's error in one line: its code, message and which fields it named. */
export const remoteError = (body: unknown) => {
  const error = (body as { error?: { code?: unknown; message?: unknown; details?: { formErrors?: unknown; fieldErrors?: unknown } } } | null)?.error;
  if (!error || typeof error !== "object") return "";
  const details = error.details && typeof error.details === "object" ? [...(Array.isArray(error.details.formErrors) ? error.details.formErrors : []),
    ...Object.entries(error.details.fieldErrors && typeof error.details.fieldErrors === "object" ? error.details.fieldErrors : {}).map(([key, value]) => `${key}: ${String(value)}`)] : [];
  return ` ${String(error.code ?? "ERROR")}: ${String(error.message ?? "")}${details.length ? ` (${details.join("; ")})` : ""}`;
};
export const instanceLine = (link: InstanceLinkView) => `- ${link.label} (${link.id}) at ${link.origins.join(", ")}: may ${link.scopes.join(", ")}; `
  + (link.lastSeenAt ? `last answered ${link.lastSeenAt}${link.connected ? ", connected" : ""}` : "never connected yet");
export const paneIdIn = (ref: string): string | null => /\bpane:[A-Za-z0-9_-]{4,80}(?![A-Za-z0-9_-])/.exec(ref)?.[0] ?? null;
export const isClosedPane = (pane: Pane): boolean => Boolean(pane.isClosed || (pane as { is_closed?: boolean }).is_closed);

const GENERIC_UTILITY_PATHS = /(?:^|\/)(?:space-progress|space-queue|space-worktree)(?:\.[a-z0-9]+)?$/i;

/** CORE-016: how long work sent to one pane holds the same work for another pane, while the first has not reported done or failed. */
export const NOUS_DUPLICATE_SEND_MS = 30 * 60_000;
/** CORE-016: what names one piece of work in a send: a plan step (English or Greek), an operator request id, a repo file path the send works on. */
export function sendWorkKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(/clipboard:([A-Za-z0-9_-]{6,})[^\n]{0,40}?(?<!\p{L})(?:step|βήμα)\s*(\d+)/giu)) keys.add(`plan clipboard:${match[1]} step ${match[2]}`);
  // A handoff can name its step far from "Plan ID: clipboard:X", so key the plan by its id.
  for (const match of text.matchAll(/Plan ID:\s*clipboard:([A-Za-z0-9_-]{6,})/gi)) keys.add(`plan clipboard:${match[1]}`);
  for (const match of text.matchAll(/nous_msg:[A-Za-z0-9_-]{8,}/g)) keys.add(match[0]);
  // 16/11 03:44: the Space Memory file (space_memory_2026-11.md) held Finn as Jack's work: an absolute path is a repo path only under a Space checkout.
  for (const match of text.matchAll(new RegExp(`(?<![\\w@./-])(?:\\./|${SPACE_INSTALL_ROOT}(?:-dev)?/(?:var/worktrees/space/[\\w.-]+/)?)?((?:apps|packages|scripts|deploy|docs|agent-skills)/[\\w.@/-]+)`, "g"))) {
    const path = match[1]!.replace(/[./]+$/, "");
    // A path named off-limits, owned by another pane, or mentioned as a finding is context, not the work.
    const clause = text.slice(0, match.index).split(/[\n;:!?]|\.\s/).pop()!;
    if (/(?<!\p{L})(?:do not|don't|never|not|without|except|leave|off-limits|out of|found|μην|όχι|εκτός)(?!\p{L})/iu.test(clause)) continue;
    if (GENERIC_UTILITY_PATHS.test(path)) continue;
    // Every registry piece names the shared ledger, so one finding held all the others; key by finding id when named.
    if (path === "docs/quality/review-findings.json") {
      // shortcut: model and standard names share the id shape (GPT-6, UTF-8); read the registry's own ids if another one collides.
      const ids = [...text.matchAll(/(?<![\w-])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+(?![\w-])/g)].filter((id) => !/^(?:GPT|UTF|SHA|ISO|RFC|TLS|AES|MD)-\d/.test(id[0]));
      if (ids.length) for (const id of ids) keys.add(`registry ${id[0]}`);
      else keys.add(path);
    } else if (/\/[^/]*[\w-]\.[A-Za-z0-9]{1,6}$/.test(path)) keys.add(path);
  }
  return [...keys];
}

/** Round 9 item 2: the reads that may follow a closed pane's name to a pane of the same kind in another room. */
/** R11-2 (5): a failed database read's PostgreSQL code and the column, table or ambiguous name it guessed. */
/** A pane, configure or native_command action's pane written flat (paneId, paneIds, paneName, pane, id) or as target.paneId folds into its target: an id into paneIds, a name into paneNames (R51-2). */
export function nousExecuteTarget(action: unknown): unknown {
  if (!action || typeof action !== "object" || Array.isArray(action)) return action;
  let given = action as Record<string, unknown>;
  // space_send_to_pane's when ("now", "after_turn", "calm") maps to Space Control's, and priority belongs to a calm prompt only.
  const when = typeof given.when === "string" ? ({ now: "NOW", after_turn: "AFTER_TURN", calm: "calm" } as Record<string, string>)[given.when.trim().toLowerCase().replace(/[\s-]+/g, "_")] : undefined;
  if (when && (when !== given.when || (when !== "calm" && "priority" in given))) {
    const { priority, ...rest } = given;
    given = { ...rest, when, ...(when === "calm" && priority !== undefined ? { priority } : {}) };
  }
  if (given.kind !== "pane" && given.kind !== "configure" && given.kind !== "native_command") return given;
  // Daily Nous errors F (9/11 "Unrecognized key: name" renaming a pane, 11/11 "input" prompting one): a pane action's words go in text.
  const alias = given.kind === "pane" && given.text === undefined ? ["name", "title", "input", "message", "prompt"].find((key) => typeof given[key] === "string") : undefined;
  if (alias) { const { [alias]: text, ...rest } = given; given = { ...rest, text }; }
  const refs = (from: Record<string, unknown>, keys: string[]) => keys.flatMap((key) => Array.isArray(from[key]) ? from[key] : typeof from[key] === "string" ? [from[key]] : [])
    .filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "").map((ref) => ref.trim());
  const into = (target: Record<string, unknown>, found: string[]) => {
    const ids = found.filter((ref) => /^pane:|^[A-Za-z0-9_-]{12}$/.test(ref));
    const names = found.filter((ref) => !ids.includes(ref));
    const paneIds = [...refs(target, ["paneIds"]), ...ids];
    const paneNames = [...refs(target, ["paneNames"]), ...names];
    return { ...target, ...(paneIds.length ? { paneIds } : {}), ...(paneNames.length ? { paneNames } : {}) };
  };
  if (given.target && typeof given.target === "object" && !Array.isArray(given.target)) {
    const { paneId, paneName, id, pane, ...target } = given.target as Record<string, unknown>;
    const found = refs({ paneId, paneName, id, pane }, ["paneId", "paneName", "id", "pane"]);
    return found.length ? { ...given, target: into(target, found) } : given;
  }
  if (given.target !== undefined) return given;
  // configure keeps its own optional paneId; only a missing target takes it.
  const keys = given.kind === "configure" ? ["paneId", "paneIds", "paneName", "paneNames", "pane"] : ["paneId", "paneIds", "paneName", "paneNames", "pane", "id"];
  const found = refs(given, keys);
  if (!found.length) return given;
  const rest = Object.fromEntries(Object.entries(given).filter(([key]) => !keys.includes(key) || (given.kind === "configure" && key === "paneId")));
  return { ...rest, target: into({}, found) };
}

export function nousDbConnectionDropped(error: unknown): boolean {
  return (error !== null && typeof error === "object" && "code" in error && error.code === "ECONNRESET")
    || /Connection terminated unexpectedly|\bECONNRESET\b/i.test(String(error));
}

export function nousDbFailureMeta(message: string): Record<string, string> {
  const code = /\(code ([0-9A-Z]{5})\)/.exec(message)?.[1];
  const guess = /column "?([\w$.]+)"? does not exist/.exec(message)?.[1] ?? /relation "([^"]+)" does not exist/.exec(message)?.[1]
    ?? /column reference "([^"]+)" is ambiguous/.exec(message)?.[1];
  // R17-3: a read Space refused before PostgreSQL saw it (a write, a side-effect call) is REFUSED, never an uncounted "other".
  return { dbCode: code ?? (/space_db_query (?:only reads|reads only)/.test(message) ? "REFUSED" : "other"), ...(guess ? { dbGuess: guess.slice(0, 80) } : {}) };
}

/** A failed mail read's cause from the Mail Copilot and Gmail layer's words, as the tool row's `mailCode`, instead of a bare failure (R17-6). */
export function nousMailFailure(message: string): { code: "RATE_LIMIT" | "NOT_FOUND" | "ACCOUNT" | "TIMEOUT" | "OTHER"; cause: string; next: string } {
  if (/rate limit/i.test(message)) return { code: "RATE_LIMIT", cause: "Gmail's rate limit", next: "read it again after the retry time Gmail gave." };
  if (/no longer has that message or thread|was not found|\b404\b/i.test(message)) {
    return { code: "NOT_FOUND", cause: "no such thread in that account", next: "find it with space_mail_search: a threadId belongs to the account the search named (a messageId is not a threadId)." };
  }
  if (/not a mail account|not allowed|has not allowed|expired|\b401\b|invalid_grant|full Gmail access|Google access is unavailable/i.test(message)) {
    return { code: "ACCOUNT", cause: "that account is not connected for mail", next: "use one of the connected accounts; a disconnected one is the operator's to reconnect in Setup → Accounts." };
  }
  if (/time(?:d)? ?out|aborted/i.test(message)) return { code: "TIMEOUT", cause: "Gmail did not answer in time", next: "read it once more in a minute." };
  return { code: "OTHER", cause: "an unexpected error", next: "read it once more; if it fails the same way, report the error." };
}

/** R11-2 (2): "YYYY-MM-DD[THH:MM[:SS]]" without an offset, read in the zone (a date alone is 09:00), as UTC ISO; null when it carries one or is no date. */
export function localUntil(text: string, zone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(text.trim());
  if (!match) return null;
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), match[4] === undefined ? 9 : Number(match[4]), Number(match[5] ?? 0), Number(match[6] ?? 0));
  if (Number.isNaN(wall)) return null;
  const offset = (at: number) => {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
        .formatToParts(new Date(at)).map((part) => [part.type, part.value]));
      return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - at;
    } catch { return 0; }
  };
  const first = wall - offset(wall);
  return new Date(wall - offset(first)).toISOString();
}

/** R11-4: the same action a decision runs: the same pane and text, the same release train, the same Space Control batch in the same room. */
export function sameDecisionAction(left: NousDecisionAction, right: NousDecisionAction): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "PANE_TEXT" && right.type === "PANE_TEXT") return left.paneId === right.paneId && left.mode === right.mode && left.text.trim() === right.text.trim();
  if (left.type === "RELEASE_APPROVE" && right.type === "RELEASE_APPROVE") return left.product === right.product;
  if (left.type === "SPACE_CONTROL" && right.type === "SPACE_CONTROL") return left.roomId === right.roomId && JSON.stringify(left.actions) === JSON.stringify(right.actions);
  return JSON.stringify(left) === JSON.stringify(right);
}

/** R10-16: Space Control's pane operations that reopen a closed pane. */
export const REOPENS = new Set(["reopen", "start", "resume"]);
/** Tools that slice their own answer with an `offset` argument (what a next slice repeats), so space_tool_result never holds them. */
export const SELF_PAGED: Record<string, string> = { space_db_query: "sql", space_files_read: "path or artifactId", space_git: "arguments", space_web_read: "url" };
export const PURE_READS = new Set(["space_read_pane", "space_pane_reports", "space_look", "space_browser_tabs", "space_pane_checked"]);
/** R28-1: the reads that reach a closed pane itself (its own reports and checks), so another room's pane of that name never stands in. */
export const READS_CLOSED = new Set(["space_pane_reports", "space_pane_checked"]);

/** The tools a pane name may follow to the one other room that has it (reads and prompts); every other change stays in the named room. */
// Daily Nous errors 14/11 (notify_operator ×2 "No open pane named"): a card about a pane follows its name like a read.
export const MOVES_BY_NAME = new Set(["space_read_pane", "space_pane_reports", "space_look", "space_browser_tabs", "space_pane_checked", "space_send_to_pane", "space_notify_operator"]);

export function nousControlRisk(actions: Array<Record<string, unknown>>, allow?: NousAllowances): { level: "RUN" | "ASK" | "REFUSE"; category: NousDecisionCategory | null; reason: string | null } {
  const all = roomAgentControlRisk("space_execute", { actions });
  if (all.level === "PROTECTED") return { level: "REFUSE", category: null, reason: all.reason };
  const critical = classifyNousOutgoing(actions.flatMap((action) => strings(without(action, "kind", "operation"))).join("\n"), allow);
  if (critical) return { level: "ASK", category: critical.category, reason: critical.reasons.join(", ") };
  const rest = roomAgentControlRisk("space_execute", { actions: actions.filter((action) => !nousRunsItself(action)) });
  if (rest.level === "DESTRUCTIVE") return { level: "ASK", category: rest.category ?? "DESTRUCTIVE", reason: rest.reason };
  return { level: "RUN", category: null, reason: null };
}

export const MAIL_READ_CACHE_MS = 2 * 60_000;
/** space_mail_read: older messages' text is trimmed to this; the answer names "messageId" to read one whole (23/11 nous_msg:92f82fc2). */
export const OLD_MESSAGE_CHARS = 1_500;
/** Copilot panes whose work comes as a brief (space_copilot_brief); Job and Mail Copilots take prompts in their CLI. */
export const BRIEF_MODES = new Set<Pane["mode"]>(["MARKETING_COPILOT", "FREELANCE_COPILOT", "DESIGN", "APP_STUDIO", "VIDEO", "SECURITY_COPILOT", "MONITORING_COPILOT"]);

export type CopilotBriefEvent = { id: string; type: string; status: string | null; message: string; payload: Record<string, unknown>; createdAt: string };
/** Nous's newest PENDING brief under 15 minutes old among a copilot pane's events (Freelance and Marketing mark it `from`, the others `requester`) (R20-1). */
export function pendingNousBriefOf(events: CopilotBriefEvent[], now: number): { id: string; text: string; at: string } | null {
  const brief = events.filter((event) => event.type === "BRIEF" && event.status === "PENDING" && (event.payload.from === "NOUS" || event.payload.requester === "NOUS")
    && Date.parse(event.createdAt) >= now - 15 * 60_000).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return brief ? { id: brief.id, text: brief.message, at: brief.createdAt } : null;
}

export const parseResults = (result: string): Array<{ index?: number; paneId?: string | null; status?: string; detail?: string; error?: string; evidence?: { dryRun?: boolean } }> => {
  try { const parsed = JSON.parse(result) as { results?: unknown }; return Array.isArray(parsed.results) ? parsed.results as never : []; } catch { return []; }
};
/** Each FAILED action, and each UNKNOWN or CANCELLED one as unconfirmed, goes before the receipt so leading ids never hide the cause (R12-7). */
export const failedFirst = <T extends { result: string }>(outcome: T, actions: Array<Record<string, unknown>>): T => {
  const failed = parseResults(outcome.result).filter((entry) => ["FAILED", "UNKNOWN", "CANCELLED"].includes(entry.status ?? "")).map((entry) => {
    const { index = 0, paneId, error, detail, status } = entry as { index?: number; paneId?: string | null; error?: string; detail?: string; status: string };
    const action = actions[index] ?? {};
    const target = paneId ?? ((action.target as { paneIds?: string[] } | undefined)?.paneIds ?? []).join(", ");
    // Space Control's UNKNOWN means it may have run, so it is never repeated blind.
    const label = status === "FAILED" ? "FAILED" : status === "CANCELLED" ? "CANCELLED" : "NOT CONFIRMED";
    const next = status === "UNKNOWN" ? " (it may have run: read the pane with space_read_pane before repeating it)" : "";
    // 13/11 review ("FAILED panes.open: [" ×4): a multi-line error (zod's issue list) on one line, so the first line holds all of it.
    return `${label} ${String(action.operation ?? action.kind ?? "action")}${target ? ` ${target}` : ""}: ${(error || detail || "no reason given").replace(/\s*\n\s*/g, " ")}${next}`;
  });
  return failed.length ? { ...outcome, result: `${failed.join("\n")}\n${outcome.result}` } : outcome;
};
