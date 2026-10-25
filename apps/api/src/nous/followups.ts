import { z } from "zod";
import type { DeployQueueTicket } from "@space/contracts";
import type { NousFollowup, NousFollowupsRepository, NousFollowupTrigger } from "@space/db";
import { defaultDeployQueueRoot, readDeployQueue } from "../deploy-queue.js";
import { defaultReleasesOptions } from "../instance-releases.js";

/**
 * Nous's follow-ups (plan clipboard:8s0ZNiO3q5ZT S3): "remind me when ..." back into its own inbox. A follow-up waits for a
 * time, for a merge-queue ticket (dev or stable) to end, or for a pane to finish its turn, then fires once as an inbox
 * line. Per owner, persisted; the rows (status, outcome, times) are the audit. Nothing here acts on anything else.
 */
export const NOUS_FOLLOWUP_OPEN_MAX = 50;
const MAX_AHEAD_MS = 30 * 86_400_000;
/** A ticket in one of these states has ended; CANCELLED too, so its follow-up does not wait forever. */
const ENDED = new Set<DeployQueueTicket["status"]>(["DEPLOYED", "FAILED", "CONFLICT", "CANCELLED"]);

export const nousFollowupArgsSchema = z.object({
  op: z.enum(["add", "list", "cancel"]),
  note: z.string().trim().min(1).max(1_000).optional().describe("add: what to do when it fires, for yourself."),
  at: z.string().datetime({ offset: true }).optional().describe("add, on a time: when (ISO with offset), at most 30 days ahead."),
  inMinutes: z.number().int().min(1).max(43_200).optional().describe("add, on a time: in this many minutes."),
  ticket: z.string().trim().regex(/^q-\d{8}-\d{6}-[0-9a-f]{4}$/).optional().describe("add: when this merge-queue ticket ends (DEPLOYED, FAILED, CONFLICT, CANCELLED)."),
  room: z.string().trim().min(1).max(200).optional().describe("add, on a pane: the pane's room."),
  pane: z.string().trim().min(1).max(160).optional().describe("add: when this pane finishes its turn."),
  followup: z.string().trim().regex(/^nous_followup:[A-Za-z0-9_-]{6,80}$/).optional().describe("cancel: the follow-up's id.")
});
export type NousFollowupArgs = z.infer<typeof nousFollowupArgsSchema>;

export interface NousFollowupsDeps {
  repository: NousFollowupsRepository;
  /** Puts a line into the owner's inbox (the Nous service's notice); `onDone` runs after the turn that carried it completed. */
  notice(owner: string, key: string, line: string, onDone?: () => Promise<void>): Promise<void>;
  /** A ticket's status in either merge queue, null when it is not found. */
  ticketStatus?(ticketId: string): Promise<DeployQueueTicket["status"] | null>;
  now?: () => number;
}

/** Reads both queues (stable's and dev's); a ticket is in one of them. */
export async function readTicketStatus(ticketId: string, roots = [defaultDeployQueueRoot, defaultReleasesOptions.devQueueRoot]): Promise<DeployQueueTicket["status"] | null> {
  for (const root of roots) {
    const report = await readDeployQueue(root).catch(() => null);
    const ticket = report && [...report.active, ...report.recent].find((entry) => entry.id === ticketId);
    if (ticket) return ticket.status;
  }
  return null;
}

const describe = (trigger: NousFollowupTrigger) => trigger.kind === "TIME" ? `at ${trigger.dueAt}`
  : trigger.kind === "TICKET" ? `when ticket ${trigger.ticketId} ends` : `when ${trigger.paneLabel} finishes`;
const lineOf = (item: NousFollowup) => `[${item.id}] ${item.status} ${describe(item.trigger)}: ${item.note}${item.outcome ? ` (${item.outcome}, ${item.closedAt})` : ""}`;

