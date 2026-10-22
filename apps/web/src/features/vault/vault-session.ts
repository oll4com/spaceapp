import { api } from "../../api.js";
import { delegateVaultItems, importVaultPending, lockVaultKeys, vaultInboxKey, type UnlockedVault } from "./vault-client.js";
import { readVaultAutoLock, startVaultAutoLock, type VaultAutoLockReason } from "./vault-auto-lock.js";

/**
 * The tab's unlocked Vault (operator DIRECTION decision 2026-10-19: the Vault stays unlocked while SpaceApp is open). The
 * keys live in this module's memory for the life of the tab, not in the dock: closing the dock no longer locks. They go on
 * Lock, Revoke, sign-out, the operator's own auto-lock settings and a reload, and never reach localStorage, sessionStorage
 * or IndexedDB. While unlocked, the inbox import (every 30 s) and the hand-over to agents run here, dock open or not.
 */
export type VaultLockReason = VaultAutoLockReason | "LOCK" | "REVOKE" | "SIGN_OUT";
export type VaultSessionEvent = { kind: "unlocked" } | { kind: "locked"; reason: VaultLockReason } | { kind: "imported"; count: number };

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
  const records = await Promise.all((await api.vaultItems()).items.map(async (item) => (await api.vaultItem(item.id)).item));
  await delegateVaultItems(api, current, { records, delegationGeneration: state.vault?.delegationGeneration ?? 0, epoch: state.vault?.epoch, inbox: await vaultInboxKey(api, current) });
}

/** Adds the logins agents saved or the Vault generated; hands them over when there were any. */
export async function importVaultInbox(current: UnlockedVault | null = keys): Promise<number> {
  if (!current) return 0;
  const count = await importVaultPending(api, current, await vaultInboxKey(api, current));
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
