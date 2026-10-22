import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GatewayAccount, Pane, PaneCliSession, RoomAgentEvent } from "@space/contracts";
import type { RoomAgentMonitorRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
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
export const CLAUDE_LIMIT_CONTINUE = "continue";
/** Ticks (30 s apart) the restarted CLI gets to show an empty prompt before Space reports that it could not type continue. */
const CONTINUE_TICKS = 6;
const MOVED = "hit its Claude usage limit; Space moved it to Space Gateway on the same conversation";

export type ClaudeLimitOutcome = "MOVED" | "STAYS" | "NOT_CONTINUED";

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
  log?(event: string, detail: Record<string, unknown>): void;
}

export function createClaudeLimitMove(deps: ClaudeLimitMoveDeps) {
  /** Panes moved to the gateway, waiting for their restarted CLI's empty prompt. */
  const continuing = new Map<string, { sessionId: string; ticks: number }>();
  /** The limited session each staying pane was reported for. */
  const reported = new Map<string, string>();
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

  async function tickPane(pane: Pane) {
    const session = await deps.activeSession(pane.id);
    if (!session || session.runtimeId !== "cli:claude" || session.purpose !== "NORMAL" || !session.isActive
      || session.status === "EXITED" || session.status === "ERROR") return;
    const moved = continuing.get(pane.id);
    if (moved) return continueMoved(pane, session, moved);
    if (session.accountProfileId === CLAUDE_GATEWAY_PROFILE) return;
    const observed = await deps.inspect(pane, false);
    if (!observed.usageLimited || observed.sessionId !== session.sessionId) {
      reported.delete(pane.id);
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
    if (observed.state !== "IDLE") return;
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
        for (const pane of await deps.listPanes()) {
          if (pane.isClosed || !isCliPane(pane) || pane.terminalRuntimeId !== "cli:claude") continue;
          await tickPane(pane).catch((error: unknown) =>
            deps.log?.("claude_limit.failed", { paneId: pane.id, error: error instanceof Error ? error.message : String(error) }));
        }
      } finally {
        running = false;
      }
    }
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
export function claudeLimitMoveDeps(app: Pick<ClaudeLimitMoveDeps, "inspect" | "pinnedDirect" | "switchToGateway" | "answer" | "log"> & {
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
