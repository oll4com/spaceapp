import { api } from "../../api.js";
import { VAULT_OLD_BROKER_DELEGATION_MAX, VaultInboxError, delegateVaultItems, importVaultPending, lockVaultKeys, vaultInboxKey, type UnlockedVault } from "./vault-client.js";
import { readVaultAutoLock, startVaultAutoLock, type VaultAutoLockReason } from "./vault-auto-lock.js";

/**
 * The tab's unlocked Vault (operator DIRECTION decision 2026-10-19: the Vault stays unlocked while SpaceApp is open). The
 * keys live in this module's memory for the life of the tab, not in the dock: closing the dock no longer locks. They go on
 * Lock, Revoke, sign-out, the operator's own auto-lock settings and a reload, and never reach localStorage, sessionStorage
 * or IndexedDB. While unlocked, the inbox import (every 30 s) and the hand-over to agents run here, dock open or not.
 */
export type VaultLockReason = VaultAutoLockReason | "LOCK" | "REVOKE" | "SIGN_OUT";
export type VaultSessionEvent = { kind: "unlocked" } | { kind: "locked"; reason: VaultLockReason } | { kind: "imported"; count: number }
  /** The inbox cannot be used (its key does not open, or waiting logins were sealed to another key): shown, never swallowed. */
  | { kind: "inbox-error"; message: string };

const IMPORT_EVERY_MS = 30_000;
let keys: UnlockedVault | null = null;
let stopTimers: (() => void) | null = null;
let importing = false;
const listeners = new Set<(event: VaultSessionEvent) => void>();
const emit = (event: VaultSessionEvent) => { for (const listener of [...listeners]) listener(event); };

