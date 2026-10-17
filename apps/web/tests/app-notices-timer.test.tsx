import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppNotices } from "../src/features/app-notices/useAppNotices.js";

function StrictWrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

describe("owned live-debug notice timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Unmount our hooks while their fake timer owners still exist. No blanket
    // clearAllTimers: every test must prove its own resource was cancelled.
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps info and success console-only without replacing a pending error", () => {
    const schedule = vi.spyOn(window, "setTimeout");
    const cancel = vi.spyOn(window, "clearTimeout");
    const { result } = renderHook(() => useAppNotices());
    const baseline = vi.getTimerCount();
    const callsBefore = schedule.mock.calls.length;
    act(() => {
      result.current.showLiveDebug("default info");
      result.current.showLiveDebug("explicit info", "info");
      result.current.showLiveDebug("success", "success");
    });
    expect(result.current.liveDebugToast).toBeNull();
    expect(schedule.mock.calls).toHaveLength(callsBefore);
    expect(vi.getTimerCount()).toBe(baseline);

    act(() => result.current.showLiveDebug("visible error", "error"));
    const cancelCallsBefore = cancel.mock.calls.length;
    act(() => {
      result.current.showLiveDebug("progress while error visible");
      result.current.showLiveDebug("success while error visible", "success");
    });
    expect(result.current.liveDebugToast?.message).toBe("visible error");
    expect(schedule.mock.calls).toHaveLength(callsBefore + 1);
    expect(cancel.mock.calls).toHaveLength(cancelCallsBefore);
    expect(vi.getTimerCount()).toBe(baseline + 1);
    act(() => vi.advanceTimersByTime(4500));
    expect(result.current.liveDebugToast).toBeNull();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("keeps the mounted notice until the original 4500ms deadline", () => {
    const { result } = renderHook(() => useAppNotices());
    act(() => result.current.showLiveDebug("mounted", "error"));
    act(() => vi.advanceTimersByTime(4499));
    expect(result.current.liveDebugToast?.message).toBe("mounted");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.liveDebugToast).toBeNull();
  });

  it("replaces only the prior notice timer and uses the new full deadline", () => {
    const schedule = vi.spyOn(window, "setTimeout");
    const cancel = vi.spyOn(window, "clearTimeout");
    const { result } = renderHook(() => useAppNotices());
    act(() => result.current.showLiveDebug("first", "error"));
    const firstTimer = schedule.mock.results.at(-1)!.value;
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.showLiveDebug("replacement", "error"));
    expect(cancel).toHaveBeenCalledWith(firstTimer);
    act(() => vi.advanceTimersByTime(3500));
    expect(result.current.liveDebugToast?.message).toBe("replacement");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.liveDebugToast).toBeNull();
  });

  it("cancels the exact current timer when unmounted before expiry", () => {
    const schedule = vi.spyOn(window, "setTimeout");
    const cancel = vi.spyOn(window, "clearTimeout");
    const { result, unmount } = renderHook(() => useAppNotices());
    const baseline = vi.getTimerCount();
    act(() => result.current.showLiveDebug("pending", "error"));
    const ownedTimer = schedule.mock.results.at(-1)!.value;
    expect(vi.getTimerCount()).toBe(baseline + 1);
    unmount();
    expect(cancel).toHaveBeenCalledWith(ownedTimer);
    expect(vi.getTimerCount()).toBe(baseline);
    act(() => vi.advanceTimersByTime(4500));
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("removes its event listener so a post-unmount event schedules nothing", () => {
    const schedule = vi.spyOn(window, "setTimeout");
    const { unmount } = renderHook(() => useAppNotices());
    unmount();
    const callsBefore = schedule.mock.calls.length;
    act(() => window.dispatchEvent(new CustomEvent("space-live-debug", {
      detail: { message: "after-unmount", type: "error" }
    })));
    expect(schedule.mock.calls).toHaveLength(callsBefore);
  });

  it("leaves another mounted instance's timer alive", () => {
    const schedule = vi.spyOn(window, "setTimeout");
    const cancel = vi.spyOn(window, "clearTimeout");
    const first = renderHook(() => useAppNotices());
    const second = renderHook(() => useAppNotices());
    const baseline = vi.getTimerCount();
    act(() => first.result.current.showLiveDebug("first instance", "error"));
    const firstTimer = schedule.mock.results.at(-1)!.value;
    act(() => second.result.current.showLiveDebug("second instance", "error"));
    const secondTimer = schedule.mock.results.at(-1)!.value;
    expect(firstTimer).not.toBe(secondTimer);
    expect(vi.getTimerCount()).toBe(baseline + 2);
    first.unmount();
    expect(cancel).toHaveBeenCalledWith(firstTimer);
    expect(cancel).not.toHaveBeenCalledWith(secondTimer);
    expect(vi.getTimerCount()).toBe(baseline + 1);
    expect(second.result.current.liveDebugToast?.message).toBe("second instance");
    act(() => vi.advanceTimersByTime(4500));
    expect(second.result.current.liveDebugToast).toBeNull();
  });

  it("cleans up its pending timer after StrictMode effect remount", () => {
    const schedule = vi.spyOn(window, "setTimeout");
    const cancel = vi.spyOn(window, "clearTimeout");
    const { result, unmount } = renderHook(() => useAppNotices(), { wrapper: StrictWrapper });
    const baseline = vi.getTimerCount();
    act(() => result.current.showLiveDebug("strict instance", "error"));
    const ownedTimer = schedule.mock.results.at(-1)!.value;
    expect(vi.getTimerCount()).toBe(baseline + 1);
    unmount();
    expect(cancel).toHaveBeenCalledWith(ownedTimer);
    expect(vi.getTimerCount()).toBe(baseline);
  });
});
