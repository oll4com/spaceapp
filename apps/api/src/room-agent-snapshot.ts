import type { Pane, RoomAgentPaneActivity, RoomAgentPaneStripItem } from "@space/contracts";
import { nowIso } from "@space/runtime";
import type { DashboardActivityDetail, DashboardStatus } from "./agents-dashboard.js";

/** What the Room Agent knows about one open pane. Task text is untrusted pane data. */
export interface RoomAgentSnapshotPane extends RoomAgentPaneStripItem {
  taskSummary: string | null;
  steps: string[];
  cwd: string | null;
  isMaximized: boolean;
}

export interface RoomAgentSnapshot {
  roomId: string;
  panes: RoomAgentSnapshotPane[];
  counts: Record<"total" | "working" | "waiting" | "done" | "idle", number>;
  sampledAt: string;
}

export interface RoomAgentSnapshotProvider {
  snapshot(roomId: string): Promise<RoomAgentSnapshot>;
}

const activityByStatus: Record<DashboardStatus, RoomAgentPaneActivity> = {
  working: "WORKING", waiting: "WAITING", done: "DONE", idle: "IDLE"
};
// Panes that need the operator or the Room Agent come first, so a truncated prompt keeps them.
const activityRank: Record<RoomAgentPaneActivity, number> = { WAITING: 0, WORKING: 1, DONE: 2, UNKNOWN: 3, IDLE: 4, NONE: 5 };
const snapshotCacheMs = 4_000;

function clip(value: string | null | undefined, max: number): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isAgentPane(pane: Pane): boolean {
  return pane.mode === "CHAT" || (pane.mode === "TERMINAL" && pane.terminalRuntimeId !== "cli:root");
}

export function roomAgentSnapshotPane(pane: Pane, detail: DashboardActivityDetail | undefined): RoomAgentSnapshotPane {
  const metadata = pane.taskMetadata ?? null;
  const topic = metadata?.topics?.at(-1) ?? null;
  return {
    paneId: pane.id,
    paneName: pane.paneName ?? null,
    title: pane.title,
    mode: pane.mode,
    runtimeId: pane.terminalRuntimeId ?? pane.providerId ?? null,
    activity: !isAgentPane(pane) ? "NONE" : detail ? activityByStatus[detail.status] : "UNKNOWN",
    reason: clip(detail?.reason, 80),
    since: detail?.since ?? null,
    modelId: clip(detail?.modelId ?? metadata?.modelId ?? pane.modelId, 200),
    taskTitle: clip(topic?.title ?? metadata?.nativeTitle ?? null, 120),
    isMinimized: pane.isMinimized,
    taskSummary: clip(topic?.summary || metadata?.description || null, 400),
    steps: (metadata?.steps ?? []).slice(0, 5).map((step) => clip(step, 160)!).filter(Boolean),
    cwd: pane.cwd ?? null,
    isMaximized: pane.isMaximized
  };
}

export function buildRoomAgentSnapshot(roomId: string, panes: Pane[], details: Record<string, DashboardActivityDetail>): RoomAgentSnapshot {
  const open = panes.filter((pane) => !pane.isClosed).sort((left, right) => left.order - right.order);
  const items = open.slice(0, 64).map((pane) => roomAgentSnapshotPane(pane, details[pane.id]));
  const count = (activity: RoomAgentPaneActivity) => items.filter((pane) => pane.activity === activity).length;
  return {
    roomId,
    panes: items,
    counts: { total: items.length, working: count("WORKING"), waiting: count("WAITING"), done: count("DONE"), idle: count("IDLE") },
    sampledAt: nowIso()
  };
}

/**
 * Reads the room's open panes and their live activity through the Agents Dashboard reader
 * (metadata only: it never starts a CLI, attaches a transport or mounts a room).
 */
export function createRoomAgentSnapshotProvider(options: {
  listPanes(roomId: string): Promise<Pane[]>;
  readActivity?(roomId: string): Promise<{ data: Pane[]; details: Record<string, DashboardActivityDetail> }>;
  now?: () => number;
}): RoomAgentSnapshotProvider {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expires: number; snapshot: Promise<RoomAgentSnapshot> }>();
  async function read(roomId: string): Promise<RoomAgentSnapshot> {
    const activity = options.readActivity ? await options.readActivity(roomId).catch(() => null) : null;
    const panes = activity?.data ?? await options.listPanes(roomId);
    return buildRoomAgentSnapshot(roomId, panes, activity?.details ?? {});
  }
  return {
    snapshot(roomId) {
      const cached = cache.get(roomId);
      if (cached && cached.expires > now()) return cached.snapshot;
      const snapshot = read(roomId);
      cache.set(roomId, { expires: now() + snapshotCacheMs, snapshot });
      snapshot.catch(() => cache.delete(roomId));
      return snapshot;
    }
  };
}

