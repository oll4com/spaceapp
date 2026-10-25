import type { Pane } from "@space/contracts";
import {
  isClaudeDirectParityRuntime,
  isCodexDirectParityRuntime,
  isOpenCodeDirectParityRuntime
} from "./cli-parity.js";
import type { RoomPaneObservation } from "./room-pane-control.js";
import type { NativeTaskExecution } from "./room-task-telemetry.js";

/**
 * Working-time badge data (GET /api/panes/:id/working-time).
 *
 * The web badge polls this every 15 s per visible pane and consumes only
 * `cumulativeWorkingMs`; its live working/idle state comes from the terminal
 * pane itself. The cumulative value depends only on the pane's native task
 * timeline, so CLI panes read just that timeline instead of a full
 * `inspectRoomCli` (terminal screen snapshot, model settings, OpenCode agents,
 * Gemini model catalog, usage and account verification). Room Agent
 * inspections and their cache are not involved.
 */

export interface PaneWorkingTimeCliSession {
  sessionId: string;
  runtimeId: string;
  purpose: string;
  status: string;
  codexThreadId?: string | null;
}

export interface PaneWorkingTimeObservation {
  state: RoomPaneObservation["state"];
  tasks: NativeTaskExecution[];
}

export interface PaneWorkingTimeDeps<S extends PaneWorkingTimeCliSession> {
  /** The pane's active CLI session, else its most recent one (as `inspectRoomCli` selects it). */
  latestCliSession(paneId: string): Promise<S | null>;
  codexTasks(threadId: string): Promise<NativeTaskExecution[]>;
  /** Null when the OpenCode server or its history is unavailable. */
  openCodeTasks(session: S): Promise<NativeTaskExecution[] | null>;
  sessionRootPid(session: S): Promise<number | null>;
  geminiTasks(input: { paneId: string; sessionId: string; rootPid: number | null }): Promise<NativeTaskExecution[] | null>;
  claudeTasks(input: { paneId: string; sessionId: string; rootPid: number | null }): Promise<{ tasks: NativeTaskExecution[]; busy: boolean } | null>;
  /** Chat and harness panes keep the room controller's own inspection. */
  inspectNonCli(pane: Pane): Promise<PaneWorkingTimeObservation>;
  now?(): number;
  /** Dedupes multi-tab and concurrent polls; well below the 15 s client poll. */
  ttlMs?: number;
}

export interface PaneWorkingTimeResponse {
  paneId: string;
  cumulativeWorkingMs: number;
  isWorking: boolean;
  state: string;
}

const maxCachedPanes = 1024;

/**
 * Finished durations only, capped at the pane age. The badge adds the running
 * turn itself (screen timer), so counting it here showed it twice (10m vs 5m).
 */
export function paneWorkingTimeResponse(
  pane: Pick<Pane, "id" | "status" | "createdAt">,
  observation: PaneWorkingTimeObservation | null,
  nowMs: number
): PaneWorkingTimeResponse {
  let cumulativeWorkingMs = 0;
  let isWorking = pane.status === "RUNNING";
  let state: string = pane.status;
  if (observation) {
    state = observation.state;
    if (observation.state === "RUNNING") isWorking = true;
    for (const task of observation.tasks) {
      if (task.status !== "RUNNING" && typeof task.timing?.durationMs === "number" && task.timing.durationMs > 0) {
        cumulativeWorkingMs += task.timing.durationMs;
      }
    }
  }
  const paneAgeMs = pane.createdAt ? Math.max(0, nowMs - Date.parse(pane.createdAt)) : Infinity;
  cumulativeWorkingMs = Number.isFinite(paneAgeMs) ? Math.min(cumulativeWorkingMs, paneAgeMs) : cumulativeWorkingMs;
  return { paneId: pane.id, cumulativeWorkingMs: Math.round(cumulativeWorkingMs), isWorking, state };
}

export function createPaneWorkingTime<S extends PaneWorkingTimeCliSession>(deps: PaneWorkingTimeDeps<S>) {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 5_000;
  const cache = new Map<string, { at: number; observation: PaneWorkingTimeObservation | null }>();
  const inFlight = new Map<string, Promise<PaneWorkingTimeObservation | null>>();

  /** Task timeline of a terminal pane, selected by runtime exactly as `inspectRoomCli` does. */
  async function observeCli(pane: Pane): Promise<PaneWorkingTimeObservation> {
    const session = await deps.latestCliSession(pane.id);
    if (!session || session.purpose !== "NORMAL") return { state: "UNKNOWN", tasks: [] };
    let tasks: NativeTaskExecution[] = [];
    let busy = false;
    if (isCodexDirectParityRuntime(session.runtimeId)) {
      tasks = session.codexThreadId ? await deps.codexTasks(session.codexThreadId) : [];
    } else if (isOpenCodeDirectParityRuntime(session.runtimeId)) {
      tasks = await deps.openCodeTasks(session) ?? [];
    } else if (session.runtimeId === "cli:gemini") {
      const rootPid = await deps.sessionRootPid(session);
      // Without native turns the full inspection only has an untimed
      // placeholder task, which contributes nothing to working time.
      tasks = await deps.geminiTasks({ paneId: pane.id, sessionId: session.sessionId, rootPid }) ?? [];
    } else if (isClaudeDirectParityRuntime(session.runtimeId)) {
      const rootPid = await deps.sessionRootPid(session);
      const native = await deps.claudeTasks({ paneId: pane.id, sessionId: session.sessionId, rootPid });
      tasks = native?.tasks ?? [];
      busy = native?.busy ?? false;
    }
    const state: RoomPaneObservation["state"] = pane.isClosed || session.status === "EXITED" ? "EXITED"
      : session.status === "ERROR" ? "ERROR"
      : busy || tasks.some((task) => task.status === "RUNNING") ? "RUNNING" : "IDLE";
    return { state, tasks };
  }

  async function observe(pane: Pane): Promise<PaneWorkingTimeObservation | null> {
    const nowMs = now();
    const cached = cache.get(pane.id);
    if (cached && nowMs - cached.at < ttlMs) return cached.observation;
    const pending = inFlight.get(pane.id);
    if (pending) return pending;
    const request = (pane.mode === "TERMINAL" ? observeCli(pane) : deps.inspectNonCli(pane))
      .catch(() => null)
      .then((observation) => {
        cache.delete(pane.id);
        if (cache.size >= maxCachedPanes) cache.delete(cache.keys().next().value!);
        cache.set(pane.id, { at: now(), observation });
        return observation;
      })
      .finally(() => {
        if (inFlight.get(pane.id) === request) inFlight.delete(pane.id);
      });
    inFlight.set(pane.id, request);
    return request;
  }

  return {
    async read(pane: Pane): Promise<PaneWorkingTimeResponse> {
      return paneWorkingTimeResponse(pane, await observe(pane), now());
    }
  };
}
