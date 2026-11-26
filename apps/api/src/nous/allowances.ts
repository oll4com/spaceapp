import { NOUS_RESTART_HOLD_LINE, NOUS_SEND_HOLD_LINE, type NousDecision, type NousTestTarget } from "@space/contracts";
import type { ReleaseTrain } from "../release-trains.js";

/**
 * "May send to third parties" (`nous.maySend`, operator DIRECTION decision 2026-10-28; operator 31/10 16:07 BKK «Βγάλε όλα τα όρια!!
 * Από παντού!!»): with the switch on, an EXTERNAL send Nous asks about (refs.sendKind on a pane instruction, a Space Control batch of pane
 * prompts, or a Mail/Freelance/Job/Marketing review approval or edit) is approved by the server at once. No learning, prediction rate, recipient list, cap, content screen or hold; only
 * the refs.files hashes (R10-18: what goes out is exactly the text the card names) are checked by the caller.
 */
export const MAY_SEND_ANSWER = "Approved by allowance maySend";
/** The first line of an ask the allowance does not cover (files changed, a review a rule memory holds for the operator). */
export const MAY_SEND_NOT_COVERED = 'Not covered by "May send to third parties"';
/** The body line of a send held before 31/10 (the 10-minute hold); the minute tick releases these, and Nous cannot write it itself. */
export const MAY_SEND_HOLD_LINE = NOUS_SEND_HOLD_LINE;

// R24-2 (operator 1/11 11:50 BKK): Marketing reviews too; "edit" approves the edited version, a send like "approve".
// Marketing since 1/11 (operator 11:53 BKK: a Marketing reply review still reached the operator as a card with the switch on).
const SEND_COPILOTS = new Set(["MAIL", "FREELANCE", "JOB", "MARKETING"]);

/**
 * Prices and discounts a send names: the server writes them on the card (PRICES_LINE) when the allowance is off, so the operator reads
 * exactly those; Nous cannot write that line itself (`neutralizePricesLine`).
 */
const PRICE = /[€$£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|eur\b|euros?\b|usd\b|dollars?\b|gbp\b)|\d+\s?%\s?off\b|\bpric(?:e|es|ing)\b|\bdiscount\w*|τιμή|τιμές|έκπτωσ\p{L}*/giu;
export const PRICES_LINE = "Prices in this send:";
export function priceTokens(texts: Array<string | null>): string[] {
  return [...new Set(texts.flatMap((text) => (text ?? "").match(PRICE) ?? []).map((token) => token.toLowerCase().replace(/\s+/g, "")))].sort();
}
export const pricesLine = (tokens: string[]) => tokens.length ? `${PRICES_LINE} ${tokens.join(", ")}` : null;
export const neutralizePricesLine = (text: string) => text.replaceAll(PRICES_LINE, "Prices (Nous's words):");

type Decision = Pick<NousDecision, "category" | "action" | "refs">;

/**
 * A send's kind when the decision is one the allowance covers: EXTERNAL, a pane instruction or a Mail/Freelance/Job/Marketing review approval
 * or edit. R24-3 (operator rule 5e8bc029, 1/11 11:50 BKK: Nous approves OR sends back every Marketing review, never the operator): a review's
 * reject, decline or revise sends nothing and runs the same way, its kind `<copilot>-review-back` when Nous gave none.
 */
