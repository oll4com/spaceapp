import { z } from "zod";
import type { DeployQueueTicket } from "@space/contracts";
import type { NousFollowup, NousFollowupsRepository, NousFollowupTrigger } from "@space/db";
import { defaultDeployQueueRoot, readDeployQueueTicket } from "../deploy-queue.js";
import { defaultReleasesOptions } from "../instance-releases.js";
import { execGit } from "../worktrees/worktree-service.js";
import { deferralHold, deferralHolds, REQUEST_IDS, requestKey } from "./daily-review.js";

/**
 * Nous's follow-ups (plan clipboard:8s0ZNiO3q5ZT S3): "remind me when ..." back into its own inbox. A follow-up waits for a
 * time, for a merge-queue ticket (dev or stable) to end, or for a pane to finish its turn (or close), then fires once as an inbox
 * line. Per owner, persisted; the rows (status, outcome, times) are the audit. Nothing here acts on anything else.
 */
/** A ticket in one of these states has ended; CANCELLED too, so its follow-up does not wait forever. */
/** A merge-queue ticket id inside free words (a note, a wait). */
export const TICKET_IN_WORDS = /\bq-\d{8}-\d{6}-[0-9a-f]{4}\b/;
const ENDED = new Set<DeployQueueTicket["status"]>(["DEPLOYED", "FAILED", "CONFLICT", "CANCELLED"]);
/** The reason tools.ts appends to a follow-up the run-now gate let through on it. */
const WAIT_REASON_TAIL = /\s*\(wait reason: ([^]+)\)\s*$/;

export const nousFollowupArgsSchema = z.object({
  op: z.enum(["add", "list", "cancel"]),
  note: z.string().trim().min(1).optional().describe("add: what to do when it fires, for yourself."),
  at: z.string().datetime({ offset: true }).optional().describe("add, on a time: when (ISO with offset), any time ahead."),
  inMinutes: z.number().int().min(1).max(43_200).optional().describe("add, on a time: in this many minutes."),
  ticket: z.string().trim().regex(/^q-\d{8}-\d{6}-[0-9a-f]{4}$/).optional().describe("add: when this merge-queue ticket ends (DEPLOYED, FAILED, CONFLICT, CANCELLED)."),
  room: z.string().trim().min(1).max(200).optional().describe("add, on a pane: the pane's room."),
  pane: z.string().trim().min(1).max(160).optional().describe("add: when this pane finishes its turn."),
  followup: z.string().trim().regex(/^nous_followup:[A-Za-z0-9_-]{6,80}$/).optional().describe("cancel: the follow-up's id."),
  replaces: z.string().trim().regex(/^nous_followup:[A-Za-z0-9_-]{6,80}$/).optional().describe("add: the open follow-up on the same request this one replaces (it is cancelled).")
});
export type NousFollowupArgs = z.infer<typeof nousFollowupArgsSchema>;

export interface NousFollowupsDeps {
  repository: NousFollowupsRepository;
  /** Puts a line into the owner's inbox (the Nous service's notice); `onDone` runs after the turn that carried it completed, `onDiscard` when it was dropped. */
  notice(owner: string, key: string, line: string, onDone?: () => Promise<void>, onDiscard?: () => Promise<void>): Promise<void>;
  /** A ticket's status in either merge queue, null when it is not found. */
  ticketStatus?(ticketId: string): Promise<DeployQueueTicket["status"] | null>;
  /** Queue item 14: false when the pane is closed or gone, null when it cannot be read now (the follow-up then waits). */
  paneOpen?(paneId: string): Promise<boolean | null>;
  /** 9/11 REVIEW (stale room names in notes): "Andy (pane:…) in room Cleo (room:…)" now, null when the pane is gone. */
  paneWhere?(paneId: string): Promise<string | null>;
  now?: () => number;
}

