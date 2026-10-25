import type { Pane, PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

export type DashboardStatus = "working" | "waiting" | "done" | "idle";

/**
 * Why the dashboard shows a status. Only fixed reasons, timestamps and model ids:
 * never prompt, screen, transcript or error text.
 */
export interface DashboardActivityDetail {
  status: DashboardStatus;
  /** Short fixed English reason, e.g. "Permission prompt" or "Not running". */
  reason?: string | null;
  /** When the current status began: turn start, completion or block. */
  since?: string | null;
  modelId?: string | null;
  /** native: the CLI's own state; screen: terminal heuristic; session/run: Space records. */
  source: "native" | "screen" | "session" | "run";
  /** Fixed id of the screen rule that decided a screen status, for diagnostics; never screen text. */
  rule?: string;
}

export type DashboardCliActivity = DashboardStatus | DashboardActivityDetail | null;

function iso(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Normalize a runtime reader result; bare statuses come from screen heuristics. */
export function dashboardDetail(value: DashboardStatus | DashboardActivityDetail, fallbackSource: DashboardActivityDetail["source"] = "screen"): DashboardActivityDetail {
  if (typeof value === "string") return { status: value, source: fallbackSource };
  return { ...value, since: iso(value.since), reason: value.reason?.slice(0, 80) || null };
}

// Metadata reads only: never start a CLI, attach a transport or mount a room.
export async function readDashboardActivity(panes: Pane[], store: SpaceStore,
  readCliStatus: (session: PaneCliSession) => Promise<DashboardCliActivity>) {
  const activity: Record<string, DashboardStatus> = {};
  const details: Record<string, DashboardActivityDetail> = {};
  const set = (paneId: string, detail: DashboardActivityDetail) => { activity[paneId] = detail.status; details[paneId] = detail; };
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, panes.length) }, async () => {
    while (cursor < panes.length) {
      const pane = panes[cursor++]!;
      if (pane.isClosed) continue;
      if (pane.mode === "TERMINAL" && pane.terminalRuntimeId !== "cli:root") {
        const session = await store.getActivePaneCliSession(pane.id);
        if (!session || session.status === "EXITED") {
          set(pane.id, { status: "idle", reason: "Not running", source: "session" });
        } else if (session.purpose !== "NORMAL") {
          set(pane.id, { status: "idle", reason: session.purpose === "LOGIN" ? "Sign-in session" : "Not running", source: "session" });
        } else if (session.status === "ERROR") {
          set(pane.id, { status: "waiting", reason: "CLI error", since: iso(session.updatedAt), source: "session" });
        } else {
          // One unreadable CLI must not fail the whole room; its pane keeps the client fallback.
          const status = await readCliStatus(session).catch(() => null);
          if (status !== null) {
            const detail = dashboardDetail(status);
            set(pane.id, { ...detail, modelId: detail.modelId ?? session.modelId ?? null });
          }
        }
      } else if (pane.mode === "CHAT") {
        const session = await store.getActiveSpaceAgentSession(pane.id);
        if (!session?.isActive) continue;
        const run = await store.getLatestSpaceAgentRun(session.sessionId);
        const modelId = run?.runtimeModelAtStart ?? null;
        if (run?.status === "RUNNING" || run?.status === "QUEUED") {
          set(pane.id, { status: "working", since: iso(run.startedAt ?? run.createdAt), modelId, source: "run" });
        } else if (run?.status === "COMPLETED") {
          set(pane.id, { status: "done", since: iso(run.completedAt ?? run.updatedAt), modelId, source: "run" });
        } else if (run?.status === "FAILED") {
          set(pane.id, { status: "waiting", reason: "Run failed", since: iso(run.completedAt ?? run.updatedAt), modelId, source: "run" });
        } else if (run?.status === "INTERRUPTED") {
          set(pane.id, { status: "idle", reason: "Interrupted", since: iso(run.completedAt ?? run.updatedAt), modelId, source: "run" });
        } else {
          set(pane.id, { status: "idle", source: "run" });
        }
      }
    }
  }));
  return { activity, details };
}

