import type { Pane, Room, RoomAgentEvent, RoomAgentEventKind, RoomAgentPaneActivity } from "@space/contracts";
import type { RoomAgentMonitorRepository, RoomPaneActivityRecord } from "@space/db";
import { SpaceNotFoundError } from "@space/runtime";
import type { DashboardActivityDetail } from "./agents-dashboard.js";
import { roomAgentSnapshotPane } from "./room-agent-snapshot.js";
import { PACE_CAP_REASON_PREFIX } from "./agents-dashboard.js";

/** Rooms with a working or waiting agent are read every few seconds; quiet rooms less often. */
export const ROOM_MONITOR_ACTIVE_MS = 3_000;
export const ROOM_MONITOR_QUIET_MS = 10_000;
export const ROOM_MONITOR_EMPTY_MS = 30_000;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 30_000;
/** Overlaps need git and the merge queue, so a room's are read at most once a minute. */
export const ROOM_MONITOR_OVERLAP_MS = 60_000;
/**
 * R10-6 (28/10: "Dana and Emma change the same files" recorded 5 times in 2 hours, 09:02-10:59 UTC, each gone a few minutes later): an
 * overlap that comes back on the same files within the hour is not recorded again; a new file, or a merge conflict, is at once.
 */
export const ROOM_MONITOR_OVERLAP_REPEAT_MS = 60 * 60_000;
const OVERLAP_STATUSES: RoomAgentEvent["status"][] = ["OPEN", "ESCALATED", "HANDLED", "ACKED"];

/** Item 29a: a text Nous or the Room Agent sent this long before a wait opened still answered it (Alex/Jack 27/10: 7 s before). */
export const ROOM_MONITOR_ANSWER_LEAD_MS = 30_000;
const reachedPanes = new Map<string, number>();
const sentPanes = new Map<string, number>();
/** Space typed a text from Nous or the Room Agent into this pane (room-agent-tools; a queued one only once typed); a wait it ends counts as answered. */
export function notePaneReached(paneId: string, at = Date.now()): void { reachedPanes.set(paneId, at); sentPanes.set(paneId, at); }
/** W45 step 1: Nous or the Room Agent sent this pane a text (typed, or queued after its turn); an open OVERLAP naming the pane counts as coordinated. */
export function notePaneSent(paneId: string, at = Date.now()): void { sentPanes.set(paneId, at); }
/**
 * After Space types a prompt into a pane, its room is read at once and on every tick for this long, past the dashboard cache: a short
 * turn (c11 lab N4 5/11: a 4 s Claude Code reply) otherwise starts and ends between two quiet-room reads, is never seen working, and
 * files no FINISHED event nor turn-end report. A turn that starts later than this is a long one and keeps its room busy.
 */
export const ROOM_MONITOR_PROMPTED_MS = 60_000;
const promptedRooms = new Map<string, number>();
/** Space Control typed a prompt into a pane of this room (space-control-pane-actions controlSend). */
export function notePanePrompted(roomId: string, at = Date.now()): void { promptedRooms.set(roomId, at); }
/** W45 step 1: the decision an OVERLAP gets when an agent's text went to one of its panes (progress.ts waitCloser reads it as an agent's). */
export const OVERLAP_COORDINATED = "A coordination text Space sent for Nous or the Room Agent went to one of these panes.";

export interface RoomMonitorObservation { activity: RoomAgentPaneActivity; reason: string | null }

export interface RoomMonitorTransition { kind: RoomAgentEventKind; severity: RoomAgentEvent["severity"] }

function attentionKind(reason: string | null): RoomAgentEventKind {
  if (reason === "Usage limit") return "USAGE_LIMIT";
  if (reason === "Sign-in required") return "SIGN_IN";
  if (reason === "CLI error" || reason === "Run failed") return "ERROR";
  if (reason === "API error") return "STUCK";
  if (reason === "Question for you") return "QUESTION";
  return "WAITING";
}

/**
 * Which event a pane's activity change is. A first sighting reports only a pane that already needs
 * attention, so a restart or a newly monitored room does not announce old completions.
 */
