import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { needsYou, type GatewayAccount, type NotificationListQuery, type Pane, type PaneCliSession, type RoomAgentEvent, type SpaceNotification } from "@space/contracts";
import type { ControlRepository, RoomAgentMonitorRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { allNotifications } from "./nous/pane-notices.js";
import { isCliPane } from "./pane-guards.js";
import type { PaneReports } from "./pane-reports.js";
import { atEmptyPrompt } from "./room-agent-autopilot.js";
import type { RoomPaneObservation } from "./room-pane-control.js";

/**
 * Operator order 2026-10-20 (plan clipboard:UxdCDqktJhAN): no Claude pane sits at its account's usage limit while Space Gateway has a
 * ready Claude account. Every tick, each Claude Code pane (terminal, copilot, Design, App Studio) on a direct account that stopped at a
 * usage limit moves to the space-gateway profile on the same conversation (claude-account-switch.ts: an idle prompt only), and once the
 * restarted CLI shows its empty prompt Space types "continue". Every room, with or without auto-answer. A pane whose direct account the
 * operator picked in the pane itself stays, as does every pane while the gateway has no ready Claude account; each such limit is
 * reported once.
 */
export const CLAUDE_GATEWAY_PROFILE = "space-gateway";
/** Four 30-second ticks: a turn that is only finishing never raises it. */
const BUSY_REPORT_TICKS = 4;
export const CLAUDE_LIMIT_CONTINUE = "continue";
/** Ticks (30 s apart) the restarted CLI gets to show an empty prompt before Space reports that it could not type continue. */
const CONTINUE_TICKS = 6;
const MOVED = "hit its Claude usage limit; Space moved it to Space Gateway on the same conversation";

/**
 * Plan clipboard:qH5emwVaV6yO step 8: Claude Code reads its launch env (CLAUDE_CODE_AUTO_COMPACT_WINDOW=160000 in deploy/claude-vscode-parity)
 * only at start, so a CLI started before this ran the 400k window (5 panes, ~600M of 1.40B input on 6/11). Space relaunches such a CLI on the
 * same conversation (native resume) at its next idle empty prompt: no turn, no draft, no pace hold, no open card for the operator on the pane.
 * Bump it with any wrapper env change that running panes must get.
 */
export const CLAUDE_LAUNCH_ENV_SINCE = "2026-11-05T09:58:49Z";

export type ClaudeLimitOutcome = "MOVED" | "STAYS" | "NOT_CONTINUED";

/**
 * A Claude pane on Space Gateway whose turn the pace cap refused (429 PACE_CAP, plan clipboard:DotwYXVD2N3n; operator 6/11: Cleo/Finn's three
 * briefs read COMPLETED although none ran): its conversation still holds the prompt, so Space types continue once, when the account's pace
 * day opens or at once when the pane becomes exempt (an open operator request, Nous's pace cap emergency). One record per held turn
 * (space_control_records pane_state pace-hold:<pane>), claimed by version before typing, so a held prompt is never typed twice.
 */
export interface PaceHoldRecord { heldTaskId: string; sessionId: string; resumesAt: string; status: "WAITING" | "TYPED"; heldAt: string; typedAt: string | null }
export interface PaceHoldDeps {
  /** `heldAt`: an emergency releases only the turns held before it was set (one held under it waits for its resumesAt). */
  exempt(paneId: string, heldAt: string): Promise<boolean>;
  get(pane: Pane): Promise<{ value: PaceHoldRecord; version: number } | null>;
  /** False when another writer changed the record first. */
  write(pane: Pane, value: PaceHoldRecord, expectedVersion: number): Promise<boolean>;
}

export function controlPaceHolds(records: Pick<ControlRepository, "get" | "write">, exempt: PaceHoldDeps["exempt"]): PaceHoldDeps {
  const key = (pane: Pane) => `pace-hold:${pane.id}`;
  return {
    exempt,
    async get(pane) {
      const record = await records.get("pane_state", "space", key(pane));
      return record ? { value: record.value as PaceHoldRecord, version: record.version } : null;
    },
    write: (pane, value, expectedVersion) => records.write({ kind: "pane_state", actorId: "space", key: key(pane), roomId: pane.roomId, version: expectedVersion + 1, value }, expectedVersion)
  };
}

export interface ClaudeLimitMoveDeps {
  /** Open panes of every live room. */
  listPanes(): Promise<Pane[]>;
  activeSession(paneId: string): Promise<PaneCliSession | null>;
  inspect(pane: Pane, fresh: boolean): Promise<RoomPaneObservation>;
  /** Space Gateway runs and has an active Claude subscription account. */
  gatewayReady(): Promise<boolean>;
  /** The operator picked this pane's direct account in the pane itself. */
  pinnedDirect(paneId: string): Promise<boolean>;
  switchToGateway(pane: Pane, session: PaneCliSession): Promise<void>;
  /** The Room Agent's answer path: typed only while the inspected empty prompt is still there. */
  answer(pane: Pane, input: { expectedSessionId: string; answer: string; submit: boolean; expectedPromptFingerprint: string }): Promise<unknown>;
  /** A monitor event and pane report for Nous; STAYS and NOT_CONTINUED need someone. */
  record(pane: Pane, outcome: ClaudeLimitOutcome, text: string): Promise<void>;
  /** R13-13: a Claude session that started on a direct account the operator did not pick (one call per session). */
  directSession?(pane: Pane, session: PaneCliSession): Promise<void>;
  /** Step 8: restart the CLI on the same profile and conversation; false when it has no native conversation to resume. */
  relaunch?(pane: Pane, session: PaneCliSession): Promise<boolean>;
  /** An open question, review or handoff card for the operator on this pane. */
  waitsOnOperator?(pane: Pane): Promise<boolean>;
  /** Turns Space Gateway's pace cap refused, typed again once (PaceHoldDeps). */
  paceHolds?: PaceHoldDeps;
  now?(): number;
  log?(event: string, detail: Record<string, unknown>): void;
}

export function createClaudeLimitMove(deps: ClaudeLimitMoveDeps) {
  const now = deps.now ?? Date.now;
  /** Panes moved to the gateway, waiting for their restarted CLI's empty prompt. */
  const continuing = new Map<string, { sessionId: string; ticks: number }>();
  /** The limited session each staying pane was reported for. */
  const reported = new Map<string, string>();
  /** Ticks a limited pane's turn has stayed busy (Claude keeps it running while background agents or shells run). */
  const busyTicks = new Map<string, { sessionId: string; ticks: number }>();
  /** R13-13: the direct sessions Nous was told about. */
  const toldDirect = new Set<string>();
  let running = false;

  async function continueMoved(pane: Pane, session: PaneCliSession, moved: { sessionId: string; ticks: number }) {
    if (++moved.ticks > CONTINUE_TICKS) {
      continuing.delete(pane.id);
      return deps.record(pane, "NOT_CONTINUED", `${MOVED}, but found no empty prompt to type continue into`);
    }
    const observed = await deps.inspect(pane, true);
    if (observed.state === "RUNNING") {
      continuing.delete(pane.id);
      return deps.record(pane, "MOVED", `${MOVED}; it is working again`);
    }
    if (session.sessionId !== moved.sessionId || observed.sessionId !== session.sessionId || !atEmptyPrompt(observed)) return;
    await deps.answer(pane, { expectedSessionId: observed.sessionId, answer: CLAUDE_LIMIT_CONTINUE, submit: true, expectedPromptFingerprint: observed.promptFingerprint });
    continuing.delete(pane.id);
    return deps.record(pane, "MOVED", `${MOVED} and typed continue`);
  }

  async function resumePaceHold(pane: Pane, session: PaneCliSession, holds: PaceHoldDeps) {
    const observed = await deps.inspect(pane, false);
    const hold = observed.paceHold;
    if (!hold || observed.sessionId !== session.sessionId) return;
    let stored = await holds.get(pane);
    if (!stored || stored.value.heldTaskId !== hold.taskId || stored.value.sessionId !== session.sessionId) {
      const value: PaceHoldRecord = { heldTaskId: hold.taskId, sessionId: session.sessionId, resumesAt: hold.resumesAt, status: "WAITING", heldAt: hold.at ?? new Date(now()).toISOString(), typedAt: null };
      const version = stored?.version ?? 0;
      if (!await holds.write(pane, value, version)) return;
      stored = { value, version: version + 1 };
      deps.log?.("pace_hold.held", { paneId: pane.id, taskId: hold.taskId, resumesAt: hold.resumesAt });
    }
    if (stored.value.status === "TYPED") return;
    if (Date.parse(hold.resumesAt) > now() && !await holds.exempt(pane.id, stored.value.heldAt)) return;
    // Typed only at an empty prompt of the same held turn; the limit flag is the hold itself, which is what ends now.
    const fresh = await deps.inspect(pane, true);
    if (fresh.sessionId !== session.sessionId || fresh.paceHold?.taskId !== hold.taskId || !atEmptyPrompt({ ...fresh, usageLimited: false })) return;
    const typed: PaceHoldRecord = { ...stored.value, status: "TYPED", typedAt: new Date(now()).toISOString() };
    if (!await holds.write(pane, typed, stored.version)) return;
    try {
      await deps.answer(pane, { expectedSessionId: fresh.sessionId!, answer: CLAUDE_LIMIT_CONTINUE, submit: true, expectedPromptFingerprint: fresh.promptFingerprint! });
    } catch (error) {
      // Not typed: the next tick tries again.
      await holds.write(pane, stored.value, stored.version + 1).catch(() => false);
      throw error;
    }
    deps.log?.("pace_hold.continued", { paneId: pane.id, taskId: hold.taskId });
  }

  async function relaunchStale(pane: Pane, session: PaneCliSession): Promise<boolean> {
    if (!(Date.parse(session.startedAt) < Date.parse(CLAUDE_LAUNCH_ENV_SINCE))) return false;
    const idle = (observed: RoomPaneObservation) => observed.sessionId === session.sessionId && atEmptyPrompt(observed) && !observed.paceHold;
    if (!idle(await deps.inspect(pane, false)) || await deps.waitsOnOperator!(pane) || !idle(await deps.inspect(pane, true))) return false;
    if (!await deps.relaunch!(pane, session)) return false;
    deps.log?.("claude_launch_env.relaunched", { paneId: pane.id, from: session.sessionId, startedAt: session.startedAt });
    return true;
  }

  async function tickPane(pane: Pane) {
    const session = await deps.activeSession(pane.id);
    if (!session || session.runtimeId !== "cli:claude" || session.purpose !== "NORMAL" || !session.isActive
      || session.status === "EXITED" || session.status === "ERROR") return;
    const moved = continuing.get(pane.id);
    if (moved) return continueMoved(pane, session, moved);
    if (deps.relaunch && deps.waitsOnOperator && await relaunchStale(pane, session)) return;
    if (session.accountProfileId === CLAUDE_GATEWAY_PROFILE) return deps.paceHolds ? resumePaceHold(pane, session, deps.paceHolds) : undefined;
    // R13-13 (operator 29/10 13:23 BKK: 9 Claude panes ran on the direct account after a reopen, restart or start): Nous hears once per session.
    // Only where Space Gateway can take it (1.2.0 lab 2/11: a self-hosted install has no space-gateway profile, so every move failed).
    if (deps.directSession && !toldDirect.has(session.sessionId) && !await deps.pinnedDirect(pane.id) && await deps.gatewayReady()) {
      if (toldDirect.size > 1_000) toldDirect.clear();
      toldDirect.add(session.sessionId);
      await deps.directSession(pane, session).catch(() => undefined);
    }
    const observed = await deps.inspect(pane, false);
    if (!observed.usageLimited || observed.sessionId !== session.sessionId) {
      reported.delete(pane.id);
      busyTicks.delete(pane.id);
      return;
    }
    const stays = await deps.pinnedDirect(pane.id) ? "you picked its direct account in the pane"
      : !await deps.gatewayReady() ? "Space Gateway has no ready Claude account" : null;
    if (stays) {
      if (reported.get(pane.id) === session.sessionId) return;
      reported.set(pane.id, session.sessionId);
      return deps.record(pane, "STAYS", `hit its Claude usage limit and stays there: ${stays}`);
    }
    // The switch restarts the CLI, so a limit menu or a turn still on screen waits for the next tick.
    if (observed.state !== "IDLE") {
      // A turn Claude keeps busy at the limit (background agents or shells, Cleo/Dana 2026-10-21) waited unseen: say so once after 2 minutes.
      const busy = busyTicks.get(pane.id);
      const ticks = observed.state === "RUNNING" && busy?.sessionId === session.sessionId ? busy.ticks + 1 : 1;
      busyTicks.set(pane.id, { sessionId: session.sessionId, ticks });
      if (observed.state !== "RUNNING" || ticks < BUSY_REPORT_TICKS || reported.get(pane.id) === session.sessionId) return;
      reported.set(pane.id, session.sessionId);
      return deps.record(pane, "STAYS", "hit its Claude usage limit while its turn still runs (background agents or shells): "
        + "it moves to Space Gateway once that turn ends, or continues by itself after the limit resets");
    }
    busyTicks.delete(pane.id);
    await deps.switchToGateway(pane, session);
    reported.delete(pane.id);
    continuing.set(pane.id, { sessionId: (await deps.activeSession(pane.id))?.sessionId ?? "", ticks: 0 });
    deps.log?.("claude_limit.moved", { paneId: pane.id, from: session.sessionId });
  }

  return {
    async tick(): Promise<void> {
      if (running) return;
      running = true;
      try {
        // API audit 5/11: `void tick()` on a timer; a failed pane read (database in recovery) is logged, never an unhandled rejection.
        const panes = await deps.listPanes().catch((error: unknown) => {
          deps.log?.("claude_limit.failed", { error: error instanceof Error ? error.message : String(error) });
          return [];
        });
        for (const pane of panes) {
          if (pane.isClosed || !isCliPane(pane) || pane.terminalRuntimeId !== "cli:claude") continue;
          await tickPane(pane).catch((error: unknown) =>
            deps.log?.("claude_limit.failed", { paneId: pane.id, error: error instanceof Error ? error.message : String(error) }));
        }
      } finally {
        running = false;
      }
    },
    /** The same "ready Claude subscription account" rule for Nous's helpers, which fall back to the gateway at a quota limit. */
    gatewayReady: () => deps.gatewayReady()
  };
}

/**
 * Claude panes whose direct account the operator picked in the pane (its account picker, a copilot's Setup): Space never moves them
 * at a limit. Kept in a small state file so the choice survives API restarts; null keeps it in memory (tests).
 */
export function createClaudeDirectPins(path: string | null) {
  let pins: Record<string, string> | null = null;
  const load = async (): Promise<Record<string, string>> => pins ??= path
    ? await readFile(path, "utf8").then((text) => JSON.parse(text) as Record<string, string>).catch(() => ({}))
    : {};
  return {
    has: async (paneId: string) => Boolean((await load())[paneId]),
    async set(paneId: string, pinned: boolean) {
      const current = await load();
      if (pinned) current[paneId] = new Date().toISOString();
      else delete current[paneId];
      if (!path) return;
      await mkdir(dirname(path), { recursive: true, mode: 0o750 });
      await writeFile(`${path}.${process.pid}.tmp`, `${JSON.stringify(current)}\n`, { mode: 0o640 });
      await rename(`${path}.${process.pid}.tmp`, path);
    }
  };
}

/** The app's side of the mover, kept out of the composition root: which panes, when the gateway is ready, and how a move is recorded. */
export function claudeLimitMoveDeps(app: Pick<ClaudeLimitMoveDeps, "inspect" | "pinnedDirect" | "answer" | "log" | "paceHolds"> & {
  /** switchClaudePaneAccount on this pane; true when the CLI was restarted. */
  switchAccount(pane: Pane, session: PaneCliSession, profile: string | null, options?: { relaunch?: boolean }): Promise<boolean>;
  /** The room owner's cards; with relaunch, a pane with an open card for the operator is never relaunched. */
  notifications?: { list(owner: string, query: NotificationListQuery): Promise<SpaceNotification[]> };
  /** R13-13: one line in the room owner's Nous inbox. */
  notice?(owner: string, key: string, line: string): Promise<void>;
  store: Pick<SpaceStore, "listRooms" | "listPanes" | "getActivePaneCliSession" | "getRoom">;
  gatewayProfileReady(): Promise<boolean>;
  gatewayAccounts(): Promise<{ data: GatewayAccount[] }>;
  monitor: Pick<RoomAgentMonitorRepository, "addEvent" | "updateEvent" | "listEvents">;
  /** The monitor's event path (stream, Nous, notifications) and, for what needs someone, the Room Agent's handling. */
  onEvent(event: RoomAgentEvent): Promise<void>;
  onAttention(event: RoomAgentEvent): void;
  paneReports(): PaneReports | null | undefined;
}): ClaudeLimitMoveDeps {
  const { store, monitor } = app;
  return {
    ...app,
    listPanes: async () => (await Promise.all((await store.listRooms()).filter((room) => !room.archivedAt).map((room) => store.listPanes(room.id)))).flat(),
    activeSession: async (paneId) => (await store.getActivePaneCliSession(paneId)) ?? null,
    switchToGateway: async (pane, session) => { await app.switchAccount(pane, session, CLAUDE_GATEWAY_PROFILE); },
    relaunch: (pane, session) => app.switchAccount(pane, session, session.accountProfileId ?? null, { relaunch: true }),
    ...(app.notifications ? { async waitsOnOperator(pane: Pane) {
      const owner = (await store.getRoom(pane.roomId)).ownerUserId;
      return Boolean(owner) && (await allNotifications(app.notifications!.list, owner!, { status: "WAITING", paneId: pane.id })).some(needsYou);
    } } : {}),
    ...(app.notice ? { async directSession(pane: Pane, session: PaneCliSession) {
      const owner = (await store.getRoom(pane.roomId)).ownerUserId;
      if (!owner) return;
      await app.notice!(owner, `claude-direct-account:${session.sessionId}`, `${pane.paneName ?? pane.title} (${pane.id}) started a Claude session on the direct account `
        + `"${session.accountProfileId ?? "main"}", not Space Gateway, and the operator did not pick it in the pane. Move it at its idle prompt: space_execute `
        + `{room: "${pane.roomId}", actions: [{kind: "configure", target: {paneIds: ["${pane.id}"]}, accountProfileId: "${CLAUDE_GATEWAY_PROFILE}", when: "AFTER_TURN"}]}.`);
    } } : {}),
    // The Claude API-key account bills per token and serves Claude Code only as the operator's fallback, so it does not count as ready.
    gatewayReady: async () => await app.gatewayProfileReady()
      && (await app.gatewayAccounts()).data.some((account) => account.provider === "CLAUDE" && account.status === "ACTIVE" && account.planType !== "api"),
    async record(pane, outcome, text) {
      const line = `${pane.paneName ?? pane.title} ${text}`;
      const moved = outcome === "MOVED";
      const added = await monitor.addEvent({ roomId: pane.roomId, paneId: pane.id, paneName: pane.paneName ?? null, kind: "USAGE_LIMIT",
        severity: moved ? "INFO" : "ATTENTION", title: line.slice(0, 200), detail: null });
      const event = moved ? await monitor.updateEvent(added.eventId, { status: "HANDLED", decision: "Moved to Space Gateway." }, ["OPEN"]) ?? added : added;
      // A limit reported earlier (no ready gateway account then) is settled by the move.
      for (const open of moved ? await monitor.listEvents(pane.roomId, { paneId: pane.id, statuses: ["OPEN", "ESCALATED"], limit: 10 }) : []) {
        const resolved = open.kind === "USAGE_LIMIT" ? await monitor.updateEvent(open.eventId, { status: "RESOLVED", decision: "Moved to Space Gateway." }, ["OPEN", "ESCALATED"]) : null;
        if (resolved) await app.onEvent(resolved);
      }
      await app.onEvent(event);
      if (!moved) app.onAttention(event);
      await app.paneReports()?.note(await store.getRoom(pane.roomId), pane, moved ? "PROGRESS" : "BLOCKED", line);
    }
  };
}
