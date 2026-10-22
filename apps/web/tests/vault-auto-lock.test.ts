import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VAULT_AUTO_LOCK_DEFAULTS, VAULT_AUTO_LOCK_KEY, readVaultAutoLock, useVaultAutoLock } from "../src/features/vault/vault-auto-lock.js";

const setHidden = (hidden: boolean) => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });

describe("Vault auto-lock", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-17T12:00:00Z")); setHidden(false); localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); setHidden(false); });

  it("locks once after the idle time, and activity starts the wait again", () => {
    const lock = vi.fn();
    renderHook(() => useVaultAutoLock(true, { idleMinutes: 1, lockOnHide: false }, lock));
    act(() => { vi.advanceTimersByTime(50_000); });
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown")); });
    act(() => { vi.advanceTimersByTime(50_000); });
    expect(lock).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(lock).toHaveBeenCalledWith("IDLE");
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it("locks when the tab is hidden, the page is left, or the computer slept", () => {
    const hidden = vi.fn();
    renderHook(() => useVaultAutoLock(true, { idleMinutes: 0, lockOnHide: true }, hidden));
    setHidden(true);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(hidden).toHaveBeenCalledWith("HIDDEN");

    const left = vi.fn();
    renderHook(() => useVaultAutoLock(true, { idleMinutes: 0, lockOnHide: true }, left));
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(left).toHaveBeenCalledWith("HIDDEN");

    // Sleep: timers stop, so the next tick comes long after the last one.
    const slept = vi.fn();
    renderHook(() => useVaultAutoLock(true, { idleMinutes: 0, lockOnHide: true }, slept));
    act(() => { vi.advanceTimersByTime(5_000); });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(slept).toHaveBeenCalledWith("SLEEP");
  });

  it("does nothing while locked or when the operator turned the rules off", () => {
    const lock = vi.fn();
    renderHook(() => useVaultAutoLock(false, { idleMinutes: 1, lockOnHide: true }, lock));
    const off = vi.fn();
    renderHook(() => useVaultAutoLock(true, { idleMinutes: 0, lockOnHide: false }, off));
    setHidden(true);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); vi.advanceTimersByTime(30 * 60_000); });
    expect(lock).not.toHaveBeenCalled();
    expect(off).not.toHaveBeenCalled();
  });

  it("reads only known settings", () => {
    expect(readVaultAutoLock()).toEqual(VAULT_AUTO_LOCK_DEFAULTS);
    localStorage.setItem(VAULT_AUTO_LOCK_KEY, JSON.stringify({ idleMinutes: 15, lockOnHide: false }));
    expect(readVaultAutoLock()).toEqual({ idleMinutes: 15, lockOnHide: false });
    localStorage.setItem(VAULT_AUTO_LOCK_KEY, JSON.stringify({ idleMinutes: 7, lockOnHide: "yes" }));
    expect(readVaultAutoLock()).toEqual(VAULT_AUTO_LOCK_DEFAULTS);
  });
});
