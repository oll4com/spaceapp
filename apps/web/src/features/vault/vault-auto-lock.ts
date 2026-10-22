import { useEffect, useRef, useState } from "react";

// Vault auto-lock (plan clipboard:vEYtT6-bEN0J step 5), when the operator turns it on: after a quiet period, when the tab
// is hidden, or after the computer slept (timers stop, so a long gap between ticks means sleep), the Vault locks like Lock.

export interface VaultAutoLockSettings {
  /** Minutes without activity before the Vault locks; 0 never locks on inactivity. */
  idleMinutes: number;
  /** Lock as soon as the tab is hidden, the window is minimized or the computer sleeps. */
  lockOnHide: boolean;
}
export type VaultAutoLockReason = "IDLE" | "HIDDEN" | "SLEEP";

export const VAULT_AUTO_LOCK_KEY = "space:vault-auto-lock:v1";
export const VAULT_IDLE_CHOICES = [1, 5, 15, 30, 60, 0] as const;
// The Vault stays unlocked while SpaceApp is open (operator decision 2026-10-19): no idle lock and no lock on a hidden tab
// unless the operator chose them in Vault Settings (a stored choice always wins).
export const VAULT_AUTO_LOCK_DEFAULTS: VaultAutoLockSettings = { idleMinutes: 0, lockOnHide: false };
const TICK_MS = 5_000;
// A tick that arrives this late means the machine slept (or the tab was frozen) in between.
const SLEEP_GAP_MS = 60_000;

export function readVaultAutoLock(): VaultAutoLockSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(VAULT_AUTO_LOCK_KEY) ?? "null") as Partial<VaultAutoLockSettings> | null;
    const idleMinutes = (VAULT_IDLE_CHOICES as readonly number[]).includes(stored?.idleMinutes ?? -1) ? stored!.idleMinutes! : VAULT_AUTO_LOCK_DEFAULTS.idleMinutes;
    return { idleMinutes, lockOnHide: typeof stored?.lockOnHide === "boolean" ? stored.lockOnHide : VAULT_AUTO_LOCK_DEFAULTS.lockOnHide };
  } catch {
    return VAULT_AUTO_LOCK_DEFAULTS;
  }
}

export function useVaultAutoLockSettings(): [VaultAutoLockSettings, (next: VaultAutoLockSettings) => void] {
  const [settings, setSettings] = useState(readVaultAutoLock);
  return [settings, (next) => { setSettings(next); try { localStorage.setItem(VAULT_AUTO_LOCK_KEY, JSON.stringify(next)); } catch { /* private mode: this tab only */ } }];
}

/**
 * Watches activity, visibility and sleep and calls `lock(reason)` once when a rule fires; returns the stop function. The
 * settings are read on every check, so a change in Vault Settings applies at once (also while the dock is closed).
 */
export function startVaultAutoLock(settings: () => VaultAutoLockSettings, lock: (reason: VaultAutoLockReason) => void): () => void {
  let lastActivity = Date.now();
  let lastTick = Date.now();
  let fired = false;
  const fire = (reason: VaultAutoLockReason) => { if (!fired) { fired = true; lock(reason); } };
  const touch = () => { lastActivity = Date.now(); };
  const tick = () => {
    const now = Date.now();
    const current = settings();
    if (current.lockOnHide && now - lastTick > SLEEP_GAP_MS) fire("SLEEP");
    else if (current.idleMinutes > 0 && now - lastActivity >= current.idleMinutes * 60_000) fire("IDLE");
    lastTick = now;
  };
  const visibility = () => { if (settings().lockOnHide && document.visibilityState === "hidden") fire("HIDDEN"); };
  // The back/forward cache keeps a left page alive with its memory, so leaving locks too.
  const leave = () => { if (settings().lockOnHide) fire("HIDDEN"); };
  const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
  for (const name of events) document.addEventListener(name, touch, { passive: true, capture: true });
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", leave);
  const timer = window.setInterval(tick, TICK_MS);
  return () => {
    for (const name of events) document.removeEventListener(name, touch, { capture: true });
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", leave);
    window.clearInterval(timer);
  };
}

/** While `active`, calls `lock(reason)` once when a rule fires. */
export function useVaultAutoLock(active: boolean, settings: VaultAutoLockSettings, lock: (reason: VaultAutoLockReason) => void): void {
  const lockRef = useRef(lock);
  lockRef.current = lock;
  useEffect(() => active ? startVaultAutoLock(() => settings, (reason) => lockRef.current(reason)) : undefined,
    [active, settings.idleMinutes, settings.lockOnHide]); // eslint-disable-line react-hooks/exhaustive-deps
}
