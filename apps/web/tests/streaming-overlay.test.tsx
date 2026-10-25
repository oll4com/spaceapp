import type { StreamingOverlaySnapshot } from "@space/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STREAMING_OVERLAY_POLL_INTERVAL_MS,
  STREAMING_OVERLAY_SESSION_KEY,
  StreamingOverlay,
  StreamingOverlayProvider,
  useStreamingOverlay
} from "../src/features/streaming/StreamingOverlay.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { loadWidgetStates, saveWidgetStates } from "../src/features/desktop-widgets/widget-storage.js";
import { installSpaceRuntime, type SpaceApiClient } from "../src/runtime/SpaceRuntime.js";

const snapshot: StreamingOverlaySnapshot = {
  generatedAt: "2026-08-11T12:00:00.000Z",
  settingsVersion: 4,
  tiles: [
    {
      metricKey: "youtube.channel.subscribers",
      accountId: "streaming_account:youtube",
      provider: "YOUTUBE",
      label: "Subscribers",
      badge: "Channel One",
      value: 12345,
      state: "STALE",
      sampledAt: "2026-08-11T11:59:00.000Z"
    },
    {
      metricKey: "twitch.concurrent_viewers",
      accountId: "streaming_account:twitch",
      provider: "TWITCH",
      label: "Concurrent viewers",
      badge: "Streamer",
      value: null,
      state: "OFFLINE",
      sampledAt: "2026-08-11T11:59:00.000Z"
    }
  ],
  customTextEnabled: true,
  customText: "Building live with Space",
  botTickerEnabled: false,
  botTicker: []
};

function Controls() {
  const { enabled, previewActive, setEnabled, setPreviewActive } = useStreamingOverlay();
  return (
    <>
      <button type="button" onClick={() => setEnabled(!enabled)}>Toggle overlay</button>
      <button type="button" onClick={() => setPreviewActive(!previewActive)}>Toggle preview</button>
    </>
  );
}

describe("StreamingOverlay", () => {
  const streamingOverlaySnapshot = vi.fn<SpaceApiClient["streamingOverlaySnapshot"]>();

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    streamingOverlaySnapshot.mockReset().mockResolvedValue(snapshot);
    installSpaceRuntime({
      ...liveRuntime,
      api: { streamingOverlaySnapshot } as unknown as SpaceApiClient
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls only for a tab-enabled overlay or active draft preview", async () => {
    vi.useFakeTimers();
    render(
      <StreamingOverlayProvider active>
        <Controls />
        <StreamingOverlay theme="classic" />
      </StreamingOverlayProvider>
    );

    expect(streamingOverlaySnapshot).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STREAMING_OVERLAY_SESSION_KEY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Toggle preview" }));
    await act(async () => { await Promise.resolve(); });
    expect(streamingOverlaySnapshot).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Streaming overlay")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(STREAMING_OVERLAY_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(streamingOverlaySnapshot).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Toggle preview" }));
    await act(async () => { vi.advanceTimersByTime(STREAMING_OVERLAY_POLL_INTERVAL_MS * 2); });
    expect(streamingOverlaySnapshot).toHaveBeenCalledTimes(2);
  });

  it("refreshes the shared metrics snapshot when only the widget is enabled", async () => {
    render(<StreamingOverlayProvider active><StreamingOverlay theme="classic" /></StreamingOverlayProvider>);
    expect(streamingOverlaySnapshot).not.toHaveBeenCalled();
    const widgets = loadWidgetStates();
    act(() => saveWidgetStates({ ...widgets, "streaming-metrics": { ...widgets["streaming-metrics"], enabled: true } }));
    await waitFor(() => expect(streamingOverlaySnapshot).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Streaming overlay")).toBeNull();
  });

  it("keeps activation in sessionStorage and renders status-safe classic and modern tiles", async () => {
    const { rerender } = render(
      <StreamingOverlayProvider active>
        <Controls />
        <StreamingOverlay theme="classic" />
      </StreamingOverlayProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle overlay" }));
    expect(window.sessionStorage.getItem(STREAMING_OVERLAY_SESSION_KEY)).toBe("true");
    const overlay = await screen.findByLabelText("Streaming overlay");
    expect(overlay.classList.contains("streaming-overlay-classic")).toBe(true);
    expect(screen.getByText("12.3K")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("Building live with Space")).toBeTruthy();

    rerender(
      <StreamingOverlayProvider active>
        <Controls />
        <StreamingOverlay theme="modern" />
      </StreamingOverlayProvider>
    );
    expect((await screen.findByLabelText("Streaming overlay")).classList.contains("streaming-overlay-modern")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Toggle overlay" }));
    await waitFor(() => expect(screen.queryByLabelText("Streaming overlay")).toBeNull());
    expect(window.sessionStorage.getItem(STREAMING_OVERLAY_SESSION_KEY)).toBe("false");
  });

  it("does not poll or render when the authenticated user is outside the admin scope", async () => {
    window.sessionStorage.setItem(STREAMING_OVERLAY_SESSION_KEY, "true");
    render(
      <StreamingOverlayProvider active={false}>
        <StreamingOverlay theme="classic" />
      </StreamingOverlayProvider>
    );
    await act(async () => { await Promise.resolve(); });
    expect(streamingOverlaySnapshot).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Streaming overlay")).toBeNull();
  });
});
