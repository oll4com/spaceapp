import type { Pane, Room, RoomAgentEvent, RoomAgentEventKind, RoomAgentPaneActivity } from "@space/contracts";
import type { RoomAgentMonitorRepository, RoomPaneActivityRecord } from "@space/db";
import { SpaceNotFoundError } from "@space/runtime";
import type { DashboardActivityDetail } from "./agents-dashboard.js";
import { roomAgentSnapshotPane } from "./room-agent-snapshot.js";

/** Rooms with a working or waiting agent are read every few seconds; quiet rooms less often. */
export const ROOM_MONITOR_ACTIVE_MS = 3_000;
export const ROOM_MONITOR_QUIET_MS = 10_000;
export const ROOM_MONITOR_EMPTY_MS = 30_000;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 30_000;
/** Overlaps need git and the merge queue, so a room's are read at most once a minute. */
export const ROOM_MONITOR_OVERLAP_MS = 60_000;
const OVERLAP_STATUSES: RoomAgentEvent["status"][] = ["OPEN", "ESCALATED", "HANDLED", "ACKED"];

export interface RoomMonitorObservation { activity: RoomAgentPaneActivity; reason: string | null }

export interface RoomMonitorTransition { kind: RoomAgentEventKind; severity: RoomAgentEvent["severity"] }

function attentionKind(reason: string | null): RoomAgentEventKind {
  if (reason === "Usage limit") return "USAGE_LIMIT";
  if (reason === "Sign-in required") return "SIGN_IN";
  if (reason === "CLI error" || reason === "Run failed") return "ERROR";
  if (reason === "API error") return "STUCK";
  return "WAITING";
}

/**
 * Which event a pane's activity change is. A first sighting reports only a pane that already needs
 * attention, so a restart or a newly monitored room does not announce old completions.
 */
export function roomMonitorTransition(previous: RoomMonitorObservation | undefined, next: RoomMonitorObservation): RoomMonitorTransition | null {
  if (next.activity === "WAITING") {
    if (previous?.activity === "WAITING" && previous.reason === next.reason) return null;
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
    : kind === "USAGE_LIMIT" ? `${name} hit a usage limit`
      : kind === "SIGN_IN" ? `${name} needs sign-in`
        : kind === "ERROR" ? (reason === "Not running" ? `${name} stopped` : `${name} stopped with an error`)
          : kind === "STUCK" ? (reason === "API error" ? `${name} stopped on an API error` : `${name} seems stuck`)
            : `${name} is waiting: ${reason ?? "Needs input"}`;
  const detail = [task.title, task.summary].filter(Boolean).join(" — ") || null;
  return { title, detail };
}

export interface RoomAgentMonitorOptions {
  repository: RoomAgentMonitorRepository;
  listRooms(): Promise<Room[]>;
  /** Open panes and their live activity (the shared Agents Dashboard reader). */
  readActivity(roomId: string): Promise<{ data: Pane[]; details: Record<string, DashboardActivityDetail> }>;
  /** A stored event: publish it, let the Room Agent handle it, notify. */
  onEvent?(event: RoomAgentEvent): Promise<void> | void;
  /** Pane activity changed in a room without a stored event (dock refresh). */
  onActivity?(roomId: string): Promise<void> | void;
  /** A new attention event for the Room Agent to handle; never awaited, so a slow decision cannot hold the scan. */
  onAttention?(event: RoomAgentEvent): void;
  /** Where the panes' work collides; a title names one overlap for as long as it lasts. */
  readOverlaps?(roomId: string): Promise<Array<{ title: string; detail: string }>>;
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
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastPrune = 0;
  let lastSweep = 0;
  let lastWarning = 0;

  function forget(roomId: string) { known.delete(roomId); nextDue.delete(roomId); overlapDue.delete(roomId); overlapEvents.delete(roomId); }

  async function previousActivity(roomId: string) {
    let room = known.get(roomId);
    if (!room) {
      room = new Map((await options.repository.paneActivity(roomId)).map((record) => [record.paneId, record]));
      known.set(roomId, room);
    }
    return room;
  }

  async function resolveWaiting(roomId: string, paneId: string) {
    const pending = await options.repository.listEvents(roomId, { paneId, statuses: ["OPEN", "ESCALATED"], limit: 20 });
    for (const event of pending) {
      if (event.kind === "FINISHED") continue;
      const resolved = await options.repository.updateEvent(event.eventId, { status: "RESOLVED", decision: event.decision ?? "The pane moved on." }, ["OPEN", "ESCALATED"]);
      if (resolved) await options.onEvent?.(resolved);
    }
  }

  /** One event per overlap while it lasts: new overlaps go to the Room Agent, gone ones resolve. */
  async function syncOverlaps(roomId: string) {
    if (!options.readOverlaps || (overlapDue.get(roomId) ?? 0) > now()) return;
    overlapDue.set(roomId, now() + ROOM_MONITOR_OVERLAP_MS);
    const overlaps = await options.readOverlaps(roomId);
    let recorded = overlapEvents.get(roomId);
    if (!recorded) {
      const stored = await options.repository.listEvents(roomId, { statuses: OVERLAP_STATUSES, limit: 200 });
      recorded = new Map(stored.filter((event) => event.kind === "OVERLAP").map((event) => [event.title, event.eventId]));
      overlapEvents.set(roomId, recorded);
    }
    const current = new Set(overlaps.map((overlap) => overlap.title));
    for (const [title, eventId] of recorded) {
      if (current.has(title)) continue;
      recorded.delete(title);
      const resolved = await options.repository.updateEvent(eventId, { status: "RESOLVED", decision: "The overlap is gone." }, OVERLAP_STATUSES);
      if (resolved) await options.onEvent?.(resolved);
    }
    for (const overlap of overlaps) {
      if (recorded.has(overlap.title)) continue;
      const event = await options.repository.addEvent({ roomId, paneId: null, paneName: null, kind: "OVERLAP", severity: "ATTENTION",
        title: overlap.title.slice(0, 200), detail: overlap.detail.slice(0, 2000) });
      recorded.set(overlap.title, event.eventId);
      await options.onEvent?.(event);
      options.onAttention?.(event);
    }
  }

  /** Reads one room, stores changed activity and records the events its changes mean. Returns the next delay. */
  async function scanRoom(roomId: string): Promise<number> {
    const sample = await options.readActivity(roomId);
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
        if ((nextDue.get(room.id) ?? 0) > at) continue;
        try {
          nextDue.set(room.id, at + await scanRoom(room.id));
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
