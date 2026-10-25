import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODE_RADIO_FALLBACK_STREAM_URL,
  CODE_RADIO_METADATA_URL,
  CODE_RADIO_PRIMARY_STREAM_URL,
  VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY,
  VIBE_MUSIC_PLAYBACK_STORAGE_KEY,
  VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY,
  VIBE_MUSIC_VOLUME_STORAGE_KEY,
  VibeMusicPlayer,
  parseCodeRadioMetadata
} from "../src/features/vibe-music/VibeMusicPlayer.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { flushPendingUserSettings } from "../src/features/user-settings/user-settings-save-queue.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { api } from "../src/api.js";
import { DEMO_LOCAL_REPLY, installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

vi.mock("../src/api.js", () => ({
  api: { links: vi.fn(), deleteLink: vi.fn() },
  SpaceApiError: class SpaceApiError extends Error {}
}));

function metadataResponse(payload: unknown, ok = true): Response {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
  return {
    ok,
    status: ok ? 200 : 503,
    headers: { get: (name: string) => name.toLowerCase() === "content-length" ? String(body.length) : null },
    body: stream,
    text: async () => body
  } as unknown as Response;
}

function validMetadata(title = "Keep Moving", artist = "Code Radio") {
  return { now_playing: { song: { title, artist, text: `${artist} - ${title}` } } };
}

function PlayerHarness({ mobile = false, roomTheme = "graphite" }: { mobile?: boolean; roomTheme?: "graphite" | "forest" }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <div className="board-toolbar">
        <button
          ref={triggerRef}
          type="button"
          aria-label="Music"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          Music
        </button>
      </div>
      <VibeMusicPlayer mobile={mobile} open={open} onOpenChange={setOpen} roomTheme={roomTheme} triggerRef={triggerRef} />
    </>
  );
}

function playerAudio(container: HTMLElement): HTMLAudioElement {
  const audio = container.querySelector<HTMLAudioElement>("audio[data-vibe-music-audio]");
  if (!audio) throw new Error("Vibe music audio element was not rendered.");
  return audio;
}

