export const YOUTUBE_IFRAME_API_URL = "https://www.youtube.com/iframe_api";
export const YOUTUBE_IFRAME_API_TIMEOUT_MS = 12_000;

export type YouTubeLinkTarget =
  | { kind: "playlist"; playlistId: string }
  | { kind: "video"; videoId: string };

export type YouTubePlayerState = "unstarted" | "playing" | "paused" | "ended" | "buffering" | "cued" | "unknown";

export type YouTubePlayerCallbacks = {
  onReady?: () => void;
  onStateChange?: (state: YouTubePlayerState) => void;
  onError?: (code: number) => void;
};

export type YouTubePlaylistPlayerOptions = {
  autoplay?: boolean;
  startIndex?: number;
  startSeconds?: number;
};

export type YouTubePlaylistPlayer = {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  setVolume(volume: number): void;
  getCurrent(): { title: string; index: number; total: number };
  getVideoId(): string | null;
  getPlaylistIds(): string[];
  getCurrentTime(): number;
  getDuration(): number;
  setLoop(enabled: boolean): void;
  getLoop(): boolean;
  seekTo(seconds: number): void;
  playVideoAt(index: number): void;
  destroy(): void;
};

type YouTubeIFramePlayerLike = {
  playVideo(): void;
  pauseVideo(): void;
  nextVideo(): void;
  previousVideo(): void;
  setVolume(percent: number): void;
  getVideoData(): { title?: string; video_id?: string };
  getPlaylist(): string[];
  getPlaylistIndex(): number;
  getCurrentTime(): number;
  getDuration(): number;
  setLoop(loopPlaylists: boolean): void;
  getLoop(): boolean;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideoAt(index: number): void;
  destroy(): void;
};

type YouTubeNamespace = {
  Player: new (
    elementId: string,
    options: {
      height: number;
      width: number;
      videoId?: string;
      playerVars?: Record<string, string | number | boolean>;
      events?: Record<string, (event: { data?: number }) => void>;
    }
  ) => YouTubeIFramePlayerLike;
};

let apiPromise: Promise<YouTubeNamespace> | null = null;

