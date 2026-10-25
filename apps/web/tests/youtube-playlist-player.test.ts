import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createYouTubePlaylistPlayer,
  loadYouTubeIframeApi,
  parseYouTubeLink,
  YOUTUBE_IFRAME_API_URL
} from "../src/features/vibe-music/youtubePlaylistPlayer.js";

describe("parseYouTubeLink", () => {
  it("extracts a playlist id from a playlist URL", () => {
    expect(parseYouTubeLink("https://www.youtube.com/playlist?list=PLABCDEFGHIJKLMNOP")).toEqual({
      kind: "playlist",
      playlistId: "PLABCDEFGHIJKLMNOP"
    });
  });

  it("extracts a playlist id from a watch URL with a list parameter", () => {
    expect(parseYouTubeLink("https://youtube.com/watch?v=abcdefghijk&list=PL1234567890123456")).toEqual({
      kind: "playlist",
      playlistId: "PL1234567890123456"
    });
  });

  it("extracts a video id from a watch URL", () => {
    expect(parseYouTubeLink("https://www.youtube.com/watch?v=abcdefghijk")).toEqual({
      kind: "video",
      videoId: "abcdefghijk"
    });
  });

  it("extracts a video id from a youtu.be URL", () => {
    expect(parseYouTubeLink("https://youtu.be/abcdefghijk")).toEqual({ kind: "video", videoId: "abcdefghijk" });
  });

  it("extracts a video id from shorts and embed URLs", () => {
    expect(parseYouTubeLink("https://www.youtube.com/shorts/abcdefghijk")).toEqual({ kind: "video", videoId: "abcdefghijk" });
    expect(parseYouTubeLink("https://www.youtube.com/embed/abcdefghijk")).toEqual({ kind: "video", videoId: "abcdefghijk" });
  });

  it("supports shared live links and rejects non-web schemes", () => {
    expect(parseYouTubeLink("https://youtube.com/live/abcdefghijk")).toEqual({ kind: "video", videoId: "abcdefghijk" });
    expect(parseYouTubeLink("javascript://youtube.com/watch?v=abcdefghijk")).toBeNull();
  });

  it("rejects non-YouTube hosts, malformed URLs and bad ids", () => {
    expect(parseYouTubeLink("https://example.com/watch?v=abcdefghijk")).toBeNull();
    expect(parseYouTubeLink("not a url")).toBeNull();
    expect(parseYouTubeLink("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(parseYouTubeLink("https://www.youtube.com/")).toBeNull();
  });
});

describe("loadYouTubeIframeApi", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves immediately when the API is already present", async () => {
    const { loadYouTubeIframeApi: load } = await import("../src/features/vibe-music/youtubePlaylistPlayer.js");
    const yt = { Player: class {} };
    vi.stubGlobal("YT", yt);
    await expect(load()).resolves.toBe(yt);
  });

  it("injects the API script and resolves on onYouTubeIframeAPIReady", async () => {
    const { loadYouTubeIframeApi: load } = await import("../src/features/vibe-music/youtubePlaylistPlayer.js");
    const yt = { Player: class {} };
    const loader = load();
    const script = document.querySelector(`script[src="${YOUTUBE_IFRAME_API_URL}"]`);
    expect(script).toBeTruthy();
    const ready = (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady;
    expect(typeof ready).toBe("function");
    vi.stubGlobal("YT", yt);
    ready?.();
    await expect(loader).resolves.toBe(yt);
  });

  it("rejects when the API script fails to load", async () => {
    const { loadYouTubeIframeApi: load } = await import("../src/features/vibe-music/youtubePlaylistPlayer.js");
    const loader = load();
    const scripts = document.querySelectorAll<HTMLScriptElement>(`script[src="${YOUTUBE_IFRAME_API_URL}"]`);
    const script = scripts[scripts.length - 1]!;
    script.onerror?.(new Event("error"));
    await expect(loader).rejects.toThrow("Failed to load the YouTube IFrame API");
  });
});

