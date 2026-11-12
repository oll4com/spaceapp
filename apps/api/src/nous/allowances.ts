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
  const review = action.type === "COPILOT" && SEND_COPILOTS.has(action.copilot) && (action.item === "REVIEW" || (action.copilot === "MAIL" && action.item === "CAMPAIGN"));
  if (review && /^(?:reject|decline|revise|cancel)$/i.test(action.decision)) return decision.refs.sendKind ?? `${action.copilot.toLowerCase()}-review-back`;
  if (review && /^(?:approve|edit)$/i.test(action.decision)) return decision.refs.sendKind ?? `${action.copilot.toLowerCase()}-review`;
  if (decision.category !== "EXTERNAL" || !decision.refs.sendKind) return null;
  if (action.type === "PANE_TEXT" && action.mode === "PROMPT") return decision.refs.sendKind;
  // Goal 7365014c step 2 (6/11): a send Nous runs as a Space Control batch of pane prompts (credits applications) is the same pane instruction.
  return action.type === "SPACE_CONTROL" && action.actions.every(panePrompt) ? decision.refs.sendKind : null;
}

const panePrompt = (step: Record<string, unknown>) => step.kind === "pane" && step.operation === "prompt";

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
