import { z } from "zod";
import type { NousOverview, Pane, Room } from "@space/contracts";
import { NOUS_PANE_VERDICTS, type NousPaneCheck, type NousPaneChecksRepository, type NousPaneVerdict } from "@space/db";
import type { DashboardAgentsSample } from "../room-routes.js";
import { paneLabel } from "./digest.js";

/**
 * Nous's pane watch (operator request 2026-10-17, plan clipboard:MAongwnxq9Ro): Nous never forgets a pane. Every read of a
 * pane records when Nous last checked it; space_pane_checked adds a verdict and the next check. A pane is due when it was
 * never checked, at its next check, or after 30 minutes (60 while it works). AGENT_PROOF rooms are other agents' tests.
 */
const MINUTE = 60_000;
export const PANE_DUE_IDLE_MS = 30 * MINUTE;
export const PANE_DUE_WORKING_MS = 60 * MINUTE;

export const paneCheckedArgsSchema = z.object({
  room: z.string().trim().min(1).max(200).describe("The room's name as shown in the world (or its id)."),
  pane: z.string().trim().min(1).max(160).describe("The pane's name in that room."),
  verdict: z.enum(NOUS_PANE_VERDICTS).describe("OK_WORKING, WAITING_OPERATOR, WAITING_DATE (give nextCheckInMinutes), NEEDS_ACTION, BLOCKED, or OPERATOR_TEST (the operator's own test pane: drive it, never close it until they confirm)."),
  note: z.string().trim().max(200).optional().describe("One line: what you saw or what it waits for."),
  nextCheckInMinutes: z.number().int().min(1).max(20_160).optional().describe("When to look again; without it the 30/60-minute rule applies.")
});
export type PaneCheckedArgs = z.infer<typeof paneCheckedArgsSchema>;

export interface PaneWatchEntry {
  room: Room; pane: Pane; state: string | null; check: NousPaneCheck | null;
  dueAt: string; overdue: boolean;
}

/** Open panes of the owner's readable rooms (AGENT_PROOF rooms left out) with their last check and when they are due. */
export function paneWatchEntries(rooms: Array<{ room: Room; sample: DashboardAgentsSample | null }>, checks: NousPaneCheck[], now: number): PaneWatchEntry[] {
  const byPane = new Map(checks.map((check) => [check.paneId, check]));
  const entries: PaneWatchEntry[] = [];
  for (const { room, sample } of rooms) {
    if (room.kind === "AGENT_PROOF" || !sample) continue;
    for (const pane of sample.data) {
      if (pane.isClosed) continue;
      const state = sample.activity[pane.id] ?? null;
      const check = byPane.get(pane.id) ?? null;
      const due = !check ? now
        : check.nextCheckAt ? Date.parse(check.nextCheckAt)
        : Date.parse(check.checkedAt) + (state === "working" ? PANE_DUE_WORKING_MS : PANE_DUE_IDLE_MS);
      entries.push({ room, pane, state, check, dueAt: new Date(due).toISOString(), overdue: due <= now });
    }
  }
  return entries;
}

const verdictText = (verdict: NousPaneVerdict | null) => verdict ? verdict.toLowerCase().replace(/_/g, " ") : null;
const where = (entry: PaneWatchEntry) => `${entry.room.name}/${paneLabel(entry.pane)}`;

/** "checked 14:05 (waiting operator)" for a pane line of the world, in the owner's zone. */
export function paneCheckedText(entry: PaneWatchEntry | undefined, clock: (iso: string) => string): string | null {
  if (!entry) return null;
  if (!entry.check) return "never checked";
  const verdict = verdictText(entry.check.verdict);
  return `checked ${clock(entry.check.checkedAt)}${verdict ? ` (${verdict})` : ""}${entry.check.verdict === "OPERATOR_TEST" ? ", keep open" : ""}`;
}

/** The world's "Panes not checked" section; empty when every open pane is in date. */
export function renderPanesNotChecked(entries: PaneWatchEntry[], clock: (iso: string) => string): string {
  const due = entries.filter((entry) => entry.overdue);
  if (!due.length) return "";
  return ["## Panes not checked (never checked or due: read each, then record it with space_pane_checked)",
    ...due.map((entry) => `- ${where(entry)}${entry.state ? ` · ${entry.state}` : ""} · ${entry.check
      ? `checked ${clock(entry.check.checkedAt)}${entry.check.verdict ? ` (${verdictText(entry.check.verdict)})` : ""}, due ${clock(entry.dueAt)}`
      : "never checked"}${entry.check?.verdict === "OPERATOR_TEST" ? " · the operator's test pane: never close it" : ""}`)].join("\n");
}

/** The heartbeat's inbox line, null when no pane is due. */
export function paneRoundLine(entries: PaneWatchEntry[]): string | null {
  const due = entries.filter((entry) => entry.overdue);
  if (!due.length) return null;
  const names = due.slice(0, 10).map(where).join(", ");
  return `Pane round due: ${due.length} pane${due.length === 1 ? "" : "s"} overdue (${names}${due.length > 10 ? ", …" : ""}).`;
}

/** The dock's Panes cards. */
export function paneWatchOverview(entries: PaneWatchEntry[]): NonNullable<NousOverview["panes"]> {
  return entries.map((entry) => ({
    paneId: entry.pane.id, roomId: entry.room.id, room: entry.room.name, pane: paneLabel(entry.pane), state: entry.state,
    checkedAt: entry.check?.checkedAt ?? null, verdict: entry.check?.verdict ?? null, note: entry.check?.note ?? null,
    nextCheckAt: entry.check?.nextCheckAt ?? null, dueAt: entry.dueAt, overdue: entry.overdue
  }));
}

export function createNousPaneWatch(deps: { repository: NousPaneChecksRepository; now?: () => number }) {
  const now = deps.now ?? Date.now;
  return {
    list: (owner: string) => deps.repository.list(owner),
    /** Any read of a pane by Nous. */
    read: (owner: string, roomId: string, paneId: string) => deps.repository.record(owner, { paneId, roomId, at: new Date(now()).toISOString() }),
    async checked(owner: string, room: Room, pane: Pane, args: PaneCheckedArgs): Promise<{ ok: boolean; display: string; result: string }> {
      const at = now();
      const nextCheckAt = args.nextCheckInMinutes ? new Date(at + args.nextCheckInMinutes * MINUTE).toISOString() : null;
      if (args.verdict === "WAITING_DATE" && !nextCheckAt) {
        return { ok: false, display: "Give the next check", result: "WAITING_DATE needs nextCheckInMinutes: when to look again." };
      }
      await deps.repository.record(owner, { paneId: pane.id, roomId: room.id, at: new Date(at).toISOString(),
        verdict: { verdict: args.verdict, note: args.note?.trim() || null, nextCheckAt } });
      return { ok: true, display: `Checked ${paneLabel(pane)} in ${room.name}: ${verdictText(args.verdict)}`,
        result: `Recorded${nextCheckAt ? `; next check ${nextCheckAt}` : "; next check by the 30/60-minute rule"}.` };
    }
  };
}
export type NousPaneWatch = ReturnType<typeof createNousPaneWatch>;