export function roomMonitorTransition(previous: RoomMonitorObservation | undefined, next: RoomMonitorObservation): RoomMonitorTransition | null {
  if (next.activity === "WAITING") {
    if (previous?.activity === "WAITING" && previous.reason === next.reason) return null;
    // Space Gateway's pace cap holds the pane until its pace day opens and Space types continue then: a line, not a call for help (operator 6/11).
    if (next.reason?.startsWith(PACE_CAP_REASON_PREFIX)) return { kind: "USAGE_LIMIT", severity: "INFO" };
    return { kind: attentionKind(next.reason), severity: "ATTENTION" };
  }
  if (!previous || previous.activity === next.activity) return null;
  if (previous.activity === "WORKING" && next.activity === "IDLE" && next.reason === "Not running") return { kind: "ERROR", severity: "ATTENTION" };
  if ((previous.activity === "WORKING" || previous.activity === "WAITING") && next.activity === "DONE") return { kind: "FINISHED", severity: "INFO" };
  if (previous.activity === "WORKING" && next.activity === "IDLE") return { kind: "FINISHED", severity: "INFO" };
  return null;
}

/** English feed text; the task title is pane data and stays in the detail. */
export function roomMonitorEventText(kind: RoomAgentEventKind, name: string, reason: string | null, task: { title: string | null; summary: string | null }) {
  const title = kind === "FINISHED" ? `${name} finished`
    : kind === "USAGE_LIMIT" ? reason?.startsWith(PACE_CAP_REASON_PREFIX) ? `${name} held by pace cap until ${reason.slice(PACE_CAP_REASON_PREFIX.length)}` : `${name} hit a usage limit`
      : kind === "SIGN_IN" ? `${name} needs sign-in`
        : kind === "ERROR" ? (reason === "Not running" ? `${name} stopped` : `${name} stopped with an error`)
          : kind === "STUCK" ? (reason === "API error" ? `${name} stopped on an API error` : `${name} seems stuck`)
            : kind === "QUESTION" ? `${name} has a question for you`
              : `${name} is waiting: ${reason ?? "Needs input"}`;
  const detail = [task.title, task.summary].filter(Boolean).join(" — ") || null;
  return { title, detail };
}

export interface RoomAgentMonitorOptions {
  repository: RoomAgentMonitorRepository;
  listRooms(): Promise<Room[]>;
  /** Open panes and their live activity (the shared Agents Dashboard reader); fresh skips its few-second cache. */
  readActivity(roomId: string, fresh?: boolean): Promise<{ data: Pane[]; details: Record<string, DashboardActivityDetail> }>;
  /** A stored event: publish it, let the Room Agent handle it, notify. */
  onEvent?(event: RoomAgentEvent): Promise<void> | void;
  /** Pane activity changed in a room without a stored event (dock refresh). */
  onActivity?(roomId: string): Promise<void> | void;
  /** A new attention event for the Room Agent to handle; never awaited, so a slow decision cannot hold the scan. */
  onAttention?(event: RoomAgentEvent): void;
  /** Where the panes' work collides; a title names one overlap for as long as it lasts. */
  readOverlaps?(roomId: string): Promise<Array<{ title: string; detail: string; files?: string[]; paneIds?: string[] }>>;
  /** Every 30 s: open attention events of the monitored rooms (left by a restart or a failed handler). */
  onAttentionSweep?(roomIds: string[]): Promise<void>;
  now?: () => number;
  log?: { warn(details: unknown, message: string): void };
}