export function createNousFollowups(deps: NousFollowupsDeps) {
  const now = deps.now ?? Date.now;
  const ticketStatus = deps.ticketStatus ?? ((id: string) => readTicketStatus(id));

  // The row stays OPEN until the turn that saw the line completed (2026-10-21): a restart or a failed turn used to lose it, and the
  // tick re-notices the same key (the line is replaced, never doubled) until then.
  async function fire(item: NousFollowup, outcome: string): Promise<void> {
    await deps.notice(item.ownerUserId, `followup:${item.id}`, `Follow-up you set ${item.createdAt.slice(0, 16)} (${outcome}): ${item.note}`,
      async () => { await deps.repository.close(item.ownerUserId, item.id, "FIRED", outcome); });
  }

  return {
    /** The space_nous_followup tool; `pane` is already resolved to the owner's pane by the caller. */
    async run(owner: string, args: NousFollowupArgs, pane: { paneId: string; paneLabel: string } | null): Promise<{ ok: boolean; display: string; result: string }> {
      const fail = (result: string) => ({ ok: false, display: "Follow-up not changed", result });
      if (args.op === "list") {
        const items = await deps.repository.list(owner, 40);
        return { ok: true, display: "Read my follow-ups", result: items.length ? items.map(lineOf).join("\n") : "No follow-ups." };
      }
      if (args.op === "cancel") {
        if (!args.followup) return fail("Give the follow-up's id to cancel.");
        const closed = await deps.repository.close(owner, args.followup, "CANCELLED", "Cancelled by Nous");
        if (closed) return { ok: true, display: "Cancelled a follow-up", result: lineOf(closed) };
        // 30 failures in 7 days (review 2026-10-20): the follow-up had already fired or been cancelled, which is what cancel wants.
        const ended = (await deps.repository.list(owner, 200)).find((item) => item.id === args.followup);
        return ended ? { ok: true, display: "That follow-up already ended", result: `Already ${ended.status.toLowerCase()}: ${lineOf(ended)}` }
          : fail(`No follow-up ${args.followup}: op list shows yours.`);
      }
      if (!args.note) return fail("Give the note: what to do when it fires.");
      const triggers = [args.at !== undefined || args.inMinutes !== undefined, args.ticket !== undefined, pane !== null].filter(Boolean).length;
      if (triggers !== 1 || (args.at !== undefined && args.inMinutes !== undefined)) return fail("Give exactly one trigger: at or inMinutes, ticket, or room and pane.");
      let trigger: NousFollowupTrigger;
      if (args.ticket) trigger = { kind: "TICKET", ticketId: args.ticket };
      else if (pane) trigger = { kind: "PANE", ...pane };
      else {
        const due = args.at !== undefined ? Date.parse(args.at) : now() + args.inMinutes! * 60_000;
        if (due <= now() || due > now() + MAX_AHEAD_MS) return fail("The time must be in the future, at most 30 days ahead.");
        trigger = { kind: "TIME", dueAt: new Date(due).toISOString() };
      }
      const open = (await deps.repository.list(owner, NOUS_FOLLOWUP_OPEN_MAX + 1)).filter((item) => item.status === "OPEN").length;
      if (open >= NOUS_FOLLOWUP_OPEN_MAX) return fail(`You already have ${open} open follow-ups: cancel some first.`);
      const added = await deps.repository.add({ ownerUserId: owner, note: args.note, trigger });
      return { ok: true, display: `Set a follow-up ${describe(trigger)}`, result: lineOf(added) };
    },

    /** Every minute: due times and ended tickets fire. */
    async tick(): Promise<number> {
      let fired = 0;
      const statuses = new Map<string, Promise<DeployQueueTicket["status"] | null>>();
      for (const item of await deps.repository.listOpen()) {
        if (item.trigger.kind === "TIME" && Date.parse(item.trigger.dueAt) <= now()) { await fire(item, "time came"); fired += 1; }
        if (item.trigger.kind === "TICKET") {
          const { ticketId } = item.trigger;
          if (!statuses.has(ticketId)) statuses.set(ticketId, ticketStatus(ticketId).catch(() => null));
          const status = await statuses.get(ticketId)!;
          if (status && ENDED.has(status)) { await fire(item, `ticket ${ticketId} ${status}`); fired += 1; }
        }
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