/** Reads both queues (stable's and dev's); a ticket is in one of them. */
export async function readTicket(ticketId: string, roots = [defaultDeployQueueRoot, defaultReleasesOptions.devQueueRoot]): Promise<DeployQueueTicket | null> {
  // The ticket's own file: a finished ticket past the report's recent window still answers.
  for (const root of roots) {
    const ticket = await readDeployQueueTicket(ticketId, root).catch(() => null);
    if (ticket) return ticket;
  }
  return null;
}
/** A ticket whose file the queue no longer keeps is on stable when main carries its "Merge queue <id>:" merge commit (13/11: a 5/11 ticket kept a parked plan waiting). */
export async function ticketMergedOnMain(ticketId: string, root: string): Promise<boolean> {
  const found = await execGit(root, ["log", "main", "-1", "--format=%H", "--fixed-strings", `--grep=Merge queue ${ticketId}:`], 5_000).catch(() => null);
  return found?.code === 0 && found.stdout.trim() !== "";
}
export const readTicketStatus = async (ticketId: string, roots?: string[]): Promise<DeployQueueTicket["status"] | null> => (await readTicket(ticketId, roots))?.status ?? null;

/** R44-2: the ids a follow-up's note waits on; two open follow-ups never name the same one. R47-2: every copilot item a decision decides too. */
// 2026-11-16 REVIEW (15/11: nous_msg:a6bd8d9a ×8 follow-ups, INBOX turn cost $0.61 → $1.02): an operator message and a plan too.
const FOLLOWED_IDS = /\b(?:nous_decision|review|mailrev|mktpost|mcamp|mktcamp|flmsg|fllead|nous_msg|clipboard):[A-Za-z0-9_-]{6,80}/g;

/** 17/11 REVIEW (16/11: chains rewritten ×22 on nous_msg:b3744e80, ×21, ×11): a note's dates, times and "Re-checked …" words, which a rewrite alone changes. */
const NOTE_DATES = /(?:\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b\d{1,2}:\d{2}(?::\d{2})?|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:today|tonight|tomorrow)\b)(?:\s*(?:UTC|BKK|Z)\b)?/gi;
const RECHECKED = /\bre-?checked\b[^.;\n]*[.;]?/gi;
export const noteCore = (note: string) => note.replace(RECHECKED, " ").replace(NOTE_DATES, " ").replace(/[\s,;:()\-–]+/g, " ").trim().toLowerCase();
/** The holds a dated wait may keep the push lines quiet on: an operator order or a date (deferralHold's labels). */
const QUIET_HOLDS = new Set(["the operator's hands", "a real date"]);
/**
 * 17/11 REVIEW (follow-up churn): the requests and plans (requestKey) an open time follow-up with a future dueAt holds on the operator or a date
 * named in its wait reason, and "utilization" when its note is about Utilization: the push lines leave them out until it fires.
 */
export function datedHolds(items: readonly NousFollowup[], at: number): Set<string> {
  const held = new Set<string>();
  for (const item of items) {
    // 22/11 (operator nous_msg:0e499daa, load 15-36 % overnight): the note's own words (its re-check date, "operator", "approve") are no wait; the
    // trigger's dueAt is the time, and only a hold named in the "(wait reason: …)" the run-now gate kept counts, its plain dates stripped.
    const reason = item.note.match(WAIT_REASON_TAIL)?.[1]?.replace(NOTE_DATES, " ") ?? "";
    if (item.status !== "OPEN" || item.trigger.kind !== "TIME" || Date.parse(item.trigger.dueAt) <= at || !deferralHolds(reason).some((hold) => QUIET_HOLDS.has(hold))) continue;
    for (const id of item.note.match(REQUEST_IDS) ?? []) held.add(requestKey(id));
    if (/\butili[sz]ation\b/i.test(item.note)) held.add("utilization");
  }
  return held;
}

/** 1045: a note that is a check after a reboot or host restart; the pane it waits on closes at that reboot. */
const POST_REBOOT = /\breboot|\bpost-?boot\b|\brestart(?:s|ing)?\s+(?:of\s+)?(?:the\s+)?(?:vm|host|pane host|server)\b|επανεκκίνηση/i;
/** 1045: how long after the pane closed at the reboot the server's check fires (the host and its services are back by then). */
const POST_REBOOT_DELAY_MS = 10 * 60_000;

const describe = (trigger: NousFollowupTrigger) => trigger.kind === "TIME" ? `at ${trigger.dueAt}`
  : trigger.kind === "TICKET" ? `when ticket ${trigger.ticketId} ends` : `when ${trigger.paneLabel} finishes`;