export function createRoomAgentMonitor(options: RoomAgentMonitorOptions) {
  const now = options.now ?? Date.now;
  const known = new Map<string, Map<string, RoomPaneActivityRecord>>();
  const nextDue = new Map<string, number>();
  const overlapDue = new Map<string, number>();
  /** Per room: overlap title → its event, seeded from the stored events once. */
  const overlapEvents = new Map<string, Map<string, string>>();
  /** R10-6: when each overlap was last recorded per room, and on which files. */
  const overlapSeen = new Map<string, Map<string, { at: number; files: Set<string> }>>();
  /** W45 step 1: per room, the open OVERLAP events and their panes, settled by an agent's text to one of them (every scan, no read). */
  const overlapOpen = new Map<string, Map<string, { at: number; paneIds: string[] }>>();
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastPrune = 0;
  let lastSweep = 0;
  let lastWarning = 0;

  function forget(roomId: string) { known.delete(roomId); nextDue.delete(roomId); overlapDue.delete(roomId); overlapEvents.delete(roomId); overlapOpen.delete(roomId); }

  async function previousActivity(roomId: string) {
    let room = known.get(roomId);
    if (!room) {
      room = new Map((await options.repository.paneActivity(roomId)).map((record) => [record.paneId, record]));
      known.set(roomId, room);
    }
    return room;
  }

  async function resolveWaiting(roomId: string, paneId: string) {
    const pending = await options.repository.listEvents(roomId, { paneId, statuses: ["OPEN", "ESCALATED"] });
    const reached = reachedPanes.get(paneId);
    for (const event of pending) {
      if (event.kind === "FINISHED") continue;
      const answered = (event.kind === "WAITING" || event.kind === "STUCK") && event.status === "OPEN" && reached !== undefined
        && reached >= Date.parse(event.createdAt) - ROOM_MONITOR_ANSWER_LEAD_MS;
      const resolved = await options.repository.updateEvent(event.eventId, answered ? { status: "HANDLED", decision: "A text Space sent for Nous or the Room Agent reached the pane and it moved on." }
        : { status: "RESOLVED", decision: event.decision ?? "The pane moved on." }, ["OPEN", "ESCALATED"]);
      if (resolved) await options.onEvent?.(resolved);
    }
  }

  /** W45 step 1: an open overlap one of whose panes got a text from Nous or the Room Agent since it was recorded is HANDLED at once. */
  async function settleOverlaps(roomId: string) {
    const open = overlapOpen.get(roomId);
    if (!open) return;
    for (const [eventId, entry] of open) {
      if (!entry.paneIds.some((paneId) => (sentPanes.get(paneId) ?? -1) >= entry.at)) continue;
      open.delete(eventId);
      const handled = await options.repository.updateEvent(eventId, { status: "HANDLED", decision: OVERLAP_COORDINATED }, ["OPEN", "ESCALATED"]);
      if (handled) await options.onEvent?.(handled);
    }
  }

  /** One event per overlap while it lasts: new overlaps go to the Room Agent, gone ones resolve. */
  async function syncOverlaps(roomId: string) {
    if (!options.readOverlaps || (overlapDue.get(roomId) ?? 0) > now()) return;
    overlapDue.set(roomId, now() + ROOM_MONITOR_OVERLAP_MS);
    const overlaps = await options.readOverlaps(roomId);
    let recorded = overlapEvents.get(roomId);
    const open = overlapOpen.get(roomId) ?? new Map<string, { at: number; paneIds: string[] }>();
    overlapOpen.set(roomId, open);
    if (!recorded) {
      const stored = (await options.repository.listEvents(roomId, { statuses: OVERLAP_STATUSES })).filter((event) => event.kind === "OVERLAP");
      recorded = new Map(stored.map((event) => [event.title, event.eventId]));
      for (const event of stored) if (event.status === "OPEN" || event.status === "ESCALATED") open.set(event.eventId, { at: Date.parse(event.createdAt), paneIds: [] });
      overlapEvents.set(roomId, recorded);
    }
    const current = new Set(overlaps.map((overlap) => overlap.title));
    for (const [title, eventId] of recorded) {
      if (current.has(title)) continue;
      recorded.delete(title);
      open.delete(eventId);
      // W45 step 1: an overlap an agent handled keeps who and when (the unblocking speed); only an unanswered one resolves.
      const resolved = await options.repository.updateEvent(eventId, { status: "RESOLVED", decision: "The overlap is gone." }, ["OPEN", "ESCALATED"]);
      if (resolved) await options.onEvent?.(resolved);
    }
    for (const overlap of overlaps) {
      const entry = open.get(recorded.get(overlap.title) ?? "");
      if (entry) entry.paneIds = overlap.paneIds ?? [];
    }
    const seen = overlapSeen.get(roomId) ?? new Map<string, { at: number; files: Set<string> }>();
    overlapSeen.set(roomId, seen);
    for (const overlap of overlaps) {
      if (recorded.has(overlap.title)) continue;
      const before = seen.get(overlap.title);
      const files = new Set(overlap.files ?? []);
      const conflict = / hit a merge conflict$/.test(overlap.title);
      if (!conflict && before && now() - before.at < ROOM_MONITOR_OVERLAP_REPEAT_MS && [...files].every((file) => before.files.has(file))) continue;
      seen.set(overlap.title, { at: now(), files });
      const event = await options.repository.addEvent({ roomId, paneId: null, paneName: null, kind: "OVERLAP", severity: "ATTENTION",
        title: overlap.title.slice(0, 200), detail: overlap.detail.slice(0, 2000) });
      recorded.set(overlap.title, event.eventId);
      open.set(event.eventId, { at: Date.parse(event.createdAt), paneIds: overlap.paneIds ?? [] });
      await options.onEvent?.(event);
      options.onAttention?.(event);
    }
  }

  /** Reads one room, stores changed activity and records the events its changes mean. Returns the next delay. */
  async function scanRoom(roomId: string, fresh = false): Promise<number> {
    const sample = await options.readActivity(roomId, fresh);
    const previous = await previousActivity(roomId);
    const changed: RoomPaneActivityRecord[] = [];
    let busy = false;
    let agents = 0;
    for (const pane of sample.data) {
      if (pane.isClosed) continue;
      const item = roomAgentSnapshotPane(pane, sample.details[pane.id]);
      if (item.activity === "NONE") continue;
      agents += 1;
      if (item.activity === "WORKING" || item.activity === "WAITING") busy = true;
      // A pane the reader could not classify keeps its last known state instead of flapping.
      if (item.activity === "UNKNOWN") continue;
      const before = previous.get(pane.id);
      const record: RoomPaneActivityRecord = { paneId: pane.id, roomId, activity: item.activity, reason: item.reason, since: item.since };
      if (before && before.activity === record.activity && before.reason === record.reason) continue;
      changed.push(record);
      previous.set(pane.id, record);
      // A pane that moved on from a question or a stop (answered, restarted) leaves no open problem to announce again.
      if ((before?.activity === "WAITING" || before?.reason === "Not running") && record.activity !== "WAITING") await resolveWaiting(roomId, pane.id);
      const transition = roomMonitorTransition(before, record);
      if (!transition) continue;
      if (transition.severity === "ATTENTION") {
        // One open attention event per pane and question.
        const open = await options.repository.listEvents(roomId, { paneId: pane.id, statuses: ["OPEN", "ESCALATED"], limit: 5 });
        if (open.some((event) => event.kind === transition.kind)) continue;
      }
      const name = item.paneName ?? item.title;
      const text = roomMonitorEventText(transition.kind, name, item.reason, { title: item.taskTitle, summary: item.taskSummary });
      const event = await options.repository.addEvent({ roomId, paneId: pane.id, paneName: item.paneName, kind: transition.kind,
        severity: transition.severity, title: text.title, detail: text.detail });
      await options.onEvent?.(event);
      if (event.severity === "ATTENTION") options.onAttention?.(event);
    }
    if (changed.length) {
      await options.repository.savePaneActivity(changed);
      await options.onActivity?.(roomId);
    }
    await settleOverlaps(roomId).catch((error) => options.log?.warn({ err: error, roomId }, "Room Agent monitor could not settle an overlap."));
    await syncOverlaps(roomId).catch((error) => {
      if (!(error instanceof SpaceNotFoundError)) options.log?.warn({ err: error, roomId }, "Room Agent monitor could not read the room's overlaps.");
    });
    return busy ? ROOM_MONITOR_ACTIVE_MS : agents ? ROOM_MONITOR_QUIET_MS : ROOM_MONITOR_EMPTY_MS;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const at = now();
      const [rooms, disabled] = await Promise.all([options.listRooms(), options.repository.disabledRooms()]);
      // A deleted room (an Agent Proof room torn down) leaves no state behind.
      const listed = new Set(rooms.map((room) => room.id));
      for (const roomId of nextDue.keys()) if (!listed.has(roomId)) forget(roomId);
      for (const room of rooms) {
        if (room.archivedAt || room.kind === "CLI_RECOVERY" || disabled.has(room.id)) { known.delete(room.id); nextDue.delete(room.id); continue; }
        const prompted = promptedRooms.get(room.id);
        const hot = prompted !== undefined && at - prompted < ROOM_MONITOR_PROMPTED_MS;
        if (prompted !== undefined && !hot) promptedRooms.delete(room.id);
        if (!hot && (nextDue.get(room.id) ?? 0) > at) continue;
        try {
          nextDue.set(room.id, at + await scanRoom(room.id, hot));
        } catch (error) {
          nextDue.set(room.id, at + ROOM_MONITOR_QUIET_MS);
          // A room deleted while it was read is dropped on the next tick; only real failures warn.
          if (error instanceof SpaceNotFoundError) continue;
          if (at - lastWarning > 60_000) { lastWarning = at; options.log?.warn({ err: error, roomId: room.id }, "Room Agent monitor could not read a room."); }
        }
      }
      if (options.onAttentionSweep && at - lastSweep > SWEEP_EVERY_MS) {
        lastSweep = at;
        await options.onAttentionSweep(rooms.filter((room) => !room.archivedAt && room.kind !== "CLI_RECOVERY" && !disabled.has(room.id)).map((room) => room.id))
          .catch((error) => options.log?.warn({ err: error }, "Room Agent attention sweep failed."));
      }
      if (at - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = at;
        await options.repository.pruneEvents(new Date(at - EVENT_RETENTION_MS).toISOString());
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    scanRoom,
    start(intervalMs = 1_000) {
      if (timer) return;
      timer = setInterval(() => void tick().catch((error) => options.log?.warn({ err: error }, "Room Agent monitor tick failed.")), intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    /** A room switched off forgets its state, so switching it on does not replay old changes. */
    forget,
  };
}
export type RoomAgentMonitor = ReturnType<typeof createRoomAgentMonitor>;