export function maySendKind(decision: Decision): string | null {
  const action = decision.action;
  if (!action) return null;
  // Operator 2/11 15:08 BKK («να μην φτανει σε εμενα το aprove»): a review (or a Mail campaign's decline) is covered whatever category or
  // kind Nous named, so no wording of the ask puts it on the operator's card; a pane instruction still needs EXTERNAL and its sendKind.
  // Audit §4 item 1 (plan USQ6ktIIN_1D): a Marketing campaign (approve, complete, cancel) is covered like a Mail campaign.
  const review = action.type === "COPILOT" && SEND_COPILOTS.has(action.copilot) && (action.item === "REVIEW" || (action.item === "CAMPAIGN" && (action.copilot === "MAIL" || action.copilot === "MARKETING")));
  if (review && /^(?:reject|decline|revise|cancel|complete)$/i.test(action.decision)) return decision.refs.sendKind ?? `${action.copilot.toLowerCase()}-review-back`;
  if (review && /^(?:approve|edit)$/i.test(action.decision)) return decision.refs.sendKind ?? `${action.copilot.toLowerCase()}-review`;
  if (decision.category !== "EXTERNAL" || !decision.refs.sendKind) return null;
  if (action.type === "PANE_TEXT" && action.mode === "PROMPT") return decision.refs.sendKind;
  // Goal 7365014c step 2 (6/11): a send Nous runs as a Space Control batch of pane prompts (credits applications) is the same pane instruction.
  return action.type === "SPACE_CONTROL" && action.actions.every(panePrompt) ? decision.refs.sendKind : null;
}

const panePrompt = (step: Record<string, unknown>) => step.kind === "pane" && step.operation === "prompt";

/**
 * Operator rule mailmem:SLvZ9IZgCRc4 (12/11, funding mail is read before it is sent) and 16/11 22:48 BKK «θελω να δω τα παντα πριν!!»
 * (b2c1d147 OUTSCALE and 06fc6ecd Codex for OSS auto-approved under maySend 16/11): a funding, credits or program send stays the operator's card.
 */
/** The line space_ask_operator appends for ruleDiffers; service.ts holds such a send from maySend. */
export const RULE_DIFFERS_LINE = "Differs from your rule:";
export const OPERATOR_READS_FIRST = "operator reads first (rule SLvZ9IZgCRc4)";
const READ_FIRST_KINDS = new Set(["program-application", "startup-program-application", "cloud-credit-followup", "program-followup"]);
const FUNDING_PLAN = /\b(?:fund(?:ing|s|rais\w*)?|credits?|grants?|startup programs?|accelerators?|investors?|venture\s+capital|vc|pre-?seed|seed\s+round)\b|χρηματοδ[όο]τ|επενδυτ/iu;
// 23/11 Banggood e9aea0da ("Affiliate, όχι χρηματοδότηση", "not funding/investor"): Nous's own denial names no funding, so a negated word is dropped first.
const NOT_FUNDING = new RegExp(`(?:\\b(?:not|no|non)\\b-?|(?<!\\p{L})(?:όχι|ούτε)(?!\\p{L}))\\s*(?:${FUNDING_PLAN.source})\\p{L}*(?:\\/[\\p{L}-]+)*`, "giu");
const REVIEW_BACK = /^(?:reject|decline|revise|cancel|complete)$/i;
export function operatorReadsFirst(decision: Decision & { title?: string; body?: string }, planTitle?: string | null): boolean {
  const mailReview = decision.action?.type === "COPILOT" && decision.action.copilot === "MAIL";
  if (decision.category !== "EXTERNAL" && !mailReview) return false;
  if (decision.action?.type === "COPILOT" && (decision.action.item === "REVIEW" || decision.action.item === "CAMPAIGN") && REVIEW_BACK.test(decision.action.decision)) return false;
  return READ_FIRST_KINDS.has(decision.refs.sendKind ?? "")
    || Boolean(planTitle && FUNDING_PLAN.test(planTitle))
    || Boolean(decision.title && FUNDING_PLAN.test(decision.title))
    || (mailReview && FUNDING_PLAN.test([decision.body, sendActionText(decision.action)].filter(Boolean).join("\n").replace(NOT_FUNDING, "")));
}

/** The action's own words: the pane instruction, a Space Control batch's prompts, or a review's edited text and note. */
export function sendActionText(action: NousDecision["action"]): string {
  if (action?.type === "PANE_TEXT") return action.text;
  if (action?.type === "SPACE_CONTROL") return action.actions.map((step) => typeof step.text === "string" ? step.text : "").filter(Boolean).join("\n");
  if (action?.type === "COPILOT") return [action.text, action.note].filter(Boolean).join("\n");
  return "";
}