const lineOf = (item: NousFollowup) => `[${item.id}] ${item.status} ${describe(item.trigger)}: ${item.note}${item.outcome ? ` (${item.outcome}, ${item.closedAt})` : ""}`;

export function createNousFollowups(deps: NousFollowupsDeps) {
  const now = deps.now ?? Date.now;
  const ticketStatus = deps.ticketStatus ?? ((id: string) => readTicketStatus(id));

  // The row stays OPEN until the turn that saw the line completed (2026-10-21): a restart or a failed turn used to lose it. R22-3 (1/11: the
  // lines of promote 46ed came back in 3-4 turns): a line a turn carries is not noticed again until that turn ends; a dropped one is again.
  const inFlight = new Set<string>();
  async function tell(owner: string, key: string, line: string, close: () => Promise<void>): Promise<boolean> {
    const mark = `${owner}\u0000${key}`;
    if (inFlight.has(mark)) return false;
    inFlight.add(mark);
    await deps.notice(owner, key, line, async () => { inFlight.delete(mark); await close(); }, async () => { inFlight.delete(mark); });
    return true;
  }
  // 9/11 REVIEW: a note names the room its pane was in when it was set; the line says where its panes are now, so no call names a deleted room.
  async function whereNow(item: NousFollowup): Promise<string> {
    const ids = new Set([...(item.trigger.kind === "PANE" ? [item.trigger.paneId] : []), ...(item.note.match(/\bpane:[A-Za-z0-9_-]{4,80}(?![A-Za-z0-9_-])/g) ?? [])]);
    const now = deps.paneWhere ? (await Promise.all([...ids].map((id) => deps.paneWhere!(id).catch(() => null)))).filter(Boolean) : [];
    return now.length ? ` (now: ${now.join("; ")})` : "";
  }
  const fire = async (item: NousFollowup, outcome: string, status: "FIRED" | "CANCELLED" = "FIRED") => tell(item.ownerUserId, `followup:${item.id}`,
    `Follow-up you set ${item.createdAt.slice(0, 16)} (${outcome}): ${item.note}${await whereNow(item)}`, async () => { await deps.repository.close(item.ownerUserId, item.id, status, outcome); });

  return {
    /** The space_nous_followup tool; `pane` is already resolved to the owner's pane by the caller. */
    async run(owner: string, args: NousFollowupArgs, pane: { paneId: string; paneLabel: string } | null): Promise<{ ok: boolean; refused?: boolean; display: string; result: string }> {
      // Daily Nous errors 14/11 slice 5 (×2 in 7 days "Give exactly one trigger"): every answer here names the argument the next call needs: a refusal.
      const fail = (result: string) => ({ ok: false, refused: true, display: "Follow-up not changed", result });
      if (args.op === "list") {
        // Every open follow-up, then the newest closed ones (operator 2026-10-27: no limit on open follow-ups).
        const items = await deps.repository.list(owner, 40);
        return { ok: true, display: "Read my follow-ups", result: items.length ? items.map(lineOf).join("\n") : "No follow-ups." };
      }
      if (args.op === "cancel") {
        if (!args.followup) return fail("Give the follow-up's id to cancel.");
        const closed = await deps.repository.close(owner, args.followup, "CANCELLED", "Cancelled by Nous");
        if (closed) return { ok: true, display: "Cancelled a follow-up", result: lineOf(closed) };
        // 30 failures in 7 days (review 2026-10-20): the follow-up had already fired or been cancelled, which is what cancel wants.
        const ended = await deps.repository.get(owner, args.followup);
        return ended ? { ok: true, display: "That follow-up already ended", result: `Already ${ended.status.toLowerCase()}: ${lineOf(ended)}` }
          : fail(`No follow-up ${args.followup}: op list shows yours.`);
      }
      if (!args.note) return fail("Give the note: what to do when it fires.");
      const triggers = [args.at !== undefined || args.inMinutes !== undefined, args.ticket !== undefined, pane !== null].filter(Boolean).length;
      if (triggers !== 1 || (args.at !== undefined && args.inMinutes !== undefined)) return fail("Give exactly one trigger: at or inMinutes, ticket, or room and pane.");
      // 17/11 REVIEW (churn): a replacement that only moves its dates or adds "Re-checked" words is the open one; it stays.
      const replaced = args.replaces ? await deps.repository.get(owner, args.replaces) : null;
      if (replaced?.status === "OPEN" && noteCore(replaced.note) === noteCore(args.note)) return fail(`no change, keep ${replaced.id}: its note differs from this one only in dates `
        + `or "Re-checked" words, and it already waits ${describe(replaced.trigger)}. Nothing was set; when its wait changes, say what changed in the note.`);
      // 21/11 REVIEW: the same guard without `replaces` (an id-less wait such as Utilization's was set again beside the open one each turn): a new
      // time note equal to an open time follow-up's but for dates is that follow-up. shortcut: exact equality of noteCore, a reworded wait still adds; an identical note is left to the wait-reason rules below.
      const core = noteCore(args.note);
      const twin = core && args.ticket === undefined && pane === null
        ? (await deps.repository.list(owner, 0)).find((item) => item.status === "OPEN" && item.trigger.kind === "TIME" && item.id !== args.replaces && item.note !== args.note && noteCore(item.note) === core) : undefined;
      if (twin) return fail(`no change, keep ${twin.id}: it already holds this note, ${describe(twin.trigger)}, and this one differs only in dates or "Re-checked" words. `
        + `Nothing was set; to move its time pass replaces: ${twin.id} with a note that says what changed.`);
      // R44-2 (2/11: four follow-ups for one Temu approval): an open follow-up whose note names the same decision or review is that follow-up.
      // Token audit 21/11 (51 refusals in 3 days, nearly all on a nous_msg, each retried): one operator request sent to several panes waits on
      // each of them, so for a nous_msg only a wait of the same kind is that follow-up (a wake on another pane or a ticket is set at once).
      const named = new Set(args.note.match(FOLLOWED_IDS) ?? []);
      const samePane = (item: NousFollowup) => !!pane && item.trigger.kind === "PANE" && item.trigger.paneId === pane.paneId;
      const sameWait = (item: NousFollowup, id: string) => !id.startsWith("nous_msg:") || samePane(item)
        || (!pane && args.ticket === undefined && item.trigger.kind === "TIME");
      const same = named.size ? (await deps.repository.list(owner, 0)).find((item) => item.status === "OPEN"
        && (item.note.match(FOLLOWED_IDS) ?? []).some((id) => named.has(id) && sameWait(item, id))) : undefined;
      if (same && args.replaces === same.id) await deps.repository.close(owner, same.id, "CANCELLED", "Replaced by Nous");
      // The same pane again already wakes Nous: nothing to retry.
      else if (same && samePane(same)) return { ok: true, display: `${same.id} already waits on ${pane!.paneLabel}`, result: `Nothing added: ${same.id} already wakes you when ${pane!.paneLabel} finishes: ${lineOf(same)}` };
      else if (same) {
        const id = (same.note.match(FOLLOWED_IDS) ?? []).find((each) => named.has(each))!;
        return { ok: false, refused: true, display: `${same.id} already follows ${id}`, result: `${same.id} is already open on ${id}; nothing added. Keep it, or pass replaces: ${same.id} to set this one in its place: ${lineOf(same)}` };
      }
      // 1057 (13/11 REVIEW: deferrals that could have run): a time wait whose note names a merge-queue ticket still running fires when that
      // ticket ends instead. shortcut: tickets only; a wait on a pane's or plan's job named in the note still keeps its time.
      const namedTicket = args.ticket || pane ? undefined : args.note.match(TICKET_IN_WORDS)?.[0];
      const namedStatus = namedTicket ? await ticketStatus(namedTicket).catch(() => null) : null;
      const ticket = args.ticket ?? (namedStatus && !ENDED.has(namedStatus) ? namedTicket : undefined);
      const moved = ticket && !args.ticket ? ` Its note names ticket ${ticket}, still ${namedStatus}: it fires when that ticket ends, not at the time given.` : "";
      let trigger: NousFollowupTrigger;
      if (ticket) {
        // R23-4 (1/11 00:00 UTC: four follow-ups on one ticket each asked a promote): a ticket Nous already watches keeps ONE follow-up; the note joins it.
        const watching = (await deps.repository.list(owner, 0)).find((item) => item.status === "OPEN" && item.trigger.kind === "TICKET" && item.trigger.ticketId === ticket);
        if (watching) {
          const notes = watching.note.split("\n").map((line) => line.trim());
          const joined = notes.includes(args.note.trim()) ? watching : await deps.repository.appendNote(owner, watching.id, args.note.trim());
          if (joined) return { ok: true, display: `Added to the follow-up on ticket ${ticket}`, result: `Ticket ${ticket} already has a follow-up; `
            + `${joined === watching ? "it already holds this note" : "this note joined it"}, one line when the ticket ends: ${lineOf(joined)}${moved}` };
        }
        trigger = { kind: "TICKET", ticketId: ticket };
      } else if (pane) trigger = { kind: "PANE", ...pane };
      else {
        const due = args.at !== undefined ? Date.parse(args.at) : now() + args.inMinutes! * 60_000;
        if (due <= now()) return fail("The time must be in the future.");
        // 15/11 REVIEW (nous_followup:51563d56 → e77e225f, "else re-arm 12 h" twice): a time wait held only by a reason that names no hold
        // (deferralHold: date, person, ticket, reset, ...) gets one wait; the same note again after it fired runs now. 2026-11-15 REVIEW 6 (A):
        // so does the same note with its reason unchanged, whatever the reason names.
        const reason = args.note.match(WAIT_REASON_TAIL)?.[1]?.trim();
        const base = args.note.replace(WAIT_REASON_TAIL, "").replace(/\s+/g, " ").trim();
        const held = reason ? deferralHold(reason) : undefined;
        const again = reason ? (await deps.repository.list(owner, 40)).find((item) => item.status === "FIRED"
          && item.note.replace(WAIT_REASON_TAIL, "").replace(/\s+/g, " ").trim() === base && (!held || item.note.match(WAIT_REASON_TAIL)?.[1]?.trim() === reason)) : undefined;
        if (again) return fail(`${again.id} already waited on this note and fired ${again.closedAt?.slice(0, 16) ?? ""} with nothing new; its reason ("${reason}") `
          + `${held ? "is unchanged" : "names no date, person or ticket"}, so waiting again only re-arms it. Do the check in this turn; to wait again, name what really holds it `
          + "(a date, the operator or a third party, a ticket, a reset), or give room and pane to be woken when that pane finishes. Nothing was set.");
        trigger = { kind: "TIME", dueAt: new Date(due).toISOString() };
      }
      const added = await deps.repository.add({ ownerUserId: owner, note: args.note, trigger });
      const rearm = trigger.kind === "PANE" && POST_REBOOT.test(args.note) ? ` If ${trigger.paneLabel} closes at the reboot, the server arms this check itself `
        + `${POST_REBOOT_DELAY_MS / 60_000} min later; keep the plan step IN_PROGRESS until it reports.` : "";
      // R22-5: a time follow-up is a deferral the daily REVIEW weighs (tool row meta).
      return { ok: true, display: `Set a follow-up ${describe(trigger)}`, result: `${lineOf(added)}${moved}${rearm}`,
        ...(trigger.kind === "TIME" ? { meta: { deferral: { kind: "FOLLOWUP", id: added.id, until: trigger.dueAt, what: args.note } } } : {}) };
    },

    /** What the owner's dated follow-ups hold now (datedHolds). */
    async held(owner: string): Promise<Set<string>> {
      return datedHolds(await deps.repository.list(owner, 0), now());
    },

    /** Every minute: due times and ended tickets fire. */
    async tick(): Promise<number> {
      let fired = 0;
      const statuses = new Map<string, Promise<DeployQueueTicket["status"] | null>>();
      const cancelled = new Map<string, NousFollowup[]>();
      const ended = new Map<string, { owner: string; ticketId: string; status: string; items: NousFollowup[] }>();
      for (const item of await deps.repository.listOpen()) {
        if (item.trigger.kind === "TIME" && Date.parse(item.trigger.dueAt) <= now() && await fire(item, "time came")) fired += 1;
        if (item.trigger.kind === "TICKET") {
          const { ticketId } = item.trigger;
          if (!statuses.has(ticketId)) statuses.set(ticketId, ticketStatus(ticketId).catch(() => null));
          const status = await statuses.get(ticketId)!;
          const group = `${item.ownerUserId}\u0000${ticketId}`;
          if (status && ENDED.has(status)) ended.set(group, { owner: item.ownerUserId, ticketId, status, items: [...(ended.get(group)?.items ?? []), item] });
        }
        // Queue item 14 (27/10: one waited on a Bruno/Finn that no longer existed): a pane closed before it finished ends its follow-up.
        if (item.trigger.kind === "PANE" && deps.paneOpen && await deps.paneOpen(item.trigger.paneId).catch(() => null) === false) {
          // 1045 (12/11: plan pZwo step 7 "post-boot checks by Hugo", Hugo's pane closed at the reboot and no one checked): a post-reboot check
          // whose pane closed is not cancelled: the server re-arms it as its own time follow-up, which no reboot of a pane closes.
          if (POST_REBOOT.test(item.note)) {
            const label = item.trigger.paneLabel;
            await deps.repository.add({ ownerUserId: item.ownerUserId, trigger: { kind: "TIME", dueAt: new Date(now() + POST_REBOOT_DELAY_MS).toISOString() },
              note: `Post-reboot check armed by the server (${label} closed at the reboot): ${item.note}\nRun the check now (a live worker may run it for you) and keep the plan step IN_PROGRESS until it reports.` });
            await deps.repository.close(item.ownerUserId, item.id, "FIRED", `${label} closed at the reboot: re-armed on the server`);
            continue;
          }
          cancelled.set(item.ownerUserId, [...(cancelled.get(item.ownerUserId) ?? []), item]);
        }
      }
      // R22-3: the follow-ups of one ticket fold into ONE line per ticket end (its outcome and every note); the turn that saw it closes them.
      for (const { owner, ticketId, status, items } of ended.values()) {
        const outcome = `ticket ${ticketId} ${status}`;
        const line = items.length === 1 ? `Follow-up you set ${items[0]!.createdAt.slice(0, 16)} (${outcome}): ${items[0]!.note}`
          : `Ticket ${ticketId} ended ${status}: ${items.length} follow-ups you set on it: ${items.map((item) => `${item.createdAt.slice(0, 16)}: ${item.note.replace(/\s+/g, " ")}`).join("; ")}`;
        if (await tell(owner, `followups-ticket:${ticketId}`, line, async () => {
          for (const item of items) await deps.repository.close(owner, item.id, "FIRED", outcome);
        })) fired += items.length;
      }
      // Queue item 40 (28/10 10:48: 17 such lines in one turn): one inbox line per owner names them all; the turn that saw it closes them.
      for (const [owner, items] of cancelled) {
        const label = (item: NousFollowup) => item.trigger.kind === "PANE" ? item.trigger.paneLabel : "a pane";
        const line = items.length === 1 ? `Follow-up you set ${items[0]!.createdAt.slice(0, 16)} (${label(items[0]!)} closed before it finished): ${items[0]!.note}`
          : `${items.length} follow-ups cancelled, their panes closed before they finished: ${items.map((item) => `${label(item)}: ${item.note.replace(/\s+/g, " ")}`).join("; ")}`;
        if (await tell(owner, "followups-cancelled", line, async () => {
          for (const item of items) await deps.repository.close(owner, item.id, "CANCELLED", `${label(item)} closed before it finished`);
        })) fired += items.length;
      }
      return fired;
    },

    /** A pane finished its turn (the room monitor's FINISHED event). */
    async paneFinished(paneId: string): Promise<void> {
      for (const item of await deps.repository.listOpen()) {
        if (item.trigger.kind === "PANE" && item.trigger.paneId === paneId) await fire(item, `${item.trigger.paneLabel} finished`);
      }
    }
  };
}

export type NousFollowups = ReturnType<typeof createNousFollowups>;