/** Claude Code's own session status is authoritative over screen heuristics. */
export function claudeDashboardActivity(native: {
  status?: string | null; busy: boolean; waitingFor?: string | null; statusUpdatedAt?: string | null; modelId?: string | null; apiError?: boolean;
  tasks: Array<{ status: string; timing: { startedAt: string | null; completedAt: string | null } }>;
}): DashboardActivityDetail {
  const latest = native.tasks.at(-1);
  const modelId = native.modelId ?? null;
  if (native.busy || native.status === "busy" || native.status === "shell") {
    return { status: "working", since: iso(latest?.status === "RUNNING" ? latest.timing.startedAt : null) ?? iso(native.statusUpdatedAt), modelId, source: "native" };
  }
  if (native.status === "waiting") {
    return { status: "waiting", reason: waitingReason(native.waitingFor), since: iso(native.statusUpdatedAt), modelId, source: "native" };
  }
  // Claude ends a turn cut off by a server error like a finished one; the Room Agent tells it to continue.
  if (native.apiError) return { status: "waiting", reason: "API error", since: iso(native.statusUpdatedAt), modelId, source: "native" };
  if (latest?.status === "COMPLETED") {
    return { status: "done", since: iso(latest.timing.completedAt) ?? iso(native.statusUpdatedAt), modelId, source: "native" };
  }
  return { status: "idle", reason: latest?.status === "INTERRUPTED" ? "Interrupted" : null, since: iso(native.statusUpdatedAt), modelId, source: "native" };
}

/** Claude names what it waits for in plain words; show a fixed label, never free text. */
function waitingReason(waitingFor: string | null | undefined): string {
  const value = waitingFor?.toLowerCase() ?? "";
  if (value.includes("permission")) return "Permission prompt";
  if (value.includes("plan")) return "Plan approval";
  if (value.includes("question") || value.includes("input")) return "Question for you";
  return "Needs input";
}

/** The last OpenCode message decides a non-busy session's outcome. */
export function openCodeDashboardActivity(messages: unknown[]): DashboardActivityDetail | null {
  const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const infos = messages.map(message => record(record(message).info))
    .sort((a, b) => Number(record(a.time).created ?? 0) - Number(record(b.time).created ?? 0));
  const last = infos.at(-1);
  if (!last || last.role !== "assistant") return null;
  const time = record(last.time);
  const modelId = typeof last.modelID === "string" && last.modelID ? last.modelID : null;
  if (last.error) {
    const aborted = record(last.error).name === "MessageAbortedError";
    return { status: aborted ? "idle" : "waiting", reason: aborted ? "Interrupted" : "Run failed", since: iso(time.completed ?? time.created), modelId, source: "native" };
  }
  if (iso(time.completed) && last.finish && last.finish !== "tool-calls") {
    return { status: "done", since: iso(time.completed), modelId, source: "native" };
  }
  return null;
}

type ScreenState = "RUNNING" | "IDLE" | "WAITING_FOR_INPUT" | "UNKNOWN";
interface NativeTurnLike { status: string; aborted?: boolean; timing: { startedAt: string | null; completedAt: string | null } }

/**
 * Screen rules for the dashboard, checked in order: a question for the operator, then a busy hint, then an
 * empty composer. Busy hints win over the composer because several CLIs (Qwen, Qoder, Gemini) keep their input
 * placeholder visible while a turn runs. Busy and idle hints are read only from the bottom of the screen, where
 * every supported TUI draws its status line (Reasonix keeps six footer lines below it), so transcript text such as "- working tree clean" cannot hold an
 * agent in Working.
 */
