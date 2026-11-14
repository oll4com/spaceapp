import { readdir, readFile } from "node:fs/promises";
import { PANE_HIBERNATED_REASON, paneHibernateMinutes, type Pane, type PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { DashboardActivityDetail } from "./agents-dashboard.js";
import { spaceTypedTexts } from "./cli-prompt-submit.js";

// Every minute: Sleep after N minutes holds to the minute, and an API restart (every queue deploy) never postpones the first sweep for long.
export const PANE_HIBERNATE_SWEEP_MS = 60_000;
/** A shell the CLI started this long after itself is a job it runs (a background shell, a dev server), not its own startup. */
const LATE_CHILD_S = 60;
// shortcut: assumes USER_HZ 100 (every Linux x86/arm build Space runs on); read getconf CLK_TCK if another kernel shows up.
const CLOCK_TICKS = 100;
const SHELLS = new Set(["bash", "sh", "dash", "zsh"]);

export interface HibernatablePane { pane: Pane; session: PaneCliSession; ownerUserId: string }

/**
 * Plan clipboard:YqhRIXfLAnfK step 2β (operator 13/11 14:47 BKK, decision Α): open CLI panes idle or done for longer than their
 * owner's Settings → Panes → Sleep after (default 30 minutes, Off = 0) stop to free their memory; the next message resumes them
 * (`wakeHibernatedPane`, app.ts). A pane working, waiting on the operator, with no known idle start, or running a background job never sleeps.
 */
export async function hibernatablePanes(deps: {
  store: Pick<SpaceStore, "listRooms" | "listPanes" | "getActivePaneCliSession" | "getUserSettings">;
  readDetails: (roomId: string) => Promise<Record<string, DashboardActivityDetail>>;
  /** Session ids among these whose CLI runs a background job; unknown (no /proc view, e.g. dev's private PID namespace) counts as none. */
  backgroundJobs: (sessions: PaneCliSession[]) => Promise<Set<string>>;
  now?: number;
}): Promise<HibernatablePane[]> {
  const now = deps.now ?? Date.now();
  const minutesByOwner = new Map<string, number>();
  const candidates: HibernatablePane[] = [];
  for (const room of await deps.store.listRooms()) {
    const ownerUserId = room.ownerUserId ?? "user:operator";
    if (!minutesByOwner.has(ownerUserId)) minutesByOwner.set(ownerUserId, paneHibernateMinutes(await deps.store.getUserSettings(ownerUserId)));
    const minutes = minutesByOwner.get(ownerUserId)!;
    if (minutes === 0) continue;
    const panes = (await deps.store.listPanes(room.id)).filter((pane) => !pane.isClosed && pane.mode === "TERMINAL" && pane.terminalRuntimeId !== "cli:root");
    if (panes.length === 0) continue;
    const details = await deps.readDetails(room.id);
    for (const pane of panes) {
      const detail = details[pane.id];
      if ((detail?.status !== "idle" && detail?.status !== "done") || !detail.since || now - Date.parse(detail.since) < minutes * 60_000) continue;
      const session = await deps.store.getActivePaneCliSession(pane.id);
      if (session?.purpose !== "NORMAL" || session.status !== "RUNNING" || session.sessionId !== detail.sessionId) continue;
      // 13/11 Felix/Max: a pane slept 27 s after the scheduler typed its task (reopened 24 s before), on the idle start the dashboard still had from
      // before. A session started, or given a prompt by Space (scheduler, Nous, Space Control), is idle at most since then.
      const lastTyped = spaceTypedTexts(session.sessionId, now).at(-1)?.at ?? 0;
      if (now - Math.max(Date.parse(session.startedAt), lastTyped) >= minutes * 60_000) candidates.push({ pane, session, ownerUserId });
    }
  }
  if (candidates.length === 0) return [];
  const busy = await deps.backgroundJobs(candidates.map((candidate) => candidate.session));
  return candidates.filter((candidate) => !busy.has(candidate.session.sessionId));
}

interface ProcInfo { comm: string; start: number; cmdline: string; children: number[] }

async function readProc(pid: number): Promise<ProcInfo | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const tasks = await readdir(`/proc/${pid}/task`);
    const children = (await Promise.all(tasks.map((tid) => readFile(`/proc/${pid}/task/${tid}/children`, "utf8").catch(() => ""))))
      .join(" ").split(/\s+/).filter(Boolean).map(Number);
    return {
      comm: stat.slice(stat.indexOf("(") + 1, close),
      start: Number(fields[19]),
      cmdline: (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).replaceAll("\0", " "),
      children
    };
  } catch {
    return null;
  }
}

/** True when a shell started ≥60 s after the CLI's root process still runs under it; MCP servers the CLI starts lazily do not count. */
export async function runsBackgroundJob(rootPid: number, read: (pid: number) => Promise<ProcInfo | null> = readProc): Promise<boolean> {
  const root = await read(rootPid);
  if (!root) return false;
  const pending = [...root.children];
  const seen = new Set<number>([rootPid]);
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = await read(pid);
    if (!proc) continue;
    if (SHELLS.has(proc.comm) && (proc.start - root.start) / CLOCK_TICKS >= LATE_CHILD_S && !/mcp/i.test(proc.cmdline)) return true;
    pending.push(...proc.children);
  }
  return false;
}

/** Stops each pane the selector returns, marked so its next message resumes it; one pane's failure never stops the others. */
export async function sweepHibernatePanes(deps: Parameters<typeof hibernatablePanes>[0] & {
  store: Pick<SpaceStore, "updatePaneCliSession" | "recordAuditEvent">;
  interrupt: (sessionId: string, transcript: { content: string; traceId: string }) => Promise<boolean>;
  makeTraceId: () => string;
  onError: (error: unknown, paneId: string) => void;
}): Promise<string[]> {
  const slept: string[] = [];
  for (const { pane, session, ownerUserId } of await hibernatablePanes(deps)) {
    const traceId = deps.makeTraceId();
    try {
      await deps.interrupt(session.sessionId, { content: PANE_HIBERNATED_REASON, traceId });
      await deps.store.updatePaneCliSession(session.sessionId,
        { status: "EXITED", statusReason: PANE_HIBERNATED_REASON, exitCode: null, isActive: false, endedAt: new Date().toISOString() }, traceId);
      await deps.store.recordAuditEvent({ actorUserId: null, traceId, action: "pane.hibernate", targetType: "pane", targetId: pane.id,
        metadata: { sessionId: session.sessionId, roomId: pane.roomId, ownerUserId } });
      slept.push(pane.id);
    } catch (error) {
      deps.onError(error, pane.id);
    }
  }
  return slept;
}