/**
 * "May delete what Nous created" (`nous.mayDeleteOwn`, brief B; Nous 28/10: only what Nous itself created): a DESTRUCTIVE Space Control
 * batch whose every action deletes an Agent File or Media file by id, each one Nous published itself (space_agent_files_add:
 * `metadata.runtimeId` "nous", written only by the server). No count, age, room or daily cap (operator 31/10 16:07 BKK); the caller keeps
 * a copy of each first. Targets without such a record (operator files, pane output, clipboard records, rooms, tasks) stay the operator's.
 */
export const MAY_DELETE_OWN_ANSWER = "Approved by allowance mayDeleteOwn";
const OWN_DELETES = new Set(["files.delete", "media.delete"]);
export interface OwnArtifact { id: string; roomId: string | null; createdAt: string; deletedAt: string | null; metadata: Record<string, unknown> }

/** The artifact ids such a batch deletes (each once), or null when any action is something else. */
export function deleteOwnTargets(decision: Decision): string[] | null {
  const action = decision.action;
  if (decision.category !== "DESTRUCTIVE" || action?.type !== "SPACE_CONTROL") return null;
  const ids = action.actions.map((entry) => {
    const input = entry.input && typeof entry.input === "object" ? entry.input as Record<string, unknown> : {};
    const id = typeof entry.id === "string" ? entry.id : typeof input.id === "string" ? input.id : null;
    return entry.kind === "resource" && OWN_DELETES.has(String(entry.operation)) ? id : null;
  });
  return ids.every((id): id is string => Boolean(id)) ? [...new Set(ids)] : null;
}

export function mayDeleteOwnCovers(input: { decision: Decision; artifacts: Array<OwnArtifact | null> }): { covered: true; ids: string[] } | { covered: false; reason: string } {
  const ids = deleteOwnTargets(input.decision);
  if (!ids) return { covered: false, reason: "not a delete of Agent Files or Media by id (the only deletes it covers)" };
  for (const id of ids) {
    const artifact = input.artifacts.find((entry) => entry?.id === id);
    if (!artifact || artifact.deletedAt) return { covered: false, reason: `${id} has no record` };
    if (artifact.metadata.runtimeId !== "nous" || artifact.metadata.source !== "AGENT_OUTPUT") return { covered: false, reason: `${id} was not made by Nous` };
  }
  return { covered: true, ids };
}

/**
 * R27-1 (operator yes 2/2 on 1/11: decisions f913 pve snapshots, 8494 test VM 905): the same allowance covers test VMs/CTs and their
 * snapshots an agent pane created and recorded when it made them (scripts/space-test-resource.mjs: audit `test_resource.created`, stamped
 * with that pane by the server; Nous cannot write one). A DESTRUCTIVE PANE_TEXT prompt names every target in refs.testDeletes; each needs
 * such a record (a whole VM's record covers its snapshots), and the text removes nothing else. Anything else stays the operator's card.
 */
export const TEST_RESOURCE_CREATED = "test_resource.created";
export interface TestResourceRecord { id: string; host: string; vmid: number; snapshot: string | null; paneId: string | null }

export function testDeleteTargets(decision: Decision): NousTestTarget[] | null {
  const action = decision.action;
  return decision.category === "DESTRUCTIVE" && action?.type === "PANE_TEXT" && action.mode === "PROMPT" && decision.refs.testDeletes?.length
    ? decision.refs.testDeletes : null;
}

export const testTargetLabel = (target: NousTestTarget) => `${target.host} ${target.vmid}${target.snapshot ? `@${target.snapshot}` : ""}`;
/** What the text removes beyond its targets: other VM/CT ids, other snapshots, whole datasets, files, pools, volumes. */
const BROAD_DELETE = /\brm\s+-\w*[rf]|\bzpool\s+(?:destroy|remove)|\blvremove\b|\bvgremove\b|\bwipefs\b|\bmkfs\b|\bpvesm\s+free\b|\bqm\s+disk\s+unlink\b/;

