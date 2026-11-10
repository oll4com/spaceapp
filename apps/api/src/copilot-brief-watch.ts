import type { Pane, Room } from "@space/contracts";
import { atEmptyPrompt } from "./room-agent-autopilot.js";
import type { RoomPaneObservation } from "./room-pane-control.js";

/**
 * Operator 31/10 08:31 BKK («upgrade your code so this doesn't happen»: Alex/Emma sat idle at her prompt from 18:18 to 01:11 UTC while three
 * briefs waited, and nobody saw it). A brief-taking pane (App Studio, Marketing, Freelance, Security, Monitoring, Design, Video) idle at its
 * prompt with a brief PENDING for 15 minutes, or TAKEN with no update for 30, is waiting work its own minute pass did not start. Nous gets one
 * inbox line per pane (again at most hourly while it stays so), and the pane board and the world's pane line say "N briefs waiting since HH:MM".
 * The watch types nothing: each copilot's own pass kicks, and an operator's (or Nous's) pause or stop holds.
 */
export const BRIEF_PENDING_LATE_MS = 15 * 60_000;
/** A Design or Video request QUEUED at an idle prompt: its queue pass hands it over within a minute, so 5 minutes is already late (31/10 Cleo/Cody). */
export const BRIEF_QUEUED_LATE_MS = 5 * 60_000;
export const BRIEF_TAKEN_STALE_MS = 30 * 60_000;
export const BRIEF_LINE_REPEAT_MS = 60 * 60_000;

/** A brief or a Design/Video request: PENDING (or QUEUED) waits for the agent, TAKEN (or IN_PROGRESS) is being worked on. */
export type WaitingBrief = { id: string; status: string | null; createdAt: string; updatedAt?: string };
export type BriefsWaiting = { count: number; since: string; ids: string[]; held: string | null; why: string };
/** R22-1: Nous's newest space_pane_checked verdict on a pane (nous_pane_checks). */
export type BriefWatchCheck = { verdict: string | null; nextCheckAt: string | null; note: string | null };
/** R22-1 (1/11, Bruno/Iris recorded WAITING_DATE until 09:00 BKK got 3 lines 21:39-23:00 UTC): these verdicts hold the line until their next check. */
const HOLDING_VERDICTS = new Set(["WAITING_DATE", "WAITING_OPERATOR", "KEEP_OPEN"]);
export interface BriefWatchSource {
  briefs(owner: string, pane: Pane): Promise<WaitingBrief[]>;
  /** The pause or stop (the operator's or Nous's) that keeps the kickoff from being typed, else null: named to Nous, never overridden. */
  held(owner: string, pane: Pane): Promise<string | null>;
}

const PENDING = new Set(["PENDING", "QUEUED"]);
const TAKEN = new Set(["TAKEN", "IN_PROGRESS"]);

/** The briefs left waiting: PENDING ones 15 minutes old (QUEUED requests 5), TAKEN ones with no update for 30 minutes. */
export function lateBriefs(briefs: WaitingBrief[], now: number): WaitingBrief[] {
  return briefs.filter((brief) => PENDING.has(brief.status ?? "") ? now - Date.parse(brief.createdAt) >= (brief.status === "QUEUED" ? BRIEF_QUEUED_LATE_MS : BRIEF_PENDING_LATE_MS)
    : TAKEN.has(brief.status ?? "") && now - Date.parse(brief.updatedAt ?? brief.createdAt) >= BRIEF_TAKEN_STALE_MS);
}

export const briefsWaitingText = (waiting: Pick<BriefsWaiting, "count" | "since" | "held">) =>
  `${waiting.count} brief${waiting.count === 1 ? "" : "s"} waiting since ${waiting.since.slice(11, 16)} UTC${waiting.held ? ` (${waiting.held})` : ""}`;

/** Idle at its prompt: the CLI's own turn is over (an empty prompt, one Space reads as a draft, or a usage limit). */
export function idleWhy(observed: RoomPaneObservation): string | null {
  if (atEmptyPrompt(observed)) return "its prompt is empty, yet the kickoff did not start the work";
  if (observed.state !== "IDLE") return null;
  return observed.usageLimited ? "its CLI is at a usage limit" : "its prompt holds text Space reads as a draft, so the kickoff waits";
}

export function createCopilotBriefWatch(deps: {
  store: { listRooms(): Promise<Room[]> | Room[]; listPanes(roomId: string): Promise<Pane[]> | Pane[] };
  sources: Partial<Record<Pane["mode"], BriefWatchSource>>;
  inspect(pane: Pane): Promise<RoomPaneObservation>;
  check?(owner: string, paneId: string): Promise<BriefWatchCheck | null>;
  notice?(owner: string, key: string, line: string): Promise<unknown> | unknown;
  label(pane: Pane): string;
  log: { warn(details: unknown, message: string): void };
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const waiting = new Map<string, BriefsWaiting>();
  const told = new Map<string, number>();
  let running = false;

  async function pass(room: Room, pane: Pane, source: BriefWatchSource): Promise<boolean> {
    const owner = room.ownerUserId!;
    const late = lateBriefs(await source.briefs(owner, pane), now());
    const why = late.length ? idleWhy(await deps.inspect(pane)) : null;
    const check = why && deps.check ? await deps.check(owner, pane.id) : null;
    const recorded = check?.verdict && HOLDING_VERDICTS.has(check.verdict) && check.nextCheckAt ? check : null;
    if (!why || (recorded && Date.parse(recorded.nextCheckAt!) > now())) { waiting.delete(pane.id); return false; }
    const since = late.map((brief) => PENDING.has(brief.status ?? "") ? brief.createdAt : brief.updatedAt ?? brief.createdAt).sort()[0]!;
    const info = { count: late.length, since, ids: late.map((brief) => brief.id), held: await source.held(owner, pane), why };
    waiting.set(pane.id, info);
    if (!deps.notice || now() - (told.get(pane.id) ?? 0) < BRIEF_LINE_REPEAT_MS) return false;
    told.set(pane.id, now());
    await deps.notice(owner, `briefs-waiting:${pane.id}`, `${deps.label(pane)} (${pane.id}) in ${room.name} sits idle at its prompt with ${briefsWaitingText(info)}: `
      + `${info.ids.join(", ")}; ${why}.${recorded ? ` You recorded it ${recorded.verdict} until ${recorded.nextCheckAt!.slice(11, 16)} UTC${recorded.note ? ` ("${recorded.note}")` : ""}; that check has passed.` : ""} ${info.held ? "It stays held until the operator (or you) lifts the pause or stop." : "Read it (space_read_pane) and get it going: space_send_to_pane, or space_restart_pane."}`);
    return true;
  }

  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let lines = 0;
    try {
      const seen = new Set<string>();
      for (const room of await deps.store.listRooms()) {
        if (!room.ownerUserId) continue;
        for (const pane of await deps.store.listPanes(room.id)) {
          const source = deps.sources[pane.mode];
          if (!source || pane.isClosed) continue;
          seen.add(pane.id);
          try {
            if (await pass(room, pane, source)) lines += 1;
          } catch (error) {
            deps.log.warn({ err: error, paneId: pane.id }, "Copilot brief watch failed");
          }
        }
      }
      for (const paneId of [...waiting.keys()]) if (!seen.has(paneId)) waiting.delete(paneId);
    } finally {
      running = false;
    }
    return lines;
  }

  return { tick, waiting: (paneId: string): BriefsWaiting | null => waiting.get(paneId) ?? null };
}
export type CopilotBriefWatch = ReturnType<typeof createCopilotBriefWatch>;
