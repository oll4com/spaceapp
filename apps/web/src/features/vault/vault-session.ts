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

/** Adds the logins agents saved or the Vault generated; hands them over when there were any. An unusable inbox is reported, not swallowed. */
export async function importVaultInbox(current: UnlockedVault | null = keys): Promise<number> {
  if (!current) return 0;
  let result;
  try { result = await importVaultPending(api, current, await vaultInboxKey(api, current)); }
  catch (error) { if (error instanceof VaultInboxError) emit({ kind: "inbox-error", message: error.message }); throw error; }
  const { imported: count, unreadable } = result;
  if (unreadable.length) {
    const names = unreadable.slice(0, 3).map((entry) => entry.label).join(", ");
    emit({ kind: "inbox-error", message: `${unreadable.length} waiting login${unreadable.length === 1 ? "" : "s"} (${names}) cannot be opened with your inbox key and stay waiting. Check Activity for an INBOX_SET entry you did not make.` });
  }
  if (count) { emit({ kind: "imported", count }); await handOverToAgents(current); }
  return count;
}

/** After an unlock: the inbox key exists, saved logins are added, and agents get the current items. */
export async function openVaultInbox(current: UnlockedVault): Promise<void> {
  if ((await importVaultInbox(current)) === 0) await handOverToAgents(current);
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
  if (!keys) return;
  lockVaultKeys(keys);
  keys = null;
  emit({ kind: "locked", reason });
}
