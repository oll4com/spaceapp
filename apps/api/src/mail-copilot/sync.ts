import { ownerWorkingTimeZone, type Pane, type Room, type UserSettings } from "@space/contracts";
import type { MailCopilotService } from "./service.js";

export interface MailCopilotSyncDeps {
  service: Pick<MailCopilotService, "accounts" | "syncState" | "syncAccount"> & Partial<Pick<MailCopilotService, "pruneActions" | "dailyRun" | "startForNewMail">>;
  store: { listRooms(): Promise<Room[]> | Room[]; listPanes(roomId: string): Promise<Pane[]> | Pane[]; getUserSettings?(owner: string): Promise<UserSettings | null> | UserSettings | null };
  log: { warn(obj: Record<string, unknown>, message: string): void; info?(obj: Record<string, unknown>, message: string): void };
  intervalMs?: number;
  firstDelayMs?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
/** shortcut: after three failures in a row an account is retried every 15 minutes; upgrade to exponential backoff if Gmail quotas bite. */
const FAILURE_HOLD_MS = 15 * 60_000;
/** The action log's year-old rows are dropped at most this often. */
const PRUNE_EVERY_MS = 6 * 3_600_000;

/** Syncs every mail account of one pane (skipping those in `done`, which collects the owner|account keys synced). */
export async function syncPaneAccounts(service: Pick<MailCopilotService, "accounts" | "syncState" | "syncAccount">, owner: string, pane: Pane, log: MailCopilotSyncDeps["log"], done = new Set<string>()): Promise<{ accounts: number; created: number }> {
  let accounts = 0;
  let created = 0;
  const list = await service.accounts(owner, pane).catch((error: unknown) => { log.warn({ err: error, paneId: pane.id }, "Mail Copilot sync could not list accounts"); return []; });
  for (const account of list) {
    const key = `${owner}|${account.email}`;
    if (!account.inPane || account.access === "none" || done.has(key)) continue;
    done.add(key);
    accounts += 1;
    const state = await service.syncState(owner, account.email);
    if (state && state.consecutiveFailures >= 3 && Date.now() - Date.parse(state.updatedAt) < FAILURE_HOLD_MS) continue;
    try {
      created += (await service.syncAccount(owner, pane, account.email)).created;
    } catch (error) {
      log.warn({ err: error, account: account.email, paneId: pane.id }, "Mail Copilot sync failed for an account");
    }
  }
  return { accounts, created };
}

/**
 * Polls Gmail history for every account of every open Mail Copilot pane (one poll per owner and account per tick):
 * new mail becomes MAIL_RECEIVED events, notifications and work items that start the pane's run, and each pane's daily
 * organize run starts when due. Single-flight: a slow tick is never overlapped.
 */
export function createMailCopilotSync(deps: MailCopilotSyncDeps) {
  let timer: NodeJS.Timeout | null = null;
  let first: NodeJS.Timeout | null = null;
  let running = false;
  let prunedAt = 0;
  async function tick(): Promise<{ accounts: number; created: number }> {
    if (running) return { accounts: 0, created: 0 };
    running = true;
    const synced = new Set<string>();
    let created = 0;
    try {
      for (const room of await deps.store.listRooms()) {
        if (!room.ownerUserId) continue;
        for (const pane of (await deps.store.listPanes(room.id)).filter((pane) => pane.mode === "MAIL_COPILOT" && !pane.isClosed)) {
          const fresh = (await syncPaneAccounts(deps.service, room.ownerUserId, pane, deps.log, synced)).created;
          created += fresh;
          if (fresh && deps.service.startForNewMail) await deps.service.startForNewMail(room.ownerUserId, pane).catch((error: unknown) => deps.log.warn({ err: error, paneId: pane.id }, "Mail Copilot could not start a run for new mail"));
          if (deps.service.dailyRun) {
            const zone = ownerWorkingTimeZone(await Promise.resolve(deps.store.getUserSettings?.(room.ownerUserId)).catch(() => null));
            await deps.service.dailyRun(room.ownerUserId, pane, zone).catch((error: unknown) => deps.log.warn({ err: error, paneId: pane.id }, "Mail Copilot daily run could not start"));
          }
        }
      }
      if (deps.service.pruneActions && Date.now() - prunedAt > PRUNE_EVERY_MS) {
        prunedAt = Date.now();
        await deps.service.pruneActions().catch((error: unknown) => deps.log.warn({ err: error }, "Mail Copilot could not prune its action log"));
      }
    } finally {
      running = false;
    }
    return { accounts: synced.size, created };
  }
  return {
    tick,
    start() {
      const interval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
      first = setTimeout(() => void tick().catch((error) => deps.log.warn({ err: error }, "Mail Copilot sync tick failed")), deps.firstDelayMs ?? 30_000);
      first.unref();
      timer = setInterval(() => void tick().catch((error) => deps.log.warn({ err: error }, "Mail Copilot sync tick failed")), interval);
      timer.unref();
    },
    stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = null;
      timer = null;
    }
  };
}