describe("VibeMusicPlayer", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(metadataResponse(validMetadata()))));
  });

  afterEach(async () => {
    cleanup();
    // Settings persisted by this test must not flush (and fetch) during the next one.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await flushPendingUserSettings();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps autoplay recovery visible before the Music menu trigger mounts", () => {
    render(<VibeMusicPlayer mobile={false} open onOpenChange={vi.fn()} roomTheme="graphite" triggerRef={{ current: null }} />);
    expect(screen.getByRole("dialog", { name: "Vibe Music" }).style.visibility).toBe("visible");
    expect(screen.getByRole("button", { name: "Play Code Radio" })).toBeTruthy();
  });

  it("keeps previously playing radio paused after reload", async () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "reload" }] as PerformanceNavigationTiming[]);
    window.sessionStorage.setItem(VIBE_MUSIC_PLAYBACK_STORAGE_KEY, JSON.stringify({ source: "radio", playing: true, linkId: null, savedAt: Date.now() }));
    const { container } = render(<PlayerHarness />);
    expect(playerAudio(container).hasAttribute("src")).toBe(false);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["navigate", "reload"])("does not restart paused music on %s", async (type) => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type }] as PerformanceNavigationTiming[]);
    window.sessionStorage.setItem(VIBE_MUSIC_PLAYBACK_STORAGE_KEY, JSON.stringify({ source: "radio", playing: false, linkId: null, savedAt: Date.now() }));
    const { container } = render(<PlayerHarness />);
    expect(playerAudio(container).hasAttribute("src")).toBe(false);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("saves playback before refresh and treats autoplay denial as blocked, not a broken station", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    render(<PlayerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(await screen.findByRole("button", { name: "Play Code Radio" }));
    expect(await screen.findByText("Press Play to resume your music.")).toBeTruthy();
    expect(screen.queryByText("Code Radio is unavailable")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(window, { key: "a" });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Code Radio" }));
    await screen.findByText("Playing");
    fireEvent(window, new Event("pagehide"));
    expect(JSON.parse(window.sessionStorage.getItem(VIBE_MUSIC_PLAYBACK_STORAGE_KEY)!)).toMatchObject({ source: "radio", playing: true });
  });

  it("does not connect before Play and disconnects the live stream on Pause", async () => {
    const { container } = render(<PlayerHarness />);
    const audio = playerAudio(container);

    expect(audio.hasAttribute("src")).toBe(false);
    expect(audio.preload).toBe("none");
    expect(audio.volume).toBeCloseTo(0.35);
    expect(fetch).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(await screen.findByRole("button", { name: "Play Code Radio" }));

    await waitFor(() => expect(audio.getAttribute("src")).toBe(CODE_RADIO_PRIMARY_STREAM_URL));
    await waitFor(() => expect(screen.getByText("Playing")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith(
      CODE_RADIO_METADATA_URL,
      expect.objectContaining({ credentials: "omit", cache: "no-store" })
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause Code Radio" }));

    expect(audio.hasAttribute("src")).toBe(false);
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it("keeps demo playback local without assigning external media or fetching metadata", async () => {
    installSpaceRuntime(createDemoRuntime().runtime);
    const { container } = render(<PlayerHarness />);
    const audio = playerAudio(container);

    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(await screen.findByRole("button", { name: "Play Code Radio" }));

    expect(await screen.findByText(DEMO_LOCAL_REPLY)).toBeTruthy();
    expect(screen.getByText("Code Radio is unavailable")).toBeTruthy();
    expect(audio.hasAttribute("src")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("tries the 64 kbps stream once, then exposes an unavailable state and Retry", async () => {
    const { container } = render(<PlayerHarness />);
    const audio = playerAudio(container);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Code Radio" }));
    await waitFor(() => expect(audio.getAttribute("src")).toBe(CODE_RADIO_PRIMARY_STREAM_URL));

    fireEvent.error(audio);
    await waitFor(() => expect(audio.getAttribute("src")).toBe(CODE_RADIO_FALLBACK_STREAM_URL));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);

    fireEvent.error(audio);
    expect(await screen.findByText("Code Radio is unavailable")).toBeTruthy();
    expect(audio.hasAttribute("src")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Retry Code Radio" }));
    await waitFor(() => expect(audio.getAttribute("src")).toBe(CODE_RADIO_PRIMARY_STREAM_URL));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(3);
  });

  it("persists only a validated volume and never restores playback", async () => {
    window.localStorage.setItem(VIBE_MUSIC_VOLUME_STORAGE_KEY, "0.62");
    const first = render(<PlayerHarness />);
    const firstAudio = playerAudio(first.container);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));

    const volume = screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;
    expect(volume.value).toBe("62");
    expect(firstAudio.volume).toBeCloseTo(0.62);
    fireEvent.change(volume, { target: { value: "20" } });
    expect(window.localStorage.getItem(VIBE_MUSIC_VOLUME_STORAGE_KEY)).toBe("0.2");

    first.unmount();
    const second = render(<PlayerHarness />);
    const secondAudio = playerAudio(second.container);
    expect(secondAudio.hasAttribute("src")).toBe(false);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    expect((screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement).value).toBe("20");
  });

  it("ignores malformed stored volume values", () => {
    window.localStorage.setItem(VIBE_MUSIC_VOLUME_STORAGE_KEY, "0.62not-a-volume");
    const { container } = render(<PlayerHarness />);

    expect(playerAudio(container).volume).toBeCloseTo(0.35);
  });

  it("validates, bounds, and renders third-party metadata only as text", async () => {
    const longTitle = `<img src=x onerror=alert(1)>${"x".repeat(240)}`;
    vi.mocked(fetch).mockResolvedValue(metadataResponse(validMetadata(longTitle, "DJ\u0000 Test")));
    const { container } = render(<PlayerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Code Radio" }));

    const track = await screen.findByTestId("vibe-music-track");
    expect(track.textContent?.length).toBeLessThanOrEqual(160);
    expect(track.textContent).not.toContain("\u0000");
    expect(track.querySelector("img")).toBeNull();
    expect(container.querySelector("img[src='x']")).toBeNull();

    const parsed = parseCodeRadioMetadata(validMetadata("Title", "Artist"));
    expect(parsed).toBe("Artist — Title");
    expect(parseCodeRadioMetadata({ now_playing: { song: { title: 12, artist: [] } } })).toBeNull();
  });

  it("cancels an undeclared metadata body as soon as it exceeds 64 KiB", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(40 * 1024) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(40 * 1024) })
      .mockResolvedValue({ done: true, value: undefined });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const text = vi.fn().mockResolvedValue(JSON.stringify(validMetadata()));
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({ read, cancel, releaseLock }) },
      text
    } as unknown as Response);

    render(<PlayerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Code Radio" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledTimes(2);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(screen.getByText("Track details unavailable")).toBeTruthy();
  });

  it("rejects metadata without a readable stream before buffering its body", async () => {
    const text = vi.fn().mockResolvedValue(JSON.stringify(validMetadata()));
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      text
    } as unknown as Response);

    render(<PlayerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Code Radio" }));

    expect(await screen.findByText("Track details unavailable")).toBeTruthy();
    expect(text).not.toHaveBeenCalled();
  });

  it("keeps playback healthy when metadata fails and stops polling after Pause", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockRejectedValue(new Error("metadata offline"));
    render(<PlayerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Code Radio" }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Playing")).toBeTruthy();
    expect(screen.getByText("Track details unavailable")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Pause Code Radio" }));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves the 30-second metadata cadence across buffering and disconnects on native pause", async () => {
    vi.useFakeTimers();
    const metadataSignals: AbortSignal[] = [];
    vi.mocked(fetch).mockImplementation((_input, init) => {
      if (init?.signal) metadataSignals.push(init.signal);
      return Promise.resolve(metadataResponse(validMetadata()));
    });
    const { container } = render(<PlayerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Code Radio" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const audio = playerAudio(container);
    expect(screen.getByText("Playing")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);

    fireEvent.waiting(audio);
    expect(screen.getByText("Connecting")).toBeTruthy();
    expect(metadataSignals[0]?.aborted).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    fireEvent.playing(audio);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Playing")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(29_000);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(3);

    Object.defineProperty(audio, "paused", { configurable: true, value: true });
    fireEvent.pause(audio);
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(audio.hasAttribute("src")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("registers MediaSession metadata and keeps paused radio paused on returning to the tab", async () => {
    const handlers: Record<string, Function> = {};
    const mediaSessionMock = {
      metadata: null as unknown,
      playbackState: "none",
      setActionHandler: vi.fn((action: string, handler: Function | null) => {
        if (handler) handlers[action] = handler;
        else delete handlers[action];
      })
    };
    class FakeMediaMetadata {
      title: string;
      artist: string;
      album: string;
      artwork: unknown[];
      constructor(init: any) {
        this.title = init.title;
        this.artist = init.artist;
        this.album = init.album;
        this.artwork = init.artwork;
      }
    }
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: mediaSessionMock
    });

    const { container } = render(<PlayerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(await screen.findByRole("button", { name: "Play Code Radio" }));
    await screen.findByText("Playing");

    expect(mediaSessionMock.playbackState).toBe("playing");
    expect(mediaSessionMock.setActionHandler).toHaveBeenCalledWith("play", expect.any(Function));
    expect(mediaSessionMock.setActionHandler).toHaveBeenCalledWith("pause", expect.any(Function));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));

    const audio = playerAudio(container);
    Object.defineProperty(audio, "paused", { configurable: true, value: true });
    fireEvent.pause(audio);
    expect(screen.getByText("Paused")).toBeTruthy();

    const playsBeforeReturn = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playsBeforeReturn);
    expect(screen.getByText("Paused")).toBeTruthy();

    await waitFor(() => {
      expect(playerAudio(container).hasAttribute("src")).toBe(false);
    });
  });

  it("repositions the desktop popover when its content resizes or toolbar geometry moves", async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const resizeTargets: Element[] = [];
    const mutationCallbacks: MutationCallback[] = [];
    const mutationTargets: Node[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(target: Element) {
        resizeTargets.push(target);
      }
      unobserve() {}
      disconnect() {}
    }
    class TestMutationObserver {
      constructor(callback: MutationCallback) {
        mutationCallbacks.push(callback);
      }
      observe(target: Node) {
        mutationTargets.push(target);
      }
      takeRecords() {
        return [];
      }
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("MutationObserver", TestMutationObserver);

    render(<PlayerHarness />);
    const trigger = screen.getByRole("button", { name: "Music" });
    const triggerRect = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 80,
      height: 40,
      left: 860,
      right: 900,
      top: 40,
      width: 40,
      x: 860,
      y: 40,
      toJSON: () => ({})
    });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Vibe Music" });
    const panelRect = vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      bottom: 348,
      height: 260,
      left: 580,
      right: 900,
      top: 88,
      width: 320,
      x: 580,
      y: 88,
      toJSON: () => ({})
    });

    expect(resizeTargets).toEqual(expect.arrayContaining([trigger, dialog]));
    expect(mutationTargets).toContain(trigger.closest(".board-toolbar"));
    await act(async () => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    });
    expect(dialog.style.left).toBe("580px");
    expect(dialog.style.top).toBe("88px");

    triggerRect.mockReturnValue({
      bottom: 440,
      height: 40,
      left: 460,
      right: 500,
      top: 400,
      width: 40,
      x: 460,
      y: 400,
      toJSON: () => ({})
    });
    panelRect.mockReturnValue({
      bottom: 708,
      height: 700,
      left: 140,
      right: 500,
      top: 8,
      width: 360,
      x: 140,
      y: 8,
      toJSON: () => ({})
    });
    await act(async () => {
      mutationCallbacks.forEach((callback) => callback([], {} as MutationObserver));
    });
    expect(dialog.style.left).toBe("140px");
    expect(dialog.style.top).toBe("8px");
  });

  it("preserves the selected room theme on the body portal", async () => {
    render(<PlayerHarness roomTheme="forest" />);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));

    const dialog = await screen.findByRole("dialog", { name: "Vibe Music" });
    expect(dialog.classList.contains("vibe-music-theme")).toBe(true);
    expect(dialog.getAttribute("data-room-theme")).toBe("forest");
  });

  it("cleans up on unmount and restores focus for Escape and outside click", async () => {
    const view = render(<PlayerHarness />);
    const trigger = screen.getByRole("button", { name: "Music" });
    trigger.focus();
    fireEvent.click(trigger);
    const play = await screen.findByRole("button", { name: "Play Code Radio" });
    await waitFor(() => expect(document.activeElement).toBe(play));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vibe Music" })).toBeNull());
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Vibe Music" });
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vibe Music" })).toBeNull());
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Play Code Radio" }));
    const audio = playerAudio(view.container);
    await waitFor(() => expect(audio.hasAttribute("src")).toBe(true));
    view.unmount();
    expect(audio.hasAttribute("src")).toBe(false);
  });

  it("uses an isolated modal bottom sheet with a complete mobile focus trap", async () => {
    const { container } = render(<PlayerHarness mobile />);
    const trigger = screen.getByRole("button", { name: "Music" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Vibe Music" });
    expect(dialog.classList.contains("vibe-music-sheet")).toBe(true);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.closest(".vibe-music-sheet-backdrop")).toBeTruthy();
    expect((container as HTMLElement & { inert?: boolean }).inert).toBe(true);

    const close = screen.getByRole("button", { name: "Close Vibe Music" });
    const play = screen.getByRole("button", { name: "Play Code Radio" });
    const radioToggle = screen.getByRole("button", { name: "Radio" });
    const volume = screen.getByRole("slider", { name: /Volume/i });
    await waitFor(() => expect(document.activeElement).toBe(play));

    volume.focus();
    fireEvent.keyDown(volume, { key: "Tab" });
    expect(document.activeElement).toBe(radioToggle);
    radioToggle.focus();
    fireEvent.keyDown(radioToggle, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(volume);

    trigger.focus();
    expect(document.activeElement).toBe(play);
    fireEvent.click(close);
    expect((container as HTMLElement & { inert?: boolean }).inert).not.toBe(true);
    expect(document.activeElement).toBe(trigger);
  });
});