export function mayDeleteTestCovers(input: { decision: Decision; records: TestResourceRecord[] }): { covered: true; ids: string[]; keptIn: string } | { covered: false; reason: string } {
  const targets = testDeleteTargets(input.decision);
  const text = input.decision.action?.type === "PANE_TEXT" ? input.decision.action.text : "";
  if (!targets) return { covered: false, reason: "not a DESTRUCTIVE pane prompt naming refs.testDeletes" };
  const used = new Set<string>();
  for (const target of targets) {
    const record = input.records.find((entry) => entry.host === target.host && entry.vmid === target.vmid && (entry.snapshot === (target.snapshot ?? null) || (target.snapshot && entry.snapshot === null)));
    if (!record) return { covered: false, reason: `${testTargetLabel(target)} has no creation record of an agent pane (space-test-resource)` };
    if (!new RegExp(`\\b${target.vmid}\\b`).test(text) || (target.snapshot && !text.includes(target.snapshot))) return { covered: false, reason: `the text does not name ${testTargetLabel(target)}` };
    used.add(record.id);
  }
  const whole = new Set(targets.filter((target) => !target.snapshot).map((target) => target.vmid));
  const ids = new Set(targets.map((target) => target.vmid));
  const snapshots = new Set(targets.flatMap((target) => target.snapshot ? [target.snapshot] : []));
  const broad = BROAD_DELETE.exec(text);
  if (broad) return { covered: false, reason: `the text also runs "${broad[0]}"` };
  for (const match of text.matchAll(/\b(?:qm|pct)\s+destroy\s+(\d+)/g)) if (!whole.has(Number(match[1]))) return { covered: false, reason: `the text destroys ${match[1]}, not a whole VM/CT in refs.testDeletes` };
  for (const match of text.matchAll(/\b(?:qm|pct)\s+delsnapshot\s+(\d+)\s+([\w.:-]+)/g)) {
    if (!targets.some((target) => target.vmid === Number(match[1]) && (target.snapshot === match[2] || whole.has(target.vmid)))) return { covered: false, reason: `the text deletes snapshot ${match[2]} of ${match[1]}, not in refs.testDeletes` };
  }
  // ZFS: a snapshot (dataset@name) must be one of the targets'; a dataset of a VM disk must be one of their ids; a dataset without @ is never destroyed.
  for (const match of text.matchAll(/\/[\w.{},/-]*@([A-Za-z0-9_](?:[\w:-]|\.(?=[\w:-]))*)/g)) if (!snapshots.has(match[1]!)) return { covered: false, reason: `the text names snapshot @${match[1]}, not in refs.testDeletes` };
  for (const match of text.matchAll(/\b(?:vm|base|subvol)-(\d+)-disk/g)) if (!ids.has(Number(match[1]))) return { covered: false, reason: `the text names a disk of ${match[1]}, not in refs.testDeletes` };
  for (const match of text.matchAll(/\bzfs\s+destroy\s+(?:-\w+\s+)*([^\s`'";,]+)/g)) if (match[1]!.includes("/") && !match[1]!.includes("@")) return { covered: false, reason: `the text destroys the whole ZFS dataset ${match[1]}` };
  return { covered: true, ids: targets.map(testTargetLabel), keptIn: `records ${[...used].join(", ")}` };
}

/**
 * Audit §4 item 3 (plan clipboard:USQ6ktIIN_1D, 15/11: host cleanups were DESTRUCTIVE pane prompts the operator approved, e.g. 3ca0aa75):
 * "May clean regenerable system files" (`nous.mayCleanSystem`, default off). A DESTRUCTIVE PANE_TEXT prompt whose refs.cleanup names only
 * regenerable targets runs at once: our temp trees /tmp/space-* and /tmp/tmp.*, dangling docker images, the docker build cache. The text
 * must name each target and may delete nothing else (no other rm/find -delete path, no volume, container, snapshot, dataset, VM, git or SQL
 * delete, no prune --all). Worktrees, snapshots, images by name and anything else stay the operator's card.
 */
export const MAY_CLEAN_SYSTEM_ANSWER = "Approved by allowance mayCleanSystem";
const CLEAN_TMP = /^\/tmp\/(?:space-|tmp\.)[\w.*-]*(?:\/[\w.*-]+)*\/?$/;
const CLEAN_DOCKER = new Set(["docker image prune", "docker builder prune"]);
const CLEAN_NEVER = /\b(?:zfs|zpool)\s+destroy|\b(?:qm|pct)\s+(?:destroy|delsnapshot)|\bdocker\s+(?:volume\s+(?:rm|prune)|system\s+prune|container\s+(?:rm|prune)|rm|rmi|image\s+rm)\b|--volumes|\bprune(?:\s+-[-\w=]+)*?\s+(?:-[a-zA-Z]*a[a-zA-Z]*|--all)\b|\bgit\s+(?:clean|reset|branch\s+-D|worktree\s+remove)|\bspace-worktree\s+(?:clean|remove)|\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+from\b|\blvremove\b|\bvgremove\b|\bwipefs\b|\bmkfs\b|\bshred\b|\bunlink\b|\brmdir\b/i;

export function cleanupTargets(decision: Pick<Decision, "category" | "action" | "refs">): string[] | null {
  const action = decision.action;
  return decision.category === "DESTRUCTIVE" && action?.type === "PANE_TEXT" && action.mode === "PROMPT" && decision.refs.cleanup?.length ? decision.refs.cleanup : null;
}

export function mayCleanSystemCovers(decision: Pick<Decision, "category" | "action" | "refs">): { covered: true; targets: string[] } | { covered: false; reason: string } {
  const targets = cleanupTargets(decision);
  const text = decision.action?.type === "PANE_TEXT" ? decision.action.text : "";
  if (!targets) return { covered: false, reason: "not a DESTRUCTIVE pane prompt naming refs.cleanup" };
  // A target's * matches within one path segment; anything under a matched target is inside it.
  const glob = (target: string) => new RegExp(`^${target.replace(/\/$/, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}(?:/.*)?$`);
  const tmpWords = [...text.matchAll(/\/tmp\/[^\s;&|,`'"]+/g)].map((match) => match[0].replace(/\.$/, ""));
  for (const target of targets) {
    if (target.includes("..") || !(CLEAN_TMP.test(target) || CLEAN_DOCKER.has(target))) return { covered: false, reason: `${target} is not a regenerable target (/tmp/space-*, /tmp/tmp.*, docker image prune, docker builder prune)` };
    if (!text.includes(target) && !(target.startsWith("/") && tmpWords.some((word) => glob(target).test(word)))) return { covered: false, reason: `the text does not name ${target}` };
  }
  const never = CLEAN_NEVER.exec(text);
  if (never) return { covered: false, reason: `the text also runs "${never[0]}"` };
  const paths = targets.filter((target) => target.startsWith("/"));
  const inside = (path: string) => !path.includes("..") && paths.some((target) => glob(target).test(path.replace(/\/$/, "")));
  // Every path an rm or a find … -delete touches must be one of the /tmp targets or under one.
  // Its words run to the end of the command or the sentence; path-like words only, since the prompt is prose for an agent.
  // DEV3D-033: quoted paths count, find -exec rm is a find -delete, and xargs rm or a cd (relative paths) are the operator's card.
  // DEV3D-041: -exec /bin/rm, -exec sudo rm and -ok rm are -exec rm; a bare cd goes home, so it is a cd away too.
  const away = /\bxargs\b[^\n;&|]*?\brm\b/.exec(text) ?? [...text.matchAll(/(?<![\w/-])cd(?:\s+['"]?([^\s;&|`'"]+)|\s*(?=$|[;&|\n]))/g)].find((match) => !match[1] || !inside(match[1]));
  if (away) return { covered: false, reason: `the text also runs "${away[0]}"` };
  // DEV3D-048: a lookahead, so a second rm later on the same line (next sentence) is checked too, and every start path of a find.
  for (const match of text.matchAll(/\brm\s+(?=([^\n;&|,`]*))/g)) {
    for (const arg of match[1]!.split(/\.(?:['"]?\s|['"]?$)/)[0]!.trim().split(/\s+/).map((word) => word.replace(/['"]/g, ""))) if (/^[/~$.*]|\//.test(arg) && !inside(arg)) return { covered: false, reason: `the text removes ${arg}, not in refs.cleanup` };
  }
  for (const match of text.matchAll(/\bfind\s+([^\n;&|`]*?)(?:\s+(?=-)[^\n;&|]*?)?-(?:delete\b|(?:exec|ok)(?:dir)?\s+(?:sudo\s+)?(?:\S*\/)?rm\b)/g)) {
    for (const start of match[1]!.trim().split(/\s+/).map((word) => word.replace(/['"]/g, ""))) if (!inside(start)) return { covered: false, reason: `the text deletes under ${start}, not in refs.cleanup` };
  }
  return { covered: true, targets };
}

/**
 * "May publish after a green lab proof" (`nous.mayPublish`, brief C): the operator's RELEASE_APPROVE of a train's candidate is given by
 * the server when the captain's lab proof names exactly that candidate and is green (every case PASS, a fresh install, CI green,
 * space-version verify, no unapproved Warm change). Nothing else (operator 31/10 16:07 BKK: no security-scan, joined-commit or 24-hour
 * rule). Hotfixes, promotes and every other RELEASE decision stay the operator's.
 */
export const MAY_PUBLISH_ANSWER = "Approved by allowance mayPublish";
export interface PublishFacts {
  train: Pick<ReleaseTrain, "product" | "status" | "sourceSha" | "approvedSha" | "lab"> & { version?: string } | null;
}

export function mayPublishProduct(decision: Pick<NousDecision, "category" | "action">): string | null {
  return decision.category === "RELEASE" && decision.action?.type === "RELEASE_APPROVE" ? decision.action.product : null;
}

export function mayPublishCovers(input: { decision: Pick<NousDecision, "category" | "action">; facts: PublishFacts }): { covered: true; product: string; sourceSha: string } | { covered: false; reason: string } {
  const product = mayPublishProduct(input.decision);
  if (!product) return { covered: false, reason: "not a release train approval (RELEASE_APPROVE), the only release it covers" };
  const { train } = input.facts;
  if (!train || train.status !== "OPEN" || !train.sourceSha) return { covered: false, reason: `${product} has no open train with a candidate` };
  if (train.approvedSha === train.sourceSha) return { covered: false, reason: "this candidate is already approved" };
  const lab = train.lab;
  if (!lab || lab.sourceSha !== train.sourceSha) return { covered: false, reason: `no lab proof recorded for candidate ${train.sourceSha.slice(0, 10)}` };
  const red = [!lab.allCasesPass && "not every case PASS", !lab.freshInstall && "no fresh install", !lab.ciGreen && "CI not green",
    !lab.versionVerified && "space-version verify not passed", lab.warm === "UNAPPROVED" && "an unapproved Warm change"].filter(Boolean);
  if (red.length) return { covered: false, reason: `the lab proof is not green: ${red.join(", ")}` };
  return { covered: true, product, sourceSha: train.sourceSha };
}

/**
 * "May run guarded host restarts" (R16-1, nous.mayRestartHosts): a RELEASE ask whose PANE_TEXT asks for the guarded restart of exactly
 * one of the two hosts runs with no card. No time window, per-commit or stable-HEAD rule (operator 31/10 16:07 BKK). The technical
 * preconditions (the stable queue idle, no browser held, no CLI pane in a turn for the pane host) only make it wait: Space holds it
 * with no card and the minute tick (recheckRestarts) runs it once they clear. Unknown facts wait too.
 */
export const MAY_RESTART_HOSTS_ANSWER = "Approved by allowance mayRestartHosts";
/** The body line of a restart the allowance holds for its preconditions; the minute tick runs it, and Nous cannot write it itself. */
export const MAY_RESTART_HOLD_LINE = NOUS_RESTART_HOLD_LINE;
export type RestartHost = "BROWSER_HOST" | "PANE_HOST";
export interface RestartFacts {
  /** The stable merge queue holds no ticket in flight; null when it could not be read. */
  stableQueueIdle: boolean | null;
  /** Live pane browsers with an open handoff, a control lease or a Vault fence; null when the census failed. */
  browsersHeld: number | null;
  /** CLI panes in the middle of a turn (the pane host restart only); null when a pane could not be read. */
  panesMidTurn: number | null;
}

/**
 * Operator 31/10 17:00 BKK: only the stable queue deploys onto stable's hosts; the dev queue (busy almost all the time) never touches
 * stable's Browser Host or pane host (dev runs no Browser Host), so it never holds a restart.
 */
export function stableQueueIdle(queues: Array<{ name: string; report: { available: boolean; active: unknown[]; current: unknown } | null }> | null): boolean | null {
  const stable = queues?.find((queue) => queue.name === "stable")?.report;
  return stable?.available ? !stable.active.length && !stable.current : null;
}

export function restartHostOf(decision: Pick<NousDecision, "category" | "action">): RestartHost | null {
  if (decision.category !== "RELEASE" || decision.action?.type !== "PANE_TEXT") return null;
  const text = decision.action.text;
  if (!/\bguarded\b/i.test(text) || !/\brestart/i.test(text)) return null;
  // R37-3 (215335c7, 2/11 00:38 UTC: "Guarded Browser Host restart … the pane host part waits for decision da790917's restart" went to the
  // operator): the host is the one the restart phrase names ("<host> restart", "restart of <host>"); a host named elsewhere does not void it.
  const named = [...text.matchAll(RESTART_PHRASE)].map((match) => match[0]);
  const scope = named.length ? named.join(" ") : text;
  const browser = /browser[- ]?host/i.test(scope), pane = /pane[- ]?host/i.test(scope);
  return browser === pane ? null : browser ? "BROWSER_HOST" : "PANE_HOST";
}
const HOST = String.raw`(?:the\s+)?(?:browser|pane)[- ]?host(?:\.service)?`;
const HOSTS = String.raw`${HOST}(?:\s*(?:,|and|&)\s*${HOST})*`;
const RESTART_PHRASE = new RegExp(String.raw`${HOSTS}\s+restarts?\b|\brestart(?:s|ing)?\s+(?:of\s+)?(?:both\s+)?${HOSTS}`, "gi");

/** The commit the restart names, for the record only (null: none named). */
export const restartCommit = (text: string) => /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i.exec(text)?.[0]?.toLowerCase() ?? null;

export function mayRestartHostsCovers(input: { decision: Pick<NousDecision, "category" | "action">; facts: RestartFacts }):
  { covered: true; host: RestartHost; commit: string | null } | { covered: false; waits: boolean; reason: string } {
  const host = restartHostOf(input.decision);
  if (!host || input.decision.action?.type !== "PANE_TEXT") return { covered: false, waits: false, reason: "not a guarded restart of the Browser Host or the pane host" };
  const { stableQueueIdle: stableIdle, browsersHeld, panesMidTurn } = input.facts;
  const wait = (reason: string) => ({ covered: false as const, waits: true, reason });
  if (stableIdle !== true) return wait(stableIdle === null ? "the stable merge queue could not be read" : "the stable merge queue has a ticket in flight");
  if (browsersHeld === null) return wait("the browser census could not be read");
  if (browsersHeld > 0) return wait(`${browsersHeld} pane browser${browsersHeld === 1 ? " holds" : "s hold"} a handoff, a lease or a Vault fence`);
  if (host === "PANE_HOST" && panesMidTurn !== 0) return wait(panesMidTurn === null ? "the CLI panes could not be read" : `${panesMidTurn} CLI pane${panesMidTurn === 1 ? " is" : "s are"} in a turn`);
  return { covered: true, host, commit: restartCommit(input.decision.action.text) };
}

/**
 * "Never buy" (`nous.neverBuy`, audit §4 item 4, plan USQ6ktIIN_1D; operator rule «Ποτέ αγορά, πάντα δωρεάν διαδρομή», Space Memory 53425f72,
 * his «Καμία αγορά» to the Connects question 787e0034 of 14/11): a question whether to buy, top up, subscribe to or renew something paid
 * is not raised; it is answered "no purchase" at once and the task takes the free route. A buy word and a paid thing must both be named.
 * The buyer (αγοραστής, like English "buyer") is the other side of a sale, not a buy: 18/11 18:59Z it declined the Olla lot reply to ATS Export.
 * Its producer flag (19/11 REVIEW, 363fd74a): a send whose kind names the operator's sale (olla-lot-reply, lot-buyer-reply, pilot-offer) is no
 * purchase by its price or package words; a kind that also names a buy (connects-purchase), or words that buy a paid thing (Connects, credits,
 * a licence, a subscription, seats, a paid plan), still is.
 * shortcut: words, not intent, for an ask with no sale kind (a customer buying from the operator could match); give the producer a kind then.
 */
export const NEVER_BUY_ANSWER = 'No purchase (your "Never buy" rule): take the free route.';
const BUY = /\b(?:buy|buying|purchas\w*|top[- ]?up|subscrib\w*|renew\w*|pay(?:ment)?|card details)\b|αγορ(?!αστ(?:ης|η|ες|ων|ου)(?!\p{L}))|ανανεω|πληρω|στοιχεια της καρτας/u;
const PAID_THING = /\b(?:connects?|credits?|licen[cs]e\w*|subscriptions?|membership|seats?|(?:paid|pro|premium|business) (?:plan|tier))\b|συνδρομ|αδει/u;
const PAID = new RegExp(`${PAID_THING.source}|[€$£]\\s?\\d|\\d\\s?(?:€|eur\\b|usd\\b)|πακετ`, "u");
// shortcut: words, not intent; a passive «πληρώνονται» in a sale still reads as a buy, move to a producer flag if it holds a real offer.
// DEV3D-050: "renews", "subscribes", "pays" describe the customer's side of a sale ("the licence renews yearly"); "renew it" still buys.
const SALE_BUY = new RegExp(BUY.source.replace("pay(?:ment)?", "pay(?!s\\b)").replace("renew\\w*", "renew(?!s\\b)\\w*").replace("subscrib\\w*", "subscrib(?!es\\b)\\w*").replace("|πληρω", "|πληρω(?!μ)"), "u");
const SALE_KIND = /\b(?:lots?|sales?|sell\w*|buyers?|offers?|quotes?|invoices?)\b/;
// 22/11 (d43fff0e + d4924b41, free OpenAI Codex OSS credits: «δεν πληρώνουν»): a negated buy/pay verb is not a purchase ask.
// A conditional («αν δεν ανανεώσουμε», "if we don't pay") is still an ask, so it is never stripped.
const NEGATED_BUY = /(?<!\p{L})(?:δεν|μην|οχι|χωρις)\s+(?:θα\s+|να\s+)?(?:αγορ\p{L}*|πληρω\p{L}*|ανανεω\p{L}*)|\b(?:not|no|never|without|don'?t|do not|does not)\s+(?:to\s+)?(?:buy(?:ing)?|purchas\w*|pay(?:ing|ment)?|subscrib\w*|renew\w*|top[- ]?up)\b/gu;
const HEDGED_BUY = /\b(?:if|unless|whether|why not)\b|(?<!\p{L})(?:αν|εαν)(?!\p{L})/u;
export function purchaseAsk(text: string, sendKind?: string | null): boolean {
  const kind = sendKind?.toLowerCase() ?? "";
  const folded = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  // DEV3D-054: a conditional or a question keeps every negated buy ("if the team does not pay $49", "why not buy").
  const active = HEDGED_BUY.test(folded) ? folded : folded.replace(NEGATED_BUY, " ");
  // DEV3D-024: a sale kind spares a sale's price and package words, not a buy of a paid thing (an upwork-offer that needs Connects bought).
  // DEV3D-042: nor the word payment (πληρωμή): in a sale the customer pays ("5 seats, payment due in 30 days" is the operator's offer).
  if (SALE_KIND.test(kind) && !BUY.test(kind)) return SALE_BUY.test(active) && PAID_THING.test(folded);
  return BUY.test(active) && PAID.test(folded);
}
