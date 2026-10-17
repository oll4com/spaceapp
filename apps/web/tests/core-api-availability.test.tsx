import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GlobalApiErrorAlert,
  reportCoreApiFailure,
  reportCoreApiSuccess,
  resetCoreApiAvailability
} from "../src/core-api-availability.js";

describe("global core API availability alert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    act(() => resetCoreApiAvailability());
  });

  afterEach(() => {
    act(() => resetCoreApiAvailability());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps a short background outage silent", () => {
    render(<GlobalApiErrorAlert actionError={null} />);

    act(() => reportCoreApiFailure());
    act(() => vi.advanceTimersByTime(9_999));

    expect(screen.queryByRole("alert")).toBeNull();
    act(() => reportCoreApiSuccess());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows one global alert after ten seconds of continuous failure", () => {
    render(<GlobalApiErrorAlert actionError={null} />);

    act(() => reportCoreApiFailure());
    act(() => vi.advanceTimersByTime(10_000));

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("UPSTREAM_UNAVAILABLE");
  });

  it("clears a stale outage alert immediately after any core API success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Space API is not reachable from the web server.",
          requestId: "space-web"
        }
      }), { status: 502, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [],
        pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");
    render(<GlobalApiErrorAlert actionError={null} />);

    await expect(api.rooms()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", status: 502 });
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("alert")).toBeTruthy();

    await act(async () => {
      await api.rooms();
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a user-action failure immediately visible across background recovery", () => {
    render(<GlobalApiErrorAlert actionError="Room creation failed: request was rejected." />);

    expect(screen.getByRole("alert").textContent).toContain("Room creation failed");
    act(() => reportCoreApiSuccess());
    expect(screen.getByRole("alert").textContent).toContain("Room creation failed");
  });

  it("hides a transient upstream action error until the outage banner threshold", () => {
    render(<GlobalApiErrorAlert actionError="UPSTREAM_UNAVAILABLE: Space API is not reachable from the web server." />);
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => reportCoreApiFailure());
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("alert").textContent).toContain("more than 10 seconds");
  });

  it("ignores a stale failed response that started before the latest success", () => {
    render(<GlobalApiErrorAlert actionError={null} />);

    act(() => reportCoreApiSuccess());
    act(() => reportCoreApiFailure(Date.now() - 1));
    act(() => vi.advanceTimersByTime(10_000));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dismisses a recovered-room notice without a page reload and clears its source", () => {
    const onDismiss = vi.fn();
    render(<GlobalApiErrorAlert actionError="Room room:stale no longer exists; switched to Room 1."
      onDismissActionError={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(20_000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("expires transient notices after ten seconds without unrelated renders extending them", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<GlobalApiErrorAlert actionError="Room switched." onDismissActionError={onDismiss} />);
    act(() => vi.advanceTimersByTime(9_999));
    rerender(<GlobalApiErrorAlert actionError="Room switched." onDismissActionError={() => onDismiss()} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("gives replacement notices a full lifetime and shows repeated errors after clearing", () => {
    const { rerender } = render(<GlobalApiErrorAlert actionError="First failure" />);
    act(() => vi.advanceTimersByTime(9_000));
    rerender(<GlobalApiErrorAlert actionError="Second failure" />);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("alert").textContent).toContain("Second failure");
    act(() => vi.advanceTimersByTime(9_000));
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<GlobalApiErrorAlert actionError={null} />);
    rerender(<GlobalApiErrorAlert actionError="Second failure" />);
    expect(screen.getByRole("alert").textContent).toContain("Second failure");
  });

  it("pauses expiration while reading with the pointer or keyboard", () => {
    render(<GlobalApiErrorAlert actionError="Room switched." />);
    const alert = screen.getByRole("alert");
    const close = screen.getByRole("button", { name: "Dismiss notification" });
    fireEvent.mouseEnter(alert);
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.focus(close);
    fireEvent.mouseLeave(alert);
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.blur(close);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps an ongoing outage visible but permits dismissal and shows a later outage", () => {
    render(<GlobalApiErrorAlert actionError={null} />);
    act(() => reportCoreApiFailure());
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("alert").textContent).toContain("UPSTREAM_UNAVAILABLE");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => reportCoreApiFailure());
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => reportCoreApiSuccess());
    act(() => reportCoreApiFailure());
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("alert").textContent).toContain("UPSTREAM_UNAVAILABLE");
  });

  it("cancels expiration on unmount", () => {
    const onDismiss = vi.fn();
    const { unmount } = render(<GlobalApiErrorAlert actionError="Room switched." onDismissActionError={onDismiss} />);
    unmount();
    act(() => vi.advanceTimersByTime(20_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not declare outage when app is in the background", () => {
    render(<GlobalApiErrorAlert actionError={null} />);

    // Simulate going into background
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    act(() => reportCoreApiFailure());
    act(() => vi.advanceTimersByTime(30_000));

    expect(screen.queryByRole("alert")).toBeNull();

    // Return to foreground
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