describe("VibeMusicPlayer playlist mode", () => {
  const fakePlayers: Array<{
    events: Record<string, (event: { data?: number }) => void>;
    options: { videoId?: string; playerVars?: Record<string, string | number | boolean> };
    playVideo: ReturnType<typeof vi.fn>;
    pauseVideo: ReturnType<typeof vi.fn>;
    loadVideoById: ReturnType<typeof vi.fn>;
    cueVideoById: ReturnType<typeof vi.fn>;
    nextVideo: ReturnType<typeof vi.fn>;
    previousVideo: ReturnType<typeof vi.fn>;
    setVolume: ReturnType<typeof vi.fn>;
    getCurrentTime: ReturnType<typeof vi.fn>;
    getDuration: ReturnType<typeof vi.fn>;
    setLoop: ReturnType<typeof vi.fn>;
    getLoop: ReturnType<typeof vi.fn>;
    seekTo: ReturnType<typeof vi.fn>;
    playVideoAt: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    hostWasConnected: boolean;
  }> = [];
  let fakePlaylist: string[];
  let fakeIndex: number;
  let fakeTime: number;
  let fakeDuration: number;
  let fakeLoop: boolean;
  let replacePlayerHostWithIframe: boolean;

  class FakeYouTubePlayer {
    events: Record<string, (event: { data?: number }) => void>;
    options: { videoId?: string; playerVars?: Record<string, string | number | boolean> };
    playVideo = vi.fn();
    pauseVideo = vi.fn();
    loadVideoById = vi.fn();
    cueVideoById = vi.fn();
    nextVideo = vi.fn();
    previousVideo = vi.fn();
    setVolume = vi.fn();
    destroy = vi.fn();
    hostWasConnected: boolean;
    constructor(elementOrId: string | HTMLElement, options: { videoId?: string; playerVars?: Record<string, string | number | boolean>; events?: Record<string, (event: { data?: number }) => void> }) {
      this.events = options.events ?? {};
      this.options = options;
      const host = typeof elementOrId === "string" ? document.getElementById(elementOrId) : elementOrId;
      this.hostWasConnected = host?.isConnected === true;
      if (replacePlayerHostWithIframe && host) {
        const iframe = document.createElement("iframe");
        if (typeof elementOrId === "string") iframe.id = elementOrId;
        host.replaceWith(iframe);
        this.destroy.mockImplementation(() => iframe.remove());
      }
      fakePlayers.push(this);
    }
    getVideoData() {
      return { title: "Test Song", video_id: "v1" };
    }
    getCurrentTime = vi.fn(() => fakeTime);
    getDuration = vi.fn(() => fakeDuration);
    setLoop = vi.fn((enabled: boolean) => {
      fakeLoop = enabled;
    });
    getLoop = vi.fn(() => fakeLoop);
    seekTo = vi.fn();
    playVideoAt = vi.fn();
    getPlaylist() {
      return fakePlaylist;
    }
    getPlaylistIndex() {
      return fakeIndex;
    }
  }

  function defaultLinks(): Awaited<ReturnType<typeof api.links>> {
    return {
      data: [
        { id: "l1", title: "Focus Beats", description: "", url: "https://www.youtube.com/playlist?list=PL1111111111111111", openMode: "EMBEDDED", category: "MUSIC_LIBRARY", isQuick: false, sortOrder: 0, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z" },
        { id: "l2", title: "Office", description: "", url: "https://www.youtube.com/watch?v=abcdefghijk", openMode: "EMBEDDED", category: "MUSIC_LIBRARY", isQuick: false, sortOrder: 0, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z" },
        { id: "l3", title: "Docs", description: "", url: "https://docs.example.com/", openMode: "NEW_TAB", category: "GENERAL", isQuick: false, sortOrder: 0, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z" },
        { id: "l4", title: "Spotify Mix", description: "", url: "https://open.spotify.com/playlist/x", openMode: "NEW_TAB", category: "MUSIC_LIBRARY", isQuick: false, sortOrder: 0, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z" }
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 4, totalPages: 1 }
    };
  }

  beforeEach(() => {
    cleanup();
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
    window.sessionStorage.clear();
    fakePlayers.length = 0;
    fakePlaylist = ["v1", "v2", "v3"];
    fakeIndex = 0;
    fakeTime = 0;
    fakeDuration = 0;
    fakeLoop = false;
    replacePlayerHostWithIframe = false;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Metadata unavailable")));
    vi.stubGlobal("YT", { Player: FakeYouTubePlayer });
    vi.mocked(api.links).mockResolvedValue(defaultLinks());
  });

  afterEach(async () => {
    cleanup();
    // Settings persisted by this test must not flush (and fetch) during the next one.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await flushPendingUserSettings();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function openPlaylistTab() {
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(await screen.findByRole("button", { name: "Playlist" }));
    await waitFor(() => expect(api.links).toHaveBeenCalled());
  }

  async function waitForPlaylistSession() {
    await waitFor(() => {
      const button = screen.getByRole("button", { name: "Play playlist" });
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
  }

  async function startPlaylistFromPicker(title: string) {
    const select = screen.getByRole("combobox", { name: "Music library playlist" }) as HTMLSelectElement;
    const option = Array.from(select.options).find((entry) => entry.textContent === title);
    expect(option).toBeTruthy();
    fireEvent.change(select, { target: { value: option!.value } });
  }

  it("uses a bounded mobile playlist picker", async () => {
    render(<PlayerHarness mobile />);
    await openPlaylistTab();
    const picker = screen.getByRole("button", { name: "Select a playlist…" });
    fireEvent.click(picker);
    expect(screen.getByRole("group", { name: "Music library playlists" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Focus Beats" }));
    expect(screen.queryByRole("group", { name: "Music library playlists" })).toBeNull();
    expect(screen.getByRole("button", { name: "Focus Beats" })).toBeTruthy();
  });

  it("deletes the selected saved link, stops playback and clears its saved selection", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.deleteLink).mockResolvedValue({ id: "l1", deleted: true });
    render(<PlayerHarness />);
    await openPlaylistTab();
    expect((screen.getByRole("button", { name: "Delete selected playlist link" }) as HTMLButtonElement).disabled).toBe(true);
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => { fakePlayers[0]!.events.onReady?.({}); fakePlayers[0]!.events.onStateChange?.({ data: 1 }); });
    fireEvent.click(screen.getByRole("button", { name: "Delete selected playlist link" }));
    await waitFor(() => expect(api.deleteLink).toHaveBeenCalledWith("l1"));
    await waitFor(() => expect(screen.queryByRole("option", { name: "Focus Beats" })).toBeNull());
    expect(fakePlayers[0]!.destroy).toHaveBeenCalled();
    expect(window.localStorage.getItem(VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("option", { name: "Office" })).toBeTruthy();
  });

  it("keeps a link when deletion is cancelled or the server rejects it", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(api.deleteLink).mockClear().mockRejectedValue(new Error("offline"));
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected playlist link" }));
    expect(api.deleteLink).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete selected playlist link" }));
    expect(await screen.findByText("Link could not be deleted. Please try again.")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Focus Beats" })).toBeTruthy();
    expect(fakePlayers[0]!.destroy).not.toHaveBeenCalled();
  });

  it("restores playlist position on opening after reload but waits for Play", async () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "reload" }] as PerformanceNavigationTiming[]);
    window.sessionStorage.setItem(VIBE_MUSIC_PLAYBACK_STORAGE_KEY, JSON.stringify({ source: "playlist", playing: true, linkId: "l1", savedAt: Date.now() }));
    window.localStorage.setItem(VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY, JSON.stringify({ linkId: "l1", trackIndex: 2, seconds: 203, videoId: "abcdefghijk" }));
    render(<PlayerHarness />);
    expect(fakePlayers).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    expect(fakePlayers[0]!.options.playerVars).toMatchObject({ autoplay: 0, index: 2, start: 203 });
    expect(fakePlayers[0]!.options.videoId).toBe("abcdefghijk");
    expect(JSON.parse(window.localStorage.getItem(VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY)!)).toMatchObject({ seconds: 203 });
    act(() => fakePlayers[0]!.events.onReady?.({}));
    expect(fakePlayers[0]!.playVideo).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play playlist" })).toBeTruthy();
  });

  it("shows only playable YouTube music library links and loads them with page size 100", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();

    expect(screen.getByText("Focus Beats")).toBeTruthy();
    expect(screen.getByText("Office")).toBeTruthy();
    expect(screen.queryByText("Spotify Mix")).toBeNull();
    expect(screen.queryByText("Docs")).toBeNull();
    const picker = screen.getByRole("combobox", { name: "Music library playlist" }) as HTMLSelectElement;
    expect(picker.value).toBe("");
    expect(api.links).toHaveBeenCalledWith({ page: 1, pageSize: 100 });
    expect(document.getElementById("vibe-music-youtube-stage")).toBeTruthy();
  });

  it("starts the first playlist immediately when Play is pressed without a saved session", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await screen.findByText("Focus Beats");

    const play = screen.getByRole("button", { name: "Play playlist" }) as HTMLButtonElement;
    expect(play.disabled).toBe(false);
    fireEvent.click(play);

    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    expect(fakePlayers[0]!.options.playerVars).toMatchObject({
      list: "PL1111111111111111",
      autoplay: 1,
      index: 0
    });
    act(() => {
      fakePlayers[0]!.events.onReady?.({});
    });
    expect(fakePlayers[0]!.playVideo).toHaveBeenCalled();
    expect((screen.getByRole("combobox", { name: "Music library playlist" }) as HTMLSelectElement).value).toBe("l1");
  });

  it("restores the saved track and timestamp when Play creates a new session", async () => {
    window.localStorage.setItem(VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY, "l1");
    window.localStorage.setItem(VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY, JSON.stringify({
      linkId: "l1",
      trackIndex: 2,
      seconds: 203,
      videoId: "abcdefghijk"
    }));
    render(<PlayerHarness />);
    await openPlaylistTab();
    await screen.findByText("Focus Beats");

    fireEvent.click(screen.getByRole("button", { name: "Play playlist" }));
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    expect(fakePlayers[0]!.options.playerVars).toMatchObject({ autoplay: 0, index: 2, start: 203 });

    act(() => {
      fakePlayers[0]!.events.onReady?.({});
    });
    expect(fakePlayers[0]!.seekTo).toHaveBeenCalledWith(203, true);
    expect(fakePlayers[0]!.playVideo).toHaveBeenCalled();
  });

  it("persists the current playlist track and timestamp", async () => {
    fakeIndex = 1;
    fakeTime = 203;
    fakeDuration = 320;
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));

    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
    });
    expect(JSON.parse(window.localStorage.getItem(VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY) ?? "null")).toMatchObject({
      linkId: "l1",
      trackIndex: 1,
      seconds: 203
    });
  });

  it("starts a hidden YouTube player with the playlist id and reflects playback state", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();

    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    expect(fakePlayers[0]!.options.videoId).toBeUndefined();
    expect(fakePlayers[0]!.options.playerVars).toMatchObject({
      listType: "playlist",
      list: "PL1111111111111111",
      autoplay: 0,
      controls: 0
    });

    await waitForPlaylistSession();
    act(() => {
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
    });
    expect(screen.getByRole("button", { name: "Pause playlist" })).toBeTruthy();
    expect(screen.getByText("Test Song")).toBeTruthy();
    expect(screen.getByText("Track 1 of 3")).toBeTruthy();
    expect(screen.getByText("Playing")).toBeTruthy();
  });

  it("delegates next and previous song to the player", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => {
      fakePlayers[0]!.events.onReady?.({});
    });
    await waitForPlaylistSession();

    fireEvent.click(screen.getByRole("button", { name: "Next song" }));
    expect(fakePlayers[0]!.nextVideo).toHaveBeenCalled();
    expect(fakePlayers[0]!.playVideo).toHaveBeenCalled();
    fakeIndex = 1;
    act(() => {
      fakePlayers[0]!.events.onStateChange?.({ data: 2 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Previous song" }));
    expect(fakePlayers[0]!.previousVideo).toHaveBeenCalled();
    expect(fakePlayers[0]!.playVideo).toHaveBeenCalledTimes(2);
  });

  it("wraps next and previous at the playlist boundaries and uses matching chevrons", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();
    act(() => {
      fakePlayers[0]!.events.onReady?.({});
    });

    const previous = screen.getByRole("button", { name: "Previous song" });
    const next = screen.getByRole("button", { name: "Next song" });
    expect(previous.querySelector(".lucide-chevron-left")).toBeTruthy();
    expect(next.querySelector(".lucide-chevron-right")).toBeTruthy();

    fakeIndex = 2;
    act(() => {
      fakePlayers[0]!.events.onStateChange?.({ data: 2 });
    });
    fireEvent.click(next);
    expect(fakePlayers[0]!.playVideoAt).toHaveBeenCalledWith(0);

    fakeIndex = 0;
    act(() => {
      fakePlayers[0]!.events.onStateChange?.({ data: 2 });
    });
    fireEvent.click(previous);
    expect(fakePlayers[0]!.playVideoAt).toHaveBeenCalledWith(2);
  });

  it("pauses and resumes the playlist", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();
    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
    });

    fireEvent.click(screen.getByRole("button", { name: "Pause playlist" }));
    expect(fakePlayers[0]!.pauseVideo).toHaveBeenCalled();
    expect(screen.getByText("Paused")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Play playlist" }));
    expect(fakePlayers[0]!.playVideo).toHaveBeenCalled();
  });

  it("loops to the first track when the playlist ends", async () => {
    fakeIndex = 2;
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
      fakePlayers[0]!.events.onStateChange?.({ data: 0 });
    });

    expect(fakePlayers[0]!.playVideoAt).toHaveBeenCalledWith(0);
    expect(screen.getByText("Connecting")).toBeTruthy();
  });

  it.each([true, false])("lets YouTube advance intermediate tracks with repeat=%s", async (repeat) => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => fakePlayers[0]!.events.onReady?.({}));
    if (!repeat) fireEvent.click(screen.getByRole("button", { name: "Repeat playlist" }));
    act(() => {
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
      fakePlayers[0]!.events.onStateChange?.({ data: 0 });
    });
    expect(fakePlayers[0]!.playVideoAt).not.toHaveBeenCalled();
    expect(fakePlayers[0]!.nextVideo).not.toHaveBeenCalled();
    expect(screen.getByText("Connecting")).toBeTruthy();
    act(() => { fakeIndex = 1; fakePlayers[0]!.events.onStateChange?.({ data: 1 }); });
    expect(screen.getByText("Track 2 of 3")).toBeTruthy();
  });

  it("continues playback when selecting another library entry while playing", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => { fakePlayers[0]!.events.onReady?.({}); fakePlayers[0]!.events.onStateChange?.({ data: 1 }); });
    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(2));
    expect(fakePlayers[1]!.options.playerVars).toMatchObject({ autoplay: 1 });
  });

  it("stops repeated errors and preserves track metadata with a recovery link", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onError?.({ data: 150 });
      fakePlayers[0]!.events.onError?.({ data: 150 });
    });
    expect(fakePlayers[0]!.nextVideo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Retry playlist" })).toBeTruthy();
    expect(screen.getByTestId("vibe-music-playlist-track").textContent).toBe("Test Song");
    expect(screen.getByRole("link", { name: "Open in YouTube" }).getAttribute("href")).toContain("PL1111111111111111");
  });

  it("does not skip a playlist on a player configuration error", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => { fakePlayers[0]!.events.onReady?.({}); fakePlayers[0]!.events.onError?.({ data: 153 }); });
    expect(fakePlayers[0]!.nextVideo).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("could not verify");
  });

  it("offers Play instead of timing out when the browser blocks autoplay", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => fakePlayers[0]!.events.onReady?.({}));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Play playlist" }));
    act(() => fakePlayers[0]!.events.onAutoplayBlocked?.({}));
    act(() => vi.advanceTimersByTime(12_000));
    expect(screen.getByRole("button", { name: "Play playlist" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Press Play");
    fireEvent.click(screen.getByRole("button", { name: "Play playlist" }));
    expect(screen.queryByRole("alert")).toBeNull();
    vi.useRealTimers();
  });

  it("bounds queue metadata requests and cancels them when the queue closes", async () => {
    fakePlaylist = Array.from({ length: 200 }, (_, index) => `video${index}`);
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signals.push(options.signal);
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })));
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => fakePlayers[0]!.events.onReady?.({}));
    fireEvent.click(screen.getByRole("button", { name: "Show playlist queue" }));
    expect(screen.getByRole("button", { name: "Play Track 200" })).toBeTruthy();
    expect(signals).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Hide playlist queue" }));
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("shows the real Mix queue instead of substituting library entries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ title: "Mix track" }) }));
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => fakePlayers[0]!.events.onReady?.({}));
    fireEvent.click(screen.getByRole("button", { name: "Show playlist queue" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Play Mix track" })).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Play Focus Beats" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Play Mix track" })[1]!);
    expect(fakePlayers[0]!.playVideoAt).toHaveBeenCalledWith(1);
  });

  it("plays a single video link inside its YouTube Mix", async () => {
    fakePlaylist = ["abcdefghijk"];
    render(<PlayerHarness />);
    await openPlaylistTab();

    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    expect(fakePlayers[0]!.options.videoId).toBe("abcdefghijk");
    expect(fakePlayers[0]!.options.playerVars).toMatchObject({ listType: "playlist", list: "RDabcdefghijk" });

    act(() => {
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
    });
    expect(screen.getByText("Track 1 of 1")).toBeTruthy();
  });

  it("recreates a connected inner player host after YouTube replaces the previous host with an iframe", async () => {
    replacePlayerHostWithIframe = true;
    render(<PlayerHarness />);
    await openPlaylistTab();

    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    expect(fakePlayers[0]!.hostWasConnected).toBe(true);

    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(2));
    expect(fakePlayers[0]!.destroy).toHaveBeenCalled();
    expect(fakePlayers[1]!.hostWasConnected).toBe(true);
    expect(document.getElementById("vibe-music-youtube-stage")?.isConnected).toBe(true);
  });

  it("moves next and previous across playable Music Library links for a single video", async () => {
    fakePlaylist = ["abcdefghijk"];
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => fakePlayers[0]!.events.onReady?.({}));

    fireEvent.click(screen.getByRole("button", { name: "Next song" }));
    await waitFor(() => expect(fakePlayers).toHaveLength(2));
    expect(fakePlayers[1]!.options.playerVars).toMatchObject({
      list: "PL1111111111111111",
      autoplay: 1
    });
    expect((screen.getByRole("combobox", { name: "Music library playlist" }) as HTMLSelectElement).value).toBe("l1");

    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(3));
    act(() => fakePlayers[2]!.events.onReady?.({}));
    fireEvent.click(screen.getByRole("button", { name: "Previous song" }));
    await waitFor(() => expect(fakePlayers).toHaveLength(4));
    expect(fakePlayers[3]!.options.playerVars).toMatchObject({
      list: "PL1111111111111111",
      autoplay: 1
    });
    expect((screen.getByRole("combobox", { name: "Music library playlist" }) as HTMLSelectElement).value).toBe("l1");
  });

  it("uses the Music Library as the queue when a single video has no internal YouTube playlist", async () => {
    fakePlaylist = [];
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => fakePlayers[0]!.events.onReady?.({}));

    fireEvent.click(screen.getByRole("button", { name: "Show playlist queue" }));
    expect(await screen.findByRole("button", { name: "Play Focus Beats" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play Office" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Play Spotify Mix" })).toBeNull();
    expect(screen.queryByText("No tracks available.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Play Focus Beats" }));
    await waitFor(() => expect(fakePlayers).toHaveLength(2));
    expect(fakePlayers[1]!.options.playerVars).toMatchObject({
      list: "PL1111111111111111",
      autoplay: 1
    });
  });

  it("restarts a repeating single video from the beginning when it ends", async () => {
    fakePlaylist = [];
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));

    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
      fakePlayers[0]!.events.onStateChange?.({ data: 0 });
    });

    expect(fakePlayers[0]!.seekTo).toHaveBeenCalledWith(0, true);
    expect(fakePlayers[0]!.playVideo).toHaveBeenCalled();
    expect(fakePlayers[0]!.playVideoAt).not.toHaveBeenCalled();
  });

  it("applies the shared volume to the YouTube player", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();

    act(() => {
      fakePlayers[0]!.events.onReady?.({});
    });
    expect(fakePlayers[0]!.setVolume).toHaveBeenCalledWith(35);

    fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "62" } });
    await waitFor(() => expect(fakePlayers[0]!.setVolume).toHaveBeenCalledWith(62));
  });

  it("switches sources exclusively: radio stops on playlist and playlist stops on radio", async () => {
    const { container } = render(<PlayerHarness />);
    const audio = playerAudio(container);

    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(await screen.findByRole("button", { name: "Play Code Radio" }));
    await waitFor(() => expect(audio.getAttribute("src")).toBe(CODE_RADIO_PRIMARY_STREAM_URL));

    fireEvent.click(screen.getByRole("button", { name: "Playlist" }));
    await waitFor(() => expect(audio.hasAttribute("src")).toBe(false));

    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();

    fireEvent.click(screen.getByRole("button", { name: "Radio" }));
    await waitFor(() => expect(fakePlayers[0]!.destroy).toHaveBeenCalled());
  });

  it("persists the selected playlist and restores a cued player with working controls without autoplay", async () => {
    const { unmount } = render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    expect(window.localStorage.getItem(VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY)).toBe("l1");

    unmount();
    fakePlayers.length = 0;
    const { container } = render(<PlayerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(await screen.findByRole("button", { name: "Playlist" }));
    await screen.findByText("Focus Beats");
    const select = screen.getByRole("combobox", { name: "Music library playlist" }) as HTMLSelectElement;
    expect(select.value).toBe("l1");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    expect(fakePlayers[0]!.options.playerVars).toMatchObject({
      list: "PL1111111111111111",
      autoplay: 0
    });
    expect(fakePlayers[0]!.playVideo).not.toHaveBeenCalled();
    await waitForPlaylistSession();
    expect((screen.getByRole("button", { name: "Repeat playlist" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Previous song" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Next song" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Show playlist queue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reopens a paused playlist without loading the library or restarting its player", async () => {
    window.localStorage.setItem(VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY, "l1");
    render(<PlayerHarness />);
    await openPlaylistTab();
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();
    const player = fakePlayers[0]!;
    const requests = vi.mocked(api.links).mock.calls.length;
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Music" }));
      fireEvent.pointerDown(screen.getByRole("button", { name: "Music" }));
      fireEvent.click(screen.getByRole("button", { name: "Music" }));
      expect(screen.getByRole("combobox", { name: "Music library playlist" })).toHaveProperty("value", "l1");
    }
    expect(vi.mocked(api.links).mock.calls.length).toBe(requests);
    expect(fakePlayers).toHaveLength(1);
    expect(player.destroy).not.toHaveBeenCalled();
    expect(player.playVideo).not.toHaveBeenCalled();
  });

  it("refreshes the playlist list while closed when user links change", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    const callsAfterOpen = vi.mocked(api.links).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Music" }));

    vi.mocked(api.links).mockResolvedValue({
      data: [
        { id: "l5", title: "New Mix", description: "", url: "https://www.youtube.com/playlist?list=PL5555555555555555", openMode: "EMBEDDED", category: "MUSIC_LIBRARY", isQuick: false, sortOrder: 0, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z" }
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    window.dispatchEvent(new Event("space:user-links-updated"));
    await waitFor(() => expect(vi.mocked(api.links).mock.calls.length).toBeGreaterThan(callsAfterOpen));
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    expect(screen.getByText("New Mix")).toBeTruthy();
  });

  it("shows the empty state when no music library links exist", async () => {
    installSpaceRuntime(createDemoRuntime().runtime);
    vi.mocked(api.links).mockResolvedValue({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } });
    render(<PlayerHarness />);
    await openPlaylistTab();

    expect(screen.getByText(/No music library links yet/i)).toBeTruthy();
  });

  it("destroys the YouTube player on unmount", async () => {
    const { unmount } = render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));

    unmount();
    expect(fakePlayers[0]!.destroy).toHaveBeenCalled();
  });

  it("does not surface a transient playlist error during load as unavailable", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));

    act(() => {
      fakePlayers[0]!.events.onError?.({ data: 150 });
    });
    expect(screen.queryByText("YouTube playback is unavailable")).toBeNull();

    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
    });
    expect(screen.getByRole("button", { name: "Pause playlist" })).toBeTruthy();
    expect(screen.queryByText("YouTube playback is unavailable")).toBeNull();
  });

  it("advances to the next track when a playlist track errors after the session is ready", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();

    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onError?.({ data: 150 });
    });
    expect(fakePlayers[0]!.nextVideo).toHaveBeenCalled();
    expect(screen.queryByText("YouTube playback is unavailable")).toBeNull();
  });

  it("falls back to a plain video when the mix errors and offers Retry if the fallback fails too", async () => {
    fakePlaylist = ["abcdefghijk"];
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();

    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onError?.({ data: 150 });
    });
    expect(fakePlayers).toHaveLength(1);
    expect(fakePlayers[0]!.cueVideoById).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onError?.({ data: 150 });
    });
    expect(screen.getByRole("alert").textContent).toContain("YouTube playback is unavailable");

    const retry = screen.getByRole("button", { name: "Retry playlist" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(fakePlayers).toHaveLength(2));
    expect(fakePlayers[1]!.options.playerVars).toMatchObject({ autoplay: 1, list: "RDabcdefghijk" });
    act(() => {
      fakePlayers[1]!.events.onReady?.({});
    });
    expect(fakePlayers[1]!.playVideo).toHaveBeenCalled();
  });

  it("leaves Connecting and exposes Retry when an explicit play attempt times out", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => fakePlayers[0]!.events.onReady?.({}));
    await waitForPlaylistSession();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Play playlist" }));
    expect(screen.getByText("Connecting")).toBeTruthy();
    act(() => vi.advanceTimersByTime(12_000));

    expect(screen.getByRole("alert").textContent).toContain("YouTube playback is unavailable");
    expect((screen.getByRole("button", { name: "Retry playlist" }) as HTMLButtonElement).disabled).toBe(false);
    vi.useRealTimers();
  });

  it("keeps the session play button enabled after a failed mix and fallback for retry", async () => {
    fakePlaylist = ["abcdefghijk"];
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));

    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onError?.({ data: 150 });
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onError?.({ data: 150 });
    });

    const play = screen.getByRole("button", { name: "Retry playlist" });
    expect((play as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Repeat playlist" })).toBeTruthy();
  });

  it("renders the player stage with artwork, progress times and an enabled seek slider", async () => {
    fakeTime = 203;
    fakeDuration = 320;
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();

    act(() => {
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
    });

    const seek = screen.getByRole("slider", { name: "Seek in playlist" }) as HTMLInputElement;
    expect(seek.disabled).toBe(false);
    expect(seek.max).toBe("320");
    expect(seek.value).toBe("203");
    expect(screen.getAllByText("3:23").length).toBeGreaterThan(0);
    expect(screen.getAllByText("5:20").length).toBeGreaterThan(0);
    const artwork = document.querySelector(".vibe-music-player-art img");
    expect(artwork?.getAttribute("src")).toContain("/v1/hqdefault.jpg");
  });

  it("shows long-running YouTube streams as live instead of overflowing with multi-day times", async () => {
    fakeTime = 8_879_403;
    fakeDuration = 8_882_991;
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));

    act(() => {
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
    });

    expect(screen.getByText("Live stream")).toBeTruthy();
    expect(screen.queryByRole("slider", { name: "Seek in playlist" })).toBeNull();
    expect(screen.queryByText("2466:30:03")).toBeNull();
  });

  it("offers Play when a cued Mix fallback becomes ready without a state event", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Office");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => fakePlayers[0]!.events.onError?.({ data: 100 }));
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    act(() => fakePlayers[0]!.events.onReady?.({}));
    expect(screen.getByRole("button", { name: "Play playlist" })).toBeTruthy();
    expect(screen.queryByText("Connecting")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play playlist" }));
    expect(fakePlayers[0]!.playVideo).toHaveBeenCalled();
  });

  it("loads the picked playlist cued without autoplay and starts only from the central Play", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    expect(fakePlayers[0]!.options.playerVars).toMatchObject({ autoplay: 0 });
    await waitForPlaylistSession();
    expect(fakePlayers[0]!.playVideo).not.toHaveBeenCalled();
    expect(screen.getByText("Ready")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Play playlist" }));
    expect(fakePlayers[0]!.playVideo).not.toHaveBeenCalled();
    act(() => {
      fakePlayers[0]!.events.onReady?.({});
    });
    expect(fakePlayers[0]!.playVideo).toHaveBeenCalled();
  });

  it("enables playlist looping by default and lets the repeat control toggle it", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();
    act(() => {
      fakePlayers[0]!.events.onReady?.({});
    });

    const repeat = screen.getByRole("button", { name: "Repeat playlist" });
    expect(fakePlayers[0]!.setLoop).toHaveBeenCalledWith(true);
    expect(repeat.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(repeat);
    expect(fakePlayers[0]!.setLoop).toHaveBeenLastCalledWith(false);
    expect(repeat.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the queue on demand with track entries and jumps to a track on click", async () => {
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();
    act(() => {
      fakePlayers[0]!.events.onReady?.({});
    });

    fireEvent.click(screen.getByRole("button", { name: "Show playlist queue" }));
    expect(await screen.findByText("Track 1", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("Track 2")).toBeTruthy();
    expect(screen.getByText("Track 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Play Track 2" }));
    expect(fakePlayers[0]!.playVideoAt).toHaveBeenCalledWith(1);
  });

  it("keeps next and previous working even when YouTube hides the playlist (no login)", async () => {
    fakePlaylist = [];
    render(<PlayerHarness />);
    await openPlaylistTab();
    await startPlaylistFromPicker("Focus Beats");
    await waitFor(() => expect(fakePlayers).toHaveLength(1));
    await waitForPlaylistSession();
    act(() => {
      fakePlayers[0]!.events.onReady?.({});
      fakePlayers[0]!.events.onStateChange?.({ data: 1 });
    });

    fireEvent.click(screen.getByRole("button", { name: "Next song" }));
    expect(fakePlayers[0]!.nextVideo).toHaveBeenCalled();
    expect(fakePlayers[0]!.playVideo).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Previous song" }));
    expect(fakePlayers[0]!.previousVideo).toHaveBeenCalled();
    expect(fakePlayers[0]!.playVideo).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Show playlist queue" }));
    expect(await screen.findByText("No tracks available.", {}, { timeout: 7000 })).toBeTruthy();
  }, 8000);
});