export function loadYouTubeIframeApi(): Promise<YouTubeNamespace> {
  if (apiPromise) return apiPromise;
  if (typeof window === "undefined") {
    return Promise.reject(new Error("The YouTube IFrame API requires a browser window."));
  }
  apiPromise = new Promise<YouTubeNamespace>((resolve, reject) => {
    const current = window as unknown as { YT?: YouTubeNamespace };
    if (current.YT?.Player) {
      resolve(current.YT);
      return;
    }
    const previousCallback = (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady;
    (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady = () => {
      const yt = (window as unknown as { YT?: YouTubeNamespace }).YT;
      (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady = previousCallback;
      if (yt?.Player) {
        resolve(yt);
      } else {
        apiPromise = null;
        reject(new Error("The YouTube IFrame API loaded without a player constructor."));
      }
    };
    const script = document.createElement("script");
    script.src = YOUTUBE_IFRAME_API_URL;
    script.async = true;
    script.onerror = () => {
      (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady = previousCallback;
      apiPromise = null;
      reject(new Error("Failed to load the YouTube IFrame API."));
    };
    document.head.appendChild(script);
    window.setTimeout(() => {
      const yt = (window as unknown as { YT?: YouTubeNamespace }).YT;
      if (!yt?.Player) {
        apiPromise = null;
        reject(new Error("Timed out waiting for the YouTube IFrame API."));
      }
    }, YOUTUBE_IFRAME_API_TIMEOUT_MS);
  });
  return apiPromise;
}

export function parseYouTubeLink(url: string): YouTubeLinkTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "youtu.be") return null;
  const list = parsed.searchParams.get("list");
  if (list && /^[A-Za-z0-9_-]{8,}$/.test(list)) return { kind: "playlist", playlistId: list };
  if (host === "youtu.be") {
    const videoId = parsed.pathname.slice(1).split("/")[0] ?? "";
    if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { kind: "video", videoId };
    return null;
  }
  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  if (pathSegments[0] === "shorts" || pathSegments[0] === "embed" || pathSegments[0] === "v") {
    const videoId = pathSegments[1] ?? "";
    if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { kind: "video", videoId };
    return null;
  }
  const videoId = parsed.searchParams.get("v");
  if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) return { kind: "video", videoId };
  return null;
}

function stateFromCode(code: number): YouTubePlayerState {
  switch (code) {
    case -1: return "unstarted";
    case 0: return "ended";
    case 1: return "playing";
    case 2: return "paused";
    case 3: return "buffering";
    case 5: return "cued";
    default: return "unknown";
  }
}

export async function createYouTubePlaylistPlayer(
  container: HTMLElement,
  target: YouTubeLinkTarget,
  callbacks: YouTubePlayerCallbacks,
  options: YouTubePlaylistPlayerOptions = {}
): Promise<YouTubePlaylistPlayer> {
  const yt = await loadYouTubeIframeApi();
  let player: YouTubeIFramePlayerLike | null = null;
  let lastTitle = "";
  let lastTotal = 1;
  let lastIndex = 1;
  let ready = false;
  let destroyed = false;
  let playlistSyncRetryTimer: number | null = null;
  let pendingPlayback: "play" | "pause" | null = null;
  let pendingOperations: Array<(activePlayer: YouTubeIFramePlayerLike) => void> = [];

  const playerVars: Record<string, string | number | boolean> = {
    autoplay: options.autoplay ? 1 : 0,
    controls: 0,
    disablekb: 1,
    fs: 0,
    playsinline: 1,
    rel: 0,
    iv_load_policy: 3,
    modestbranding: 1,
    origin: window.location.origin
  };
  if (target.kind === "playlist") {
    playerVars.listType = "playlist";
    playerVars.list = target.playlistId;
    if (Number.isInteger(options.startIndex) && (options.startIndex ?? 0) >= 0) {
      playerVars.index = options.startIndex ?? 0;
    }
  }
  if (Number.isFinite(options.startSeconds) && (options.startSeconds ?? 0) > 0) {
    playerVars.start = Math.floor(options.startSeconds ?? 0);
  }

  const runSafely = (operation: (activePlayer: YouTubeIFramePlayerLike) => void) => {
    if (!player || destroyed) return;
    try {
      operation(player);
    } catch {
      // The iframe can transiently reject commands while its API is hydrating.
    }
  };

  const runWhenReady = (operation: (activePlayer: YouTubeIFramePlayerLike) => void) => {
    if (destroyed) return;
    if (ready) {
      runSafely(operation);
      return;
    }
    pendingOperations.push(operation);
  };

  const readSafely = <T,>(reader: (activePlayer: YouTubeIFramePlayerLike) => T, fallback: T): T => {
    if (!player || destroyed) return fallback;
    try {
      return reader(player);
    } catch {
      return fallback;
    }
  };

  const syncNowPlaying = () => {
    if (!player) return;
    const data = readSafely((activePlayer) => activePlayer.getVideoData(), {});
    if (data?.title) lastTitle = data.title;
    const playlist = readSafely((activePlayer) => activePlayer.getPlaylist(), []);
    if (Array.isArray(playlist) && playlist.length > 0) {
      lastTotal = playlist.length;
      const playlistIndex = readSafely((activePlayer) => activePlayer.getPlaylistIndex(), 0);
      lastIndex = Math.min(Math.max(playlistIndex + 1, 1), lastTotal);
    }
  };

  const startPlaylistSyncRetry = () => {
    if (target.kind !== "playlist" || playlistSyncRetryTimer !== null) return;
    let attempts = 0;
    playlistSyncRetryTimer = window.setInterval(() => {
      attempts += 1;
      syncNowPlaying();
      if (lastTotal > 1 || attempts >= 10) {
        if (playlistSyncRetryTimer !== null) window.clearInterval(playlistSyncRetryTimer);
        playlistSyncRetryTimer = null;
      }
    }, 1000);
  };

  player = new yt.Player(container.id, {
    height: 1,
    width: 1,
    videoId: target.kind === "video" ? target.videoId : undefined,
    playerVars,
    events: {
      onReady: () => {
        if (destroyed || !player) return;
        ready = true;
        syncNowPlaying();
        startPlaylistSyncRetry();
        const operations = pendingOperations;
        pendingOperations = [];
        operations.forEach((operation) => runSafely(operation));
        const playback = pendingPlayback;
        pendingPlayback = null;
        if (playback === "play") runSafely((activePlayer) => activePlayer.playVideo());
        if (playback === "pause") runSafely((activePlayer) => activePlayer.pauseVideo());
        callbacks.onReady?.();
      },
      onStateChange: (event) => {
        syncNowPlaying();
        callbacks.onStateChange?.(stateFromCode(event.data ?? -1));
      },
      onError: (event) => {
        callbacks.onError?.(event.data ?? 0);
      }
    }
  });

  return {
    play() {
      if (ready) runSafely((activePlayer) => activePlayer.playVideo());
      else pendingPlayback = "play";
    },
    pause() {
      if (ready) runSafely((activePlayer) => activePlayer.pauseVideo());
      else pendingPlayback = "pause";
    },
    next() {
      runWhenReady((activePlayer) => activePlayer.nextVideo());
    },
    previous() {
      runWhenReady((activePlayer) => activePlayer.previousVideo());
    },
    setVolume(volume: number) {
      const percent = Math.round(Math.min(1, Math.max(0, volume)) * 100);
      runWhenReady((activePlayer) => activePlayer.setVolume(percent));
    },
    getCurrent() {
      syncNowPlaying();
      return { title: lastTitle, index: lastIndex, total: lastTotal };
    },
    getVideoId() {
      return readSafely((activePlayer) => activePlayer.getVideoData().video_id ?? null, null);
    },
    getPlaylistIds() {
      return readSafely((activePlayer) => activePlayer.getPlaylist(), []);
    },
    getCurrentTime() {
      return readSafely((activePlayer) => activePlayer.getCurrentTime(), 0);
    },
    getDuration() {
      return readSafely((activePlayer) => activePlayer.getDuration(), 0);
    },
    setLoop(enabled) {
      runWhenReady((activePlayer) => activePlayer.setLoop(enabled));
    },
    getLoop() {
      return readSafely((activePlayer) => activePlayer.getLoop(), false);
    },
    seekTo(seconds) {
      const targetSeconds = Math.max(0, seconds);
      runWhenReady((activePlayer) => activePlayer.seekTo(targetSeconds, true));
    },
    playVideoAt(index) {
      runWhenReady((activePlayer) => activePlayer.playVideoAt(index));
    },
    destroy() {
      const activePlayer = player;
      destroyed = true;
      ready = false;
      pendingPlayback = null;
      pendingOperations = [];
      if (playlistSyncRetryTimer !== null) window.clearInterval(playlistSyncRetryTimer);
      playlistSyncRetryTimer = null;
      try {
        activePlayer?.destroy();
      } catch {
        // The player may already have been destroyed.
      }
      player = null;
    }
  };
}