export const vaultSessionKeys = (): UnlockedVault | null => keys;
export function subscribeVaultSession(listener: (event: VaultSessionEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * While agent access is on, hands every login not hidden from agents to the broker again (a new delegation replaces the
 * last), so items added or changed here become fillable; the inbox key goes along, so logins agents save later are fillable
 * at once while the Vault is locked. Nothing to hand over leaves the last delegation.
 */
export async function handOverToAgents(current: UnlockedVault | null = keys): Promise<void> {
  if (!current) return;
  const state = await api.vaultState();
  if (!state.agentAccess) return;
  const { items, stats } = await api.vaultItems();
  // The order an older broker's 200 are taken in: logins agents already used (latest use first), then logins made here or by
  // agents, then imported ones (newest first). A large Chrome import never pushes out the logins agents work with.
  const rank = (item: (typeof items)[number]) => stats?.[item.id]?.lastUsedAt ? 0 : item.googleAccountId ? 2 : 1;
  const latest = (item: (typeof items)[number]) => stats?.[item.id]?.lastUsedAt ?? stats?.[item.id]?.changedAt ?? "";
  const ordered = items.filter((item) => item.policy.agentUse && item.status === "ACTIVE")
    .sort((a, b) => rank(a) - rank(b) || latest(b).localeCompare(latest(a)));
  // One request for every item's envelopes, not one per item.
  const byId = new Map((await api.vaultItemRecords()).items.map((record) => [record.metadata.id, record]));
  const records = ordered.map((item) => byId.get(item.id)).filter((record) => record !== undefined);
  const inbox = await vaultInboxKey(api, current);
  const delegate = (list: typeof records) => delegateVaultItems(api, current, { records: list, delegationGeneration: state.vault?.delegationGeneration ?? 0, epoch: state.vault?.epoch, inbox });
  // Every login is offered (no count limit, operator rule 2026-10-20); a broker or API from before that refuses more than 200
  // as a whole, so the 200 most recent go instead of none, and the dock shows how many wait.
  await delegate(records).catch((error) => records.length > VAULT_OLD_BROKER_DELEGATION_MAX ? delegate(records.slice(0, VAULT_OLD_BROKER_DELEGATION_MAX)) : Promise.reject(error));
}

/** The last inbox problem, kept so a dock opened after the 30 s import failed still shows it; a clean import clears it. */
let inboxProblem: string | null = null;
export const vaultInboxProblem = (): string | null => inboxProblem;
/** Why a waiting login is still waiting after the last import, by its row id: the dock shows it on that row. */
let rowProblems = new Map<string, string>();
export const vaultInboxRowProblem = (id: string): string | null => rowProblems.get(id) ?? null;
const reportInbox = (message: string) => { inboxProblem = message; emit({ kind: "inbox-error", message }); };
const names = (entries: Array<{ label: string }>) => entries.slice(0, 3).map((entry) => entry.label).join(", ");
const logins = (count: number) => `${count} waiting login${count === 1 ? "" : "s"}`;

/** Adds the logins agents saved or the Vault generated; hands them over when there were any. Every failure is reported, never swallowed. */
export async function importVaultInbox(current: UnlockedVault | null = keys): Promise<number> {
  if (!current) return 0;
  let result;
  try { result = await importVaultPending(api, current, await vaultInboxKey(api, current)); }
  catch (error) {
    reportInbox(error instanceof VaultInboxError ? error.message
      : `Adding the logins agents saved failed (${error instanceof Error ? error.message : String(error)}). They stay waiting; the Vault tries again every 30 seconds.`);
    throw error;
  }
  const { imported: count, unreadable, failed } = result;
  rowProblems = new Map([...unreadable.map((entry) => [entry.id, "Sealed to another inbox key; it stays waiting."] as const),
    ...failed.map((entry) => [entry.id, `Could not be added (${entry.reason}); the Vault tries again every 30 seconds.`] as const)]);
  const problems = [
    ...(unreadable.length ? [`${logins(unreadable.length)} (${names(unreadable)}) cannot be opened with your inbox key and stay waiting. Check Activity for an INBOX_SET entry you did not make.`] : []),
    ...(failed.length ? [`${logins(failed.length)} (${names(failed)}) could not be added (${failed[0]!.reason}) and stay waiting; the Vault tries again every 30 seconds.`] : [])
  ];
  if (problems.length) reportInbox(problems.join(" "));
  else inboxProblem = null;
  if (count) { emit({ kind: "imported", count }); await handOverToAgents(current); }
  return count;
}

/** After an unlock: the inbox key exists, saved logins are added, and agents get the current items, also when the import failed. */
export async function openVaultInbox(current: UnlockedVault): Promise<void> {
  // The import shows its own failure; the hand-over must not wait on it (30/10 16:46 UTC: a failed import skipped it at the unlock).
  if ((await importVaultInbox(current).catch(() => 0)) === 0) await handOverToAgents(current);
}

/** Keeps the unlocked keys for the tab and starts the background import and the operator's auto-lock rules. */
export function holdVaultKeys(next: UnlockedVault): void {
  // A master password change returns the same key buffers with a new epoch: wipe only buffers that are really replaced.
  if (keys && keys.vrk !== next.vrk) lockVaultKeys(keys);
  keys = next;
  if (!stopTimers) {
    const timer = window.setInterval(() => {
      if (!keys || importing) return;
      importing = true;
      // importVaultInbox reports its own failure to the dock (vaultInboxProblem); the tick only must not end unhandled.
      void importVaultInbox().catch(() => undefined).finally(() => { importing = false; });
    }, IMPORT_EVERY_MS);
    const stopAutoLock = startVaultAutoLock(readVaultAutoLock, (reason) => {
      lockVaultSession(reason);
      // Telling the server (a new epoch) is best effort: the tab may be leaving.
      void api.vaultLock().catch(() => undefined);
    });
    stopTimers = () => { window.clearInterval(timer); stopAutoLock(); };
  }
  emit({ kind: "unlocked" });
}

/** Drops the keys at once (Lock, Revoke, sign-out, auto-lock). The caller tells the server when it should. */
export function lockVaultSession(reason: VaultLockReason): void {
  stopTimers?.();
  stopTimers = null;
  inboxProblem = null;
  rowProblems = new Map();
  if (!keys) return;
  lockVaultKeys(keys);
  keys = null;
  emit({ kind: "locked", reason });
}
