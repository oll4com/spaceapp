import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePanePolling } from "../src/use-pane-polling.js";
import { singleFlightRequest } from "../src/single-flight-request.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("pane polling on congested links", () => {
  it("keeps one request outstanding across six polling periods and waits after completion", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const poll = vi.fn(() => pending.promise);
    const hook = renderHook(() => usePanePolling(poll, 5000));
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(); });
    await act(() => vi.advanceTimersByTimeAsync(4999));
    expect(poll).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(poll).toHaveBeenCalledTimes(2);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses hidden panes and resumes without duplicating a still pending read", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const poll = vi.fn(() => pending.promise);
    const hook = renderHook(({ visible }) => usePanePolling(poll, 5000, visible), { initialProps: { visible: true } });
    hook.rerender({ visible: false });
    await act(() => vi.advanceTimersByTimeAsync(20000));
    hook.rerender({ visible: true });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(); });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("makes no requests in a background tab and refreshes once on return", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const poll = vi.fn(async () => undefined);
    renderHook(() => usePanePolling(poll, 5000));
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(poll).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("shares global reads between 48 panes but returns a fresh response after completion", async () => {
    const pending = deferred<number>();
    const load = vi.fn(() => pending.promise);
    const calls = Array.from({ length: 48 }, () => singleFlightRequest("48-pane-test", load));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(1);
    expect(await Promise.all(calls)).toEqual(Array(48).fill(1));
    expect(await singleFlightRequest("48-pane-test", async () => 2)).toBe(2);
  });

  it("invalidates delayed results when the polled run changes without overlapping requests", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const applied: string[] = [];
    const poll = vi.fn(async (signal: AbortSignal, run: string) => {
      await pending.promise;
      if (!signal.aborted) applied.push(run);
    });
    const hook = renderHook(({ run }) => usePanePolling((signal) => poll(signal, run), 2000, true, true, run),
      { initialProps: { run: "old-run" } });
    hook.rerender({ run: "new-run" });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(); });
    expect(applied).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(applied).toEqual(["new-run"]);
  });

  it("clears a failed shared request so reconnects can retry", async () => {
    const failure = singleFlightRequest("failure-test", async () => { throw Error("offline"); });
    await expect(failure).rejects.toThrow("offline");
    expect(await singleFlightRequest("failure-test", async () => "online")).toBe("online");
  });
});