const screenRules: ReadonlyArray<{ id: string; state: ScreenState; lines: number; pattern: RegExp }> = [
  { id: "approval", state: "WAITING_FOR_INPUT", lines: 24, pattern: /select (?:a |an )?(?:session|model|option)|enter to (?:confirm|select)|allow (?:once|always)|approve this|do you want to (?:proceed|allow|run|make this edit|create|apply)|\byes,? (?:allow|and don't ask|proceed)\b|waiting for (?:your )?(?:approval|confirmation|permission)|\((?:y\/n|y\/n\/a)\)|\[y\/n\]|\bpermission (?:required|request)\b/i },
  // A menu waiting for a pick, e.g. Grok's plan upgrade question.
  { id: "choice", state: "WAITING_FOR_INPUT", lines: 6, pattern: /↑\s*\/\s*↓\s*(?:to\s+)?navigate[^\n]*\benter\s*:?\s*(?:to\s+)?(?:submit|select|confirm)\b/i },
  // Grok shows "Ctrl+c:cancel"; Gemini "esc to cancel"; Droid "Press ESC to stop"; OpenCode "esc interrupt".
  { id: "busy-key", state: "RUNNING", lines: 16, pattern: /\b(?:esc|escape)\b\s*(?:to\s+)?(?:interrupt|cancel|stop|abort)\b|\bctrl\s*\+\s*c\s*[:\s]\s*(?:to\s+)?(?:interrupt|cancel|stop|abort)\b/i },
  { id: "busy-thinking", state: "RUNNING", lines: 14, pattern: /\bthinking(?:\.{3}|…)|running\s+(?:background\s+)?(?:command|task|subagent|process)(?:\.{3}|…)/i },
  // Oh My Pi shows "⎋ Working…" and a status rail that starts "⠹ 2s >" instead of its idle "π >"; Claude's
  // spinner frames include "* Levitating…  24s" when its native status is unreadable.
  { id: "busy-spinner", state: "RUNNING", lines: 14, pattern: /^[ \t]*[\u2800-\u28ff✶✻✽✢✳◐◓◑◒⎋][ \t]*\p{L}[^\n]{0,60}?(?:…|\.{3})|^[ \t]*[\u2800-\u28ff][ \t]*\d+(?:\.\d+)?s\b|^[ \t]*[*·][ \t]*\p{L}+…[ \t]+\d+s\b|^[ \t]*[\u2800-\u28ff•●*o|/\\-][ \t]*working[ \t]*(?:$|[.…(·•])|\bworking[ \t]*[(·•][ \t]*\d+[a-z]*/imu },
  { id: "busy-task", state: "RUNNING", lines: 14, pattern: /(?:^|\n)\s*[•●*o-]?\s*\[(?:\d{1,2}:\d{2}:\d{2}(?:\s*[ap]m)?|task-[a-z0-9_-]+|\d+)\]\s+[^\n]+?\brunning(?:\s*\([^)]*\))?\s*$/im },
  { id: "composer", state: "IDLE", lines: 16, pattern: /ask (?:codex|opencode|gemini|claude)?(?:\s+to do)?\s+anything|ask anything|type (?:your )?message|send a message|try something|plan, search, build anything/i },
  { id: "prompt", state: "IDLE", lines: 6, pattern: /(?:^|\n)\s*(?:[│┃|]\s*)?[❯›>→]\s*[^\n]*$/m },
];

/**
 * A turn that stopped on the account's quota, plan or balance (Grok's upgrade menu, Cursor's usage limit and
 * free-plan model refusal, Droid without a subscription, DeepSeek's insufficient balance). Qoder's "Credits exhausted" is only a notice: it keeps answering on a fallback model.
 */
const usageLimitPattern = /\bmonthly quota\b|\byou(?:'ve| have)? (?:hit|reached|exceeded|run out of) (?:your |the )?(?:free |daily |weekly |monthly )?(?:usage|rate|quota|credit)s?(?: limit)?\b|\b(?:usage|quota) limit (?:reached|exceeded)\b|\bquota (?:exceeded|exhausted)\b|\bupgrade (?:your )?plans? to continue\b|\bno active subscription\b|\binsufficient (?:balance|credits?|funds|quota)\b|\byou(?:'ve| have)? hit your (?:session |weekly |opus |sonnet )?limit\b|\/rate-limit-options\b/i;

const signInPattern = /\bsign in at\b|\bdevice (?:login|code)\b|\blogin code\b|\b(?:log|sign) in to continue\b/i;

/** The CLI stopped on its account's quota, plan or balance and waits at its composer (the dashboard's "Usage limit"). */
export function screenShowsAccountLimit(screen: string): boolean {
  return dashboardScreenState(screen).reason === "Usage limit";
}

/**
 * The CLI stopped at its account's usage limit. Claude's transcript says it exactly: this session's latest answer is a 429 rate
 * limit whose reset has not passed, so a limit an earlier session (before a move or restart) hit, or one already reset, no longer
 * counts while its text is still on screen. Other CLIs, and Claude reads without the field, go by the screen.
 */
export function cliUsageLimited(screen: string, native?: { rateLimit?: { at: string | null; resetsAt: string | null } | null } | null,
  sessionStartedAt?: string | null, now = Date.now()): boolean {
  if (!native || native.rateLimit === undefined) return screenShowsAccountLimit(screen);
  const limit = native.rateLimit;
  return Boolean(limit && !(limit.at && sessionStartedAt && Date.parse(limit.at) < Date.parse(sessionStartedAt))
    && !(limit.resetsAt && Date.parse(limit.resetsAt) <= now));
}

/** Classify a bounded room screen for the dashboard; returns the fixed id of the deciding rule. */
export function dashboardScreenState(screen: string): { state: ScreenState; rule: string; reason?: string } {
  // A finished background job keeps its "esc to interrupt" hint beside the idle composer.
  const lines = screen.replace(/waiting for background terminal[^\n]*(?:esc(?:ape)? to interrupt|\/ps to view|\/stop to close)[^\n]*/gi, "")
    .split("\n").filter(line => line.trim());
  // A quota stop right above the composer means the agent cannot continue until the operator acts.
  const limited = usageLimitPattern.test(lines.slice(-14).join("\n"));
  // Muse and other device-code logins wait for the operator to approve a sign-in.
  const signIn = signInPattern.test(lines.slice(-14).join("\n"));
  for (const rule of screenRules) {
    if (!rule.pattern.test(lines.slice(-rule.lines).join("\n"))) continue;
    if (rule.state === "WAITING_FOR_INPUT") return { state: rule.state, rule: rule.id, ...(limited ? { reason: "Usage limit" } : signIn ? { reason: "Sign-in required" } : {}) };
    if (rule.state === "IDLE" && limited) break;
    return { state: rule.state, rule: rule.id };
  }
  return limited ? { state: "WAITING_FOR_INPUT", rule: "usage-limit", reason: "Usage limit" } : { state: "UNKNOWN", rule: "none" };
}

export interface CliDashboardActivityReaders {
  /** Bounded room screen text; never starts or attaches a CLI. */
  screenText(session: PaneCliSession): Promise<string>;
  codexTurn(session: PaneCliSession): Promise<{ status: "PENDING" | "RUNNING" | "COMPLETED" | "ABORTED"; lastActivityAtMs?: number }>;
  /** Null when the OpenCode server is unavailable; `messages` holds at most the latest few. */
  openCode(session: PaneCliSession): Promise<{ busy: boolean; messages: () => Promise<unknown[]> } | null>;
  geminiTurns(session: PaneCliSession): Promise<NativeTurnLike[] | null>;
  claude(session: PaneCliSession): Promise<Parameters<typeof claudeDashboardActivity>[0] | null>;
}

const screenActivity = ({ state, rule, reason }: { state: ScreenState; rule: string; reason?: string }): DashboardActivityDetail =>
  state === "RUNNING" ? { status: "working", source: "screen", rule }
    : state === "WAITING_FOR_INPUT" ? { status: "waiting", reason: reason ?? "Needs input", source: "screen", rule }
      : { status: "idle", source: "screen", rule };

/** A screen that stops showing busy hints must stay quiet this long before the turn counts as finished. */
export const DASHBOARD_SCREEN_SETTLE_MS = 4_000;
const TRACKED_SESSION_TTL_MS = 6 * 60 * 60_000;

interface TrackedActivity { status: DashboardStatus; since: string | null; settleSince: string | null; seenAt: number }

/**
 * Remembers each session's last status so every runtime reports when its current state began, and screen-only
 * CLIs, which never announce completion, show Done once a turn they were seen working on goes quiet.
 */
function createActivityTracker(now: () => number) {
  const tracked = new Map<string, TrackedActivity>();
  return (sessionId: string, detail: DashboardActivityDetail): DashboardActivityDetail => {
    const at = now();
    if (tracked.size > 200) for (const [key, entry] of tracked) if (at - entry.seenAt > TRACKED_SESSION_TTL_MS) tracked.delete(key);
    const previous = tracked.get(sessionId);
    const atIso = new Date(at).toISOString();
    if (detail.source === "screen" && detail.status === "idle" && (previous?.status === "working" || previous?.status === "done")) {
      if (previous.status === "done") {
        tracked.set(sessionId, { ...previous, seenAt: at });
        return { ...detail, status: "done", since: previous.since };
      }
      const settleSince = previous.settleSince ?? atIso;
      if (at - Date.parse(settleSince) < DASHBOARD_SCREEN_SETTLE_MS) {
        tracked.set(sessionId, { ...previous, settleSince, seenAt: at });
        return { ...detail, status: "working", since: previous.since };
      }
      tracked.set(sessionId, { status: "done", since: settleSince, settleSince: null, seenAt: at });
      return { ...detail, status: "done", since: settleSince };
    }
    // Idle has no meaningful start; working and waiting start when first observed unless the CLI says otherwise.
    const carried = previous?.status === detail.status ? previous.since : null;
    const since = detail.since ?? carried ?? (detail.status === "working" || detail.status === "waiting" ? atIso : null);
    tracked.set(sessionId, { status: detail.status, since, settleSince: null, seenAt: at });
    return since ? { ...detail, since } : detail;
  };
}

/** One status resolver for every CLI runtime: native state first, the room screen as fallback. */
export function createCliDashboardActivityReader(read: CliDashboardActivityReaders, now: () => number = Date.now) {
  const track = createActivityTracker(now);
  const resolve = async (session: PaneCliSession): Promise<DashboardActivityDetail> => {
    const screen = async () => screenActivity(dashboardScreenState(await read.screenText(session).catch(() => "")));
    if (session.runtimeId === "cli:codex") {
      const turn = await read.codexTurn(session);
      const at = iso(turn.lastActivityAtMs);
      if (turn.status === "RUNNING") return { status: "working", source: "native" };
      if (turn.status === "COMPLETED") return { status: "done", since: at, source: "native" };
      if (turn.status === "ABORTED") return { status: "waiting", reason: "Interrupted", since: at, source: "native" };
      return screen();
    }
    if (session.runtimeId === "cli:opencode") {
      const server = await read.openCode(session).catch(() => null);
      if (server?.busy) return { status: "working", source: "native" };
      const fromScreen = await screen();
      if (fromScreen.status !== "idle" || !server) return fromScreen;
      return openCodeDashboardActivity(await server.messages().catch(() => [])) ?? { status: "idle", source: "native" };
    }
    if (session.runtimeId === "cli:gemini") {
      const latest = (await read.geminiTurns(session).catch(() => null))?.at(-1);
      if (latest?.status === "RUNNING") return { status: "working", since: iso(latest.timing.startedAt), source: "native" };
      if (latest && (latest.status === "INTERRUPTED" || latest.aborted)) {
        return { status: "waiting", reason: "Interrupted", since: iso(latest.timing.completedAt), source: "native" };
      }
      const fromScreen = await screen();
      if (latest?.status === "COMPLETED" && fromScreen.status === "idle") {
        return { status: "done", since: iso(latest.timing.completedAt), source: "native" };
      }
      return fromScreen;
    }
    if (session.runtimeId === "cli:claude") {
      const native = await read.claude(session).catch(() => null);
      if (native) return claudeDashboardActivity(native);
    }
    return screen();
  };
  return async (session: PaneCliSession): Promise<DashboardActivityDetail> => track(session.sessionId, await resolve(session));
}
