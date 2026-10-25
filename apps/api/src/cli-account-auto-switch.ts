import type { Pane, PaneCliSession } from "@space/contracts";
import type { CliAccountBalancer } from "./cli-account-balancer.js";
import { screenShowsAccountLimit } from "./agents-dashboard.js";

/**
 * Moves panes on Auto to another account when theirs runs out (session-level balancing). Every tick reads the
 * bounded screen of each Auto pane's running CLI; a usage-limit stop at the composer, seen on two ticks in a row,
 * marks the account exhausted and restarts the pane on the account with the most room. Copilot keeps one session
 * store for all its accounts, so its conversation continues; Cursor keeps none, so it starts fresh.
 */
const SETTLE_MS = 60_000;
const SWITCH_COOLDOWN_MS = 5 * 60_000;
/** CLIs whose native "continue" finds the conversation from another account. */
const RESUMES_ACROSS_ACCOUNTS = new Set(["cli:copilot"]);

export interface CliAccountAutoSwitchOptions {
  balancer: Pick<CliAccountBalancer, "autoPanes" | "setAuto" | "markExhausted" | "pick">;
  getPane(paneId: string): Promise<Pane | null>;
  activeSession(paneId: string): Promise<PaneCliSession | null>;
  screenText(session: PaneCliSession): Promise<string>;
  /** Ends the session (with a note in its transcript) and starts the pane on the account. */
  restart(pane: Pane, session: PaneCliSession, profileId: string, launchMode: "FRESH" | "RESUME", note: string): Promise<void>;
  log?(event: string, detail: Record<string, unknown>): void;
  now?: () => number;
}

export function createCliAccountAutoSwitch(options: CliAccountAutoSwitchOptions) {
  const now = options.now ?? Date.now;
  const seenAt = new Map<string, string>();
  const switchedAt = new Map<string, number>();
  let running = false;

  async function tickPane(paneId: string, runtimeId: string): Promise<void> {
    const pane = await options.getPane(paneId);
    if (!pane || pane.isClosed) {
      await options.balancer.setAuto(paneId, null);
      return;
    }
    const session = await options.activeSession(paneId);
    if (!session || session.runtimeId !== runtimeId || session.purpose !== "NORMAL" || !session.isActive
      || session.status === "EXITED" || session.status === "ERROR") {
      seenAt.delete(paneId);
      return;
    }
    if (now() - Date.parse(session.startedAt) < SETTLE_MS || now() - (switchedAt.get(paneId) ?? 0) < SWITCH_COOLDOWN_MS) return;
    if (!screenShowsAccountLimit(await options.screenText(session).catch(() => ""))) {
      seenAt.delete(paneId);
      return;
    }
    // A stop that is still on screen at the next tick is the account's, not text the agent printed in passing.
    if (seenAt.get(paneId) !== session.sessionId) {
      seenAt.set(paneId, session.sessionId);
      return;
    }
    seenAt.delete(paneId);
    const current = session.accountProfileId ?? "main";
    const until = await options.balancer.markExhausted(runtimeId as Parameters<CliAccountBalancer["markExhausted"]>[0], current);
    const next = await options.balancer.pick(runtimeId as Parameters<CliAccountBalancer["pick"]>[0], [current]);
    options.log?.("cli_account.exhausted", { paneId, runtimeId, profileId: current, until: until.toISOString(), next });
    if (!next) return;
    switchedAt.set(paneId, now());
    const launchMode = RESUMES_ACROSS_ACCOUNTS.has(runtimeId) ? "RESUME" : "FRESH";
    await options.restart(pane, session, next, launchMode,
      `Account ${current} ran out of quota; Space moved this pane to account ${next}${launchMode === "RESUME" ? " and continued the conversation" : ""}.`);
    options.log?.("cli_account.switched", { paneId, runtimeId, from: current, to: next, launchMode });
  }

  return {
    async tick(): Promise<void> {
      if (running) return;
      running = true;
      try {
        for (const [paneId, runtimeId] of Object.entries(await options.balancer.autoPanes())) {
          await tickPane(paneId, runtimeId).catch((error: unknown) =>
            options.log?.("cli_account.auto_switch_failed", { paneId, error: error instanceof Error ? error.message : String(error) }));
        }
      } finally {
        running = false;
      }
    }
  };
}