export function roomAgentPaneStrip(snapshot: RoomAgentSnapshot): RoomAgentPaneStripItem[] {
  return snapshot.panes.map(({ taskSummary: _summary, steps: _steps, cwd: _cwd, isMaximized: _maximized, ...item }) => item);
}

function paneLabel(pane: RoomAgentSnapshotPane): string {
  return pane.paneName ?? pane.title;
}

function activityText(pane: RoomAgentSnapshotPane): string {
  const reason = pane.reason ? ` (${pane.reason})` : "";
  const since = pane.since ? ` since ${pane.since}` : "";
  return `${pane.activity}${reason}${since}`;
}

/** One short line that survives prompt truncation: who works, who waits and why. */
export function formatRoomActivityHeadline(snapshot: RoomAgentSnapshot): string {
  const names = (activity: RoomAgentPaneActivity, withReason = false) => snapshot.panes
    .filter((pane) => pane.activity === activity)
    .map((pane) => withReason && pane.reason ? `${paneLabel(pane)}: ${pane.reason}` : paneLabel(pane))
    .join(", ");
  const part = (label: string, count: number, list: string) => count ? `${label} ${count}${list ? ` (${list})` : ""}` : null;
  const parts = [
    part("waiting", snapshot.counts.waiting, names("WAITING", true)),
    part("working", snapshot.counts.working, names("WORKING")),
    part("done", snapshot.counts.done, names("DONE")),
    part("idle", snapshot.counts.idle, "")
  ].filter(Boolean);
  return `Room activity at ${snapshot.sampledAt}: ${snapshot.counts.total} open panes${parts.length ? `; ${parts.join("; ")}` : ""}.`;
}

/**
 * Pane lines for a prompt. Compact lines keep the Room Agent turn under its prompt budget;
 * full lines add the task summary, steps and working directory for chat answers.
 */
export function formatRoomPaneLines(snapshot: RoomAgentSnapshot, detail: "compact" | "full"): string[] {
  if (!snapshot.panes.length) return ["- No user-visible panes are currently open."];
  const panes = [...snapshot.panes].sort((left, right) => activityRank[left.activity] - activityRank[right.activity]);
  return panes.map((pane) => {
    const kind = pane.runtimeId ? `${pane.mode} ${pane.runtimeId}` : pane.mode;
    const flags = [pane.isMinimized ? "minimized" : null, pane.isMaximized ? "maximized" : null].filter(Boolean).join(", ");
    const head = `- ${paneLabel(pane)} [paneId=${pane.paneId}; ${kind}${pane.modelId ? `; model=${pane.modelId}` : ""}${flags ? `; ${flags}` : ""}]: ${activityText(pane)}`;
    const task = pane.taskTitle ? `; task "${pane.taskTitle}"` : pane.title && pane.title !== pane.paneName ? `; title "${clip(pane.title, 80)}"` : "";
    if (detail === "compact") {
      const summary = pane.activity === "WAITING" || pane.activity === "WORKING" ? clip(pane.taskSummary, 140) : null;
      return `${head}${task}${summary ? ` — ${summary}` : ""}`;
    }
    return [
      `${head}${task}`,
      pane.taskSummary ? `  summary: ${pane.taskSummary}` : null,
      pane.steps.length ? `  steps: ${pane.steps.join(" | ")}` : null,
      pane.cwd ? `  cwd: ${pane.cwd}` : null
    ].filter(Boolean).join("\n");
  });
}

const activityWords: Record<RoomAgentPaneActivity, { en: string; el: string }> = {
  WORKING: { en: "working", el: "δουλεύει" }, WAITING: { en: "waiting", el: "περιμένει" }, DONE: { en: "done", el: "τελείωσε" },
  IDLE: { en: "idle", el: "σε αναμονή" }, UNKNOWN: { en: "unknown", el: "άγνωστη κατάσταση" }, NONE: { en: "open", el: "ανοιχτό" }
};

/** Grounded answer from the snapshot alone, for when no chat model can answer: the state of every pane. */
export function roomSnapshotFallbackAnswer(snapshot: RoomAgentSnapshot, greek: boolean): string {
  const { total, working, waiting, done, idle } = snapshot.counts;
  const lines = snapshot.panes.map((pane) => {
    const kind = pane.runtimeId ?? pane.mode;
    const state = activityWords[pane.activity][greek ? "el" : "en"];
    const task = pane.taskTitle ? ` — ${pane.taskTitle}` : "";
    return `- **${paneLabel(pane)}** (${kind}): ${state}${pane.reason ? ` (${pane.reason})` : ""}${task}`;
  });
  const head = greek
    ? `Βλέπω ${total} ανοιχτά panes: ${working} δουλεύουν, ${waiting} περιμένουν, ${done} τελείωσαν, ${idle} σε αναμονή.`
    : `I see ${total} open panes: ${working} working, ${waiting} waiting, ${done} done, ${idle} idle.`;
  return [head, ...lines].join("\n");
}
