import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { Pane, Room } from "@space/contracts";
import { dashboardScreenState } from "./agents-dashboard.js";
import { cliInputProofRoomDescriptionPrefix } from "./proof-room-descriptions.js";

/**
 * Fixed tasks for proving Agents Dashboard status on real CLIs. STREAM is a tool-free answer long enough to be
 * seen working; SHELL asks for one harmless command, which most CLIs hold behind an approval question.
 */
export const dashboardProofTasks = {
  STREAM: "SPACE_DASHBOARD_PROOF_V1. Do not use any tools, files or the network. Write a numbered plain-text list of 150 short, distinct facts about lighthouses, one per line, then write SPACE_DASHBOARD_PROOF_DONE on the last line. Stop after this one response.",
  SHELL: "SPACE_DASHBOARD_PROOF_V1. Use your shell tool to run exactly this one command in the current directory and report its output: echo SPACE_DASHBOARD_PROOF_SHELL"
} as const;
export type DashboardProofTask = keyof typeof dashboardProofTasks;

const JOB_LIMIT_MS = 180_000;

/** Status-line evidence from an owned proof screen: bounded, with addresses and long secrets masked. */
export function redactProofScreenTail(screen: string, maxLines = 12): string[] {
  return screen.split("\n").filter(line => line.trim()).slice(-maxLines).map(line => line
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\b(?:sk|pk|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]{8,}/g, "<secret>")
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "<token>")
    .slice(0, 160));
}

export function createDashboardCliProofController(options: {
  store: SpaceStore;
  screen: (sessionId: string) => Promise<string>;
  send: (pane: Pane, prompt: string, traceId: string) => Promise<unknown>;
  interrupt: (pane: Pane, traceId: string) => Promise<unknown>;
}) {
  const jobs = new Map<string, { sessionId: string; timer: ReturnType<typeof setTimeout> }>();
  const proofRoom = (room: Room) => room.kind === "AGENT_PROOF" && Boolean(room.description?.startsWith(cliInputProofRoomDescriptionPrefix));
  async function scope(roomId: string) {
    const room = await options.store.getRoom(roomId);
    const panes = (await options.store.listPanes(roomId)).filter(pane => !pane.isClosed);
    const runtimeId = room.description?.slice(cliInputProofRoomDescriptionPrefix.length, -1);
    if (!proofRoom(room) || panes.length !== 1 || panes[0]!.mode !== "TERMINAL" || panes[0]!.terminalRuntimeId !== runtimeId || panes[0]!.cwd !== "/etc") {
      throw new SpaceConflictError("Dashboard proof requires an owned single-pane CLI input proof room.");
    }
    const session = await options.store.getActivePaneCliSession(panes[0]!.id);
    if (!session || session.purpose !== "NORMAL" || session.status === "EXITED" || session.status === "ERROR") {
      throw new SpaceConflictError("Dashboard proof session is not running.");
    }
    return { pane: panes[0]!, session };
  }
  const stop = async (roomId: string, traceId: string) => {
    const job = jobs.get(roomId);
    if (job) { clearTimeout(job.timer); jobs.delete(roomId); }
    const { pane } = await scope(roomId);
    await options.interrupt(pane, traceId);
  };
  return {
    async start(roomId: string, task: DashboardProofTask, traceId: string) {
      const { pane, session } = await scope(roomId);
      if (jobs.size >= 4 && !jobs.has(roomId)) throw new SpaceConflictError("Dashboard proof capacity reached; close owned fixtures.");
      const previous = jobs.get(roomId);
      if (previous) clearTimeout(previous.timer);
      // A forgotten fixture never keeps a CLI busy: the turn is interrupted when its time limit passes.
      const timer = setTimeout(() => { jobs.delete(roomId); void stop(roomId, `${traceId}:expired`).catch(() => {}); }, JOB_LIMIT_MS);
      timer.unref();
      jobs.set(roomId, { sessionId: session.sessionId, timer });
      await options.send(pane, dashboardProofTasks[task], traceId);
      return { submitted: true, task, roomId, paneId: pane.id, sessionId: session.sessionId, runtimeId: session.runtimeId, maxDurationMs: JOB_LIMIT_MS };
    },
    async interrupt(roomId: string, traceId: string) {
      await stop(roomId, traceId);
      return { interrupted: true, roomId };
    },
    async screen(roomId: string) {
      const { session } = await scope(roomId);
      const text = await options.screen(session.sessionId);
      return { roomId, sessionId: session.sessionId, runtimeId: session.runtimeId, ...dashboardScreenState(text), tail: redactProofScreenTail(text) };
    },
    dispose(roomId: string) {
      const job = jobs.get(roomId);
      if (job) { clearTimeout(job.timer); jobs.delete(roomId); }
    },
    close() {
      for (const job of jobs.values()) clearTimeout(job.timer);
      jobs.clear();
    }
  };
}