describe("createYouTubePlaylistPlayer", () => {
  const players: FakePlayer[] = [];
  class FakePlayer {
    options: Record<string, unknown>;
    destroy: ReturnType<typeof vi.fn>;
    playVideo = vi.fn();
    pauseVideo = vi.fn();
    loadVideoById = vi.fn();
    cueVideoById = vi.fn();
    nextVideo = vi.fn();
    previousVideo = vi.fn();
    setVolume = vi.fn();
    setLoop = vi.fn();
    seekTo = vi.fn();
    playVideoAt = vi.fn();
    constructor(_elementId: string, options: Record<string, unknown>) {
      this.options = options;
      this.destroy = vi.fn();
      players.push(this);
    }
    getVideoData() {
      return { title: "Test Song" };
    }
    getPlaylist() {
      return ["v1", "v2", "v3"];
    }
    getPlaylistIndex() {
      return 0;
    }
    getCurrentTime() {
      return 0;
    }
    getDuration() {
      return 0;
    }
    getLoop() {
      return true;
    }
  }
  beforeAll(() => {
    vi.stubGlobal("YT", { Player: FakePlayer });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    players.length = 0;
  });

  it("creates a playlist-mode player with the playlist id and wires events", async () => {
    const container = document.createElement("div");
    container.id = "stage";
    const onStateChange = vi.fn();
    const onError = vi.fn();
    const player = await createYouTubePlaylistPlayer(container, { kind: "playlist", playlistId: "PL1234567890123456" }, {
      onStateChange,
      onError
    });
    expect(players).toHaveLength(1);
    const options = players[0]!.options;
    expect(options.videoId).toBeUndefined();
    expect(options.playerVars).toMatchObject({
      listType: "playlist",
      list: "PL1234567890123456",
      autoplay: 0,
      controls: 0,
      origin: window.location.origin
    });
    const events = options.events as Record<string, (event: { data?: number }) => void>;
    events.onStateChange?.({ data: 1 });
    expect(onStateChange).toHaveBeenCalledWith("playing");
    events.onError?.({ data: 150 });
    expect(onError).toHaveBeenCalledWith(150);
    expect(player.getCurrent()).toEqual({ title: "Test Song", index: 1, total: 3 });
    player.destroy();
    expect(players[0]!.destroy).toHaveBeenCalled();
  });

  it("creates a video-mode player inside the video's YouTube Mix so next/previous work", async () => {
    const container = document.createElement("div");
    container.id = "stage";
    await createYouTubePlaylistPlayer(container, { kind: "video", videoId: "abcdefghijk" }, {});
    expect(players[0]!.options.videoId).toBe("abcdefghijk");
    expect(players[0]!.options.playerVars).toMatchObject({
      listType: "playlist",
      list: "RDabcdefghijk"
    });
  });

  it("falls back to a plain single-video player when the mix fails to load", async () => {
    const container = document.createElement("div");
    container.id = "stage";
    const onError = vi.fn();
    const onMixFallback = vi.fn();
    const player = await createYouTubePlaylistPlayer(
      container,
      { kind: "video", videoId: "abcdefghijk" },
      { onError, onMixFallback }
    );
    expect(players).toHaveLength(1);
    const mixEvents = players[0]!.options.events as Record<string, (event: { data?: number }) => void>;
    player.setVolume(0.5);
    mixEvents.onError?.({ data: 2 });
    expect(onMixFallback).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(players).toHaveLength(1);
    expect(players[0]!.destroy).not.toHaveBeenCalled();
    mixEvents.onReady?.({});
    expect(players[0]!.cueVideoById).toHaveBeenCalledWith({ videoId: "abcdefghijk", startSeconds: 0 });
    mixEvents.onError?.({ data: 150 });
    expect(onError).toHaveBeenCalledWith(150);
    expect(player.getCurrent()).toEqual({ title: "Test Song", index: 1, total: 1 });
    expect(player.getPlaylistIds()).toEqual([]);
  });

  it.each([true, false])("preserves intent, volume and position on the same Mix iframe (play=%s)", async (playing) => {
    const onStateChange = vi.fn();
    const player = await createYouTubePlaylistPlayer(document.createElement("div"),
      { kind: "video", videoId: "abcdefghijk" }, { onStateChange }, { autoplay: !playing, startSeconds: 203, startVideoId: "12345678901" });
    const active = players[0]!;
    const events = active.options.events as Record<string, (event: { data?: number }) => void>;
    events.onReady?.({});
    if (playing) player.play(); else player.pause();
    player.setVolume(0.61);
    player.setLoop(false);
    events.onError?.({ data: 150 });
    expect(players).toHaveLength(1);
    expect(playing ? active.loadVideoById : active.cueVideoById).toHaveBeenCalledWith({ videoId: "12345678901", startSeconds: 203 });
    expect(playing ? active.cueVideoById : active.loadVideoById).not.toHaveBeenCalled();
    expect(active.setVolume).toHaveBeenLastCalledWith(61);
    expect(active.setLoop).toHaveBeenLastCalledWith(false);
    events.onStateChange?.({ data: playing ? 1 : 5 });
    expect(onStateChange).toHaveBeenCalledWith(playing ? "playing" : "cued");
    active.getCurrentTime = () => 207;
    expect(player.getCurrentTime()).toBe(207);
    player.destroy();
  });

  it("ignores late events after the iframe is destroyed", async () => {
    const onStateChange = vi.fn(), onError = vi.fn();
    const player = await createYouTubePlaylistPlayer(document.createElement("div"),
      { kind: "video", videoId: "abcdefghijk" }, { onStateChange, onError });
    const events = players[0]!.options.events as Record<string, (event: { data?: number }) => void>;
    events.onError?.({ data: 150 });
    player.destroy();
    events.onStateChange?.({ data: 1 });
    events.onError?.({ data: 150 });
    expect(onStateChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("passes autoplay and resume position into a restored playlist player", async () => {
    const container = document.createElement("div");
    container.id = "stage";
    await createYouTubePlaylistPlayer(
      container,
      { kind: "playlist", playlistId: "PL1234567890123456" },
      {},
      { autoplay: true, startIndex: 2, startSeconds: 203 }
    );
    expect(players[0]!.options.playerVars).toMatchObject({ autoplay: 1, index: 2, start: 203 });
  });

  it("queues player controls until YouTube reports the iframe ready", async () => {
    const container = document.createElement("div");
    container.id = "stage";
    const player = await createYouTubePlaylistPlayer(
      container,
      { kind: "playlist", playlistId: "PL1234567890123456" },
      {}
    );

    player.setVolume(0.42);
    player.setLoop(true);
    player.next();
    player.seekTo(37);
    player.play();
    expect(players[0]!.setVolume).not.toHaveBeenCalled();
    expect(players[0]!.nextVideo).not.toHaveBeenCalled();
    expect(players[0]!.playVideo).not.toHaveBeenCalled();

    const events = players[0]!.options.events as Record<string, (event: { data?: number }) => void>;
    events.onReady?.({});
    expect(players[0]!.setVolume).toHaveBeenCalledWith(42);
    expect(players[0]!.setLoop).toHaveBeenCalledWith(true);
    expect(players[0]!.nextVideo).toHaveBeenCalledTimes(1);
    expect(players[0]!.seekTo).toHaveBeenCalledWith(37, true);
    expect(players[0]!.playVideo).toHaveBeenCalledTimes(1);
  });
});
