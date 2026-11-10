import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GlobalApiErrorAlert,
  reportCoreApiFailure,
  reportCoreApiSuccess,
  resetCoreApiAvailability
} from "../src/core-api-availability.js";
import { DockNotice } from "../src/features/dock-kit/DockKit.js";
import { CopilotNotice } from "../src/features/copilot-kit/CopilotNotice.js";
import { CopilotRail } from "../src/features/copilot-kit/CopilotRail.js";

const UPSTREAM = "UPSTREAM_UNAVAILABLE: Space API is not reachable from the web server.";
const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input.toString());

describe("global core API availability alert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The outage's own probe stays unanswered unless a test says otherwise.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
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

  it("shows a calm notice after ten seconds and the red error with its start time after sixty", () => {
    render(<GlobalApiErrorAlert actionError={null} />);
    const startedAt = Date.now();

    act(() => reportCoreApiFailure());
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("SpaceApp is updating… reconnecting");
    expect(screen.getByRole("status").textContent).not.toContain("UPSTREAM_UNAVAILABLE");

    act(() => vi.advanceTimersByTime(50_000));
    expect(screen.queryByRole("status")).toBeNull();
    const time = new Date(startedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    expect(screen.getByRole("alert").textContent).toContain(`Space API has not answered since ${time}`);
  });

  it("dates the outage from the failed request's start, so a request the proxy held shows it at once", () => {
    render(<GlobalApiErrorAlert actionError={null} />);
    act(() => reportCoreApiFailure(Date.now() - 10_000));
    expect(screen.getByRole("status").textContent).toContain("reconnecting");
  });

  it("probes with backoff and clears the notice by itself once Space answers", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("{}", { status: 502 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GlobalApiErrorAlert actionError={null} />);

    act(() => reportCoreApiFailure(Date.now() - 10_000));
    expect(screen.getByRole("status")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlOf(fetchMock.mock.calls[2]![0])).toBe("/readyz");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears a stale outage notice immediately after any core API success", async () => {
    let roomsCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).startsWith("/api/rooms") && roomsCalls++ > 0) {
        return new Response(JSON.stringify({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (urlOf(input).startsWith("/api/rooms")) {
        return new Response(JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "Space API is not reachable from the web server.", requestId: "space-web" } }),
          { status: 502, headers: { "content-type": "application/json" } });
      }
      throw new TypeError("Failed to fetch");
    }));
    const { api } = await import("../src/live-api.js");
    render(<GlobalApiErrorAlert actionError={null} />);

    await expect(api.rooms()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", status: 502 });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("status")).toBeTruthy();

    await act(async () => {
      await api.rooms();
    });

    expect(screen.queryByRole("status")).toBeNull();
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
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("reconnecting");
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
    expect(screen.getByRole("status").textContent).toContain("reconnecting");
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

describe("dock notices of a request that failed while Space restarts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    act(() => resetCoreApiAvailability());
  });

  afterEach(() => {
    act(() => resetCoreApiAvailability());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the calm notice, then clears the dock's error by itself once Space answers", () => {
    const onDismiss = vi.fn();
    act(() => reportCoreApiFailure());
    render(<DockNotice onDismiss={onDismiss}>{UPSTREAM}</DockNotice>);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("SpaceApp is updating… reconnecting");
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => reportCoreApiSuccess());
    expect(screen.queryByRole("status")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("turns red with the start time once the API has been down for a minute", () => {
    act(() => reportCoreApiFailure());
    render(<DockNotice>{UPSTREAM}</DockNotice>);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("alert").textContent).toMatch(/Space API has not answered since \d\d:\d\d:\d\d/);
  });

  it("drops a stale upstream error when Space already answers, and leaves other errors as they are", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<DockNotice onDismiss={onDismiss}>{UPSTREAM}</DockNotice>);
    expect(screen.queryByRole("status")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rerender(<DockNotice onDismiss={onDismiss}>The plan could not be loaded.</DockNotice>);
    expect(screen.getByRole("alert").textContent).toBe("The plan could not be loaded.");
  });

  it("keeps a copilot pane's upstream strip hidden under the calm notice, red past a minute, gone once Space answers", () => {
    act(() => reportCoreApiFailure());
    const { container, rerender } = render(<CopilotNotice text={UPSTREAM} />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelector(".jc-notice")).toBeNull();

    act(() => vi.advanceTimersByTime(50_000));
    expect(container.querySelector(".jc-notice")?.textContent).toBe(UPSTREAM);

    // The pane's own stored error is still there: the strip goes without waiting for its next read.
    act(() => reportCoreApiSuccess());
    expect(container.querySelector(".jc-notice")).toBeNull();

    rerender(<CopilotNotice text="The run could not be started." />);
    expect(container.querySelector(".jc-notice")?.textContent).toBe("The run could not be started.");
  });

  it("nous_msg:1be51d08: a copilot pane whose first read failed in the restart says Loading, not its empty tabs, until Space answers", () => {
    act(() => reportCoreApiFailure());
    const { container, rerender } = render(<CopilotNotice text={UPSTREAM} loaded={false} />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelector(".jc-notice.is-calm")?.textContent).toBe("Loading…");
    rerender(<CopilotNotice text={UPSTREAM} loaded />);
    expect(container.querySelector(".jc-notice")).toBeNull();
    act(() => vi.advanceTimersByTime(50_000));
    rerender(<CopilotNotice text={UPSTREAM} loaded={false} />);
    expect(container.querySelector(".jc-notice")?.textContent).toBe(UPSTREAM);
  });

  it("nous_msg:1be51d08: the copilot rail hides its empty tabs (never the terminal) while the first read waits for Space", () => {
    act(() => reportCoreApiFailure());
    const rail = (loaded: boolean, text: string | null = UPSTREAM) => (
      <CopilotRail tabs={[]} active="activity" collapsed={false} onSelect={() => undefined} firstRead={{ text, loaded }}>
        <p>No activity yet</p><div className="jc-panel-terminal" />
      </CopilotRail>
    );
    const { container, rerender } = render(rail(false));
    const body = () => container.querySelector(".jc-rail-body")?.getAttribute("data-first-read") ?? null;
    expect(body()).toBe("pending");
    rerender(rail(true));
    expect(body()).toBeNull();
    rerender(rail(false));
    // Space answers: still loading until the pane's own re-read (usePanePolling, at once on recovery) lands.
    act(() => reportCoreApiSuccess());
    expect(body()).toBe("pending");
    rerender(rail(true, null));
    expect(body()).toBeNull();
    expect(container.querySelector(".jc-panel-terminal")).not.toBeNull();
  });
});
