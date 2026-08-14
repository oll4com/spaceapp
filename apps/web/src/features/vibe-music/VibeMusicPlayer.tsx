import { ChevronLeft, ChevronRight, ExternalLink, ListFilter, Music2, Pause, Play, Radio, RefreshCw, RotateCcw, Volume2, X, Youtube } from "../ui-theme/app-icons.js";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from "react";
import type { UserLink } from "@space/contracts";
import { api } from "../../api.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { USER_LINKS_UPDATED_EVENT } from "../user-links/UserLinks.js";
import { createYouTubePlaylistPlayer, parseYouTubeLink, type YouTubePlaylistPlayer } from "./youtubePlaylistPlayer.js";
import "./vibe-music.css";

export const CODE_RADIO_PRIMARY_STREAM_URL = "https://coderadio-admin-v2.freecodecamp.org/listen/coderadio/radio.mp3";
export const CODE_RADIO_FALLBACK_STREAM_URL = "https://coderadio-admin-v2.freecodecamp.org/listen/coderadio/low.mp3";
export const CODE_RADIO_METADATA_URL = "https://coderadio-admin-v2.freecodecamp.org/api/nowplaying_static/coderadio.json";
export const CODE_RADIO_ATTRIBUTION_URL = "https://coderadio.freecodecamp.org/";
export const VIBE_MUSIC_VOLUME_STORAGE_KEY = "space.vibeMusic.volume";
export const VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY = "space.vibeMusic.playlistLinkId";
export const VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY = "space.vibeMusic.playlistProgress";
export const VIBE_MUSIC_PANEL_ID = "vibe-music-player";
export const VIBE_MUSIC_YOUTUBE_STAGE_ID = "vibe-music-youtube-stage";

const DEFAULT_VOLUME = 0.35;
const MUSIC_LIBRARY_LINKS_PAGE_SIZE = 100;
const METADATA_POLL_INTERVAL_MS = 30_000;
const METADATA_RESPONSE_LIMIT_BYTES = 64 * 1024;
const CONNECTION_TIMEOUT_MS = 12_000;
const VIEWPORT_MARGIN_PX = 8;
const ANCHOR_GAP_PX = 8;
const FALLBACK_PANEL_WIDTH_PX = 320;
const FALLBACK_PANEL_HEIGHT_PX = 290;
const MAX_ARTIST_CODE_POINTS = 64;
const MAX_TITLE_CODE_POINTS = 112;
const MAX_TRACK_CODE_POINTS = 160;
const STREAM_URLS = [CODE_RADIO_PRIMARY_STREAM_URL, CODE_RADIO_FALLBACK_STREAM_URL] as const;
const YOUTUBE_THUMBNAIL_BASE_URL = "https://i.ytimg.com/vi";
const PLAYLIST_PROGRESS_POLL_INTERVAL_MS = 1000;
const MAX_RESUMABLE_PLAYLIST_SECONDS = 24 * 60 * 60;
const MAX_STORED_PLAYLIST_INDEX = 10_000;

type PlaybackStatus = "idle" | "connecting" | "playing" | "unavailable";

type PlaylistPlaybackStatus = "idle" | "connecting" | "playing" | "paused" | "unavailable" | "unsupported";

type MusicSource = "radio" | "playlist";

type VibeMusicPlayerProps = {
  mobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  persistVolume?: boolean;
  roomTheme: "graphite" | "forest" | "copper" | "steel" | "contrast";
  triggerRef: RefObject<HTMLButtonElement | null>;
};

type PanelPosition = {
  left: number;
  top: number;
  ready: boolean;
};

type AttemptFailure = {
  attemptId: number;
  generation: number;
  streamIndex: 0 | 1;
};

type QueueTrack = {
  videoId: string;
  title: string;
};

type StoredPlaylistProgress = {
  linkId: string;
  trackIndex: number;
  seconds: number;
  videoId: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function normalizeMetadataText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return truncateCodePoints(normalized, limit);
}

export function parseCodeRadioMetadata(payload: unknown): string | null {
  if (!isPlainObject(payload) || !isPlainObject(payload.now_playing) || !isPlainObject(payload.now_playing.song)) return null;
  const song = payload.now_playing.song;
  const artist = normalizeMetadataText(song.artist, MAX_ARTIST_CODE_POINTS);
  const title = normalizeMetadataText(song.title, MAX_TITLE_CODE_POINTS);
  const combined = artist && title ? `${artist} — ${title}` : title ?? artist;
  if (combined) return truncateCodePoints(combined, MAX_TRACK_CODE_POINTS);
  return normalizeMetadataText(song.text, MAX_TRACK_CODE_POINTS);
}

function readStoredVolume(shouldPersist: boolean): number {
  if (!shouldPersist || typeof window === "undefined") return DEFAULT_VOLUME;
  try {
    const stored = getSpaceRuntime().platform.localStorage.getItem(VIBE_MUSIC_VOLUME_STORAGE_KEY);
    if (stored === null || stored.trim() === "") return DEFAULT_VOLUME;
    const value = Number(stored);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function persistVolume(volume: number, shouldPersist: boolean) {
  if (!shouldPersist) return;
  try {
    getSpaceRuntime().platform.localStorage.setItem(VIBE_MUSIC_VOLUME_STORAGE_KEY, String(volume));
  } catch {
    // Volume persistence is best effort only.
  }
}

function readStoredPlaylistLinkId(shouldPersist: boolean): string | null {
  if (!shouldPersist || typeof window === "undefined") return null;
  try {
    const stored = getSpaceRuntime().platform.localStorage.getItem(VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY);
    if (stored === null || stored.trim() === "") return null;
    return stored.trim();
  } catch {
    return null;
  }
}

function persistPlaylistLinkId(linkId: string, shouldPersist: boolean) {
  if (!shouldPersist) return;
  try {
    getSpaceRuntime().platform.localStorage.setItem(VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY, linkId);
  } catch {
    // Playlist selection persistence is best effort only.
  }
}

function readStoredPlaylistProgress(shouldPersist: boolean): StoredPlaylistProgress | null {
  if (!shouldPersist || typeof window === "undefined") return null;
  try {
    const raw = getSpaceRuntime().platform.localStorage.getItem(VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as unknown;
    if (!isPlainObject(stored)) return null;
    const linkId = typeof stored.linkId === "string" ? stored.linkId.trim() : "";
    const trackIndex = stored.trackIndex;
    const seconds = stored.seconds;
    const videoId = typeof stored.videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(stored.videoId)
      ? stored.videoId
      : null;
    if (
      !linkId ||
      typeof trackIndex !== "number" ||
      !Number.isInteger(trackIndex) ||
      trackIndex < 0 ||
      trackIndex > MAX_STORED_PLAYLIST_INDEX ||
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > MAX_RESUMABLE_PLAYLIST_SECONDS
    ) return null;
    return { linkId, trackIndex, seconds, videoId };
  } catch {
    return null;
  }
}

function persistPlaylistProgress(progress: StoredPlaylistProgress, shouldPersist: boolean) {
  if (!shouldPersist) return;
  try {
    getSpaceRuntime().platform.localStorage.setItem(VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Playlist progress persistence is best effort only.
  }
}

function isSeekablePlaylistDuration(duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 && duration <= MAX_RESUMABLE_PLAYLIST_SECONDS;
}

async function readMetadataPayload(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("Code Radio metadata request failed.");
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > METADATA_RESPONSE_LIMIT_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The size validation remains authoritative if stream cancellation fails.
    }
    throw new Error("Code Radio metadata response was too large.");
  }

  if (!response.body || typeof TextDecoder === "undefined") {
    throw new Error("Code Radio metadata streaming was unavailable.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let finished = false;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        body += decoder.decode();
        finished = true;
        break;
      }
      if (!value) continue;
      byteLength += value.byteLength;
      if (byteLength > METADATA_RESPONSE_LIMIT_BYTES) {
        throw new Error("Code Radio metadata response was too large.");
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original validation or stream error.
      }
    }
    reader.releaseLock();
  }
  return JSON.parse(body) as unknown;
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  return Array.from(
    container?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    ) ?? []
  )
    .filter((element) => element.getAttribute("aria-hidden") !== "true")
    .sort((left, right) => {
      if (left === right) return 0;
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
}

function statusLabel(status: PlaybackStatus): string {
  if (status === "connecting") return "Connecting";
  if (status === "playing") return "Playing";
  if (status === "unavailable") return "Unavailable";
  return "Paused";
}

function playlistStatusLabel(status: PlaylistPlaybackStatus): string {
  if (status === "connecting") return "Connecting";
  if (status === "playing") return "Playing";
  if (status === "paused") return "Paused";
  if (status === "unavailable") return "Unavailable";
  if (status === "unsupported") return "Unsupported";
  return "Stopped";
}

function formatPlaybackTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0:00";
  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}` : `${minutes}:${paddedSeconds}`;
}

export function VibeMusicPlayer({ mobile, open, onOpenChange, persistVolume: shouldPersistVolume = true, roomTheme, triggerRef }: VibeMusicPlayerProps) {
  const runtime = getSpaceRuntime();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const primaryControlRef = useRef<HTMLButtonElement | null>(null);
  const youtubeStageRef = useRef<HTMLDivElement | null>(null);
  const youtubePlayerRef = useRef<YouTubePlaylistPlayer | null>(null);
  const activePlaylistLinkIdRef = useRef<string | null>(null);
  const storedPlaylistProgressRef = useRef<StoredPlaylistProgress | null>(readStoredPlaylistProgress(shouldPersistVolume));
  const loopEnabledRef = useRef(true);
  const youtubeGenerationRef = useRef(0);
  const generationRef = useRef(0);
  const attemptIdRef = useRef(0);
  const activeAttemptCleanupRef = useRef<(() => void) | null>(null);
  const wantsPlaybackRef = useRef(false);
  const connectAttemptRef = useRef<(streamIndex: 0 | 1, generation: number) => void>(() => undefined);
  const handleAttemptFailureRef = useRef<(failure: AttemptFailure) => void>(() => undefined);
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [track, setTrack] = useState("Track details appear after playback starts");
  const [volume, setVolume] = useState(() => readStoredVolume(shouldPersistVolume));
  const [position, setPosition] = useState<PanelPosition>({ left: VIEWPORT_MARGIN_PX, top: VIEWPORT_MARGIN_PX, ready: false });
  const [source, setSource] = useState<MusicSource>("radio");
  const [playlistStatus, setPlaylistStatus] = useState<PlaylistPlaybackStatus>("idle");
  const [playlistTrack, setPlaylistTrack] = useState("Select a playlist to start listening");
  const [playlistPosition, setPlaylistPosition] = useState<{ index: number; total: number } | null>(null);
  const [hasPlaylistSession, setHasPlaylistSession] = useState(false);
  const [musicLinks, setMusicLinks] = useState<UserLink[]>([]);
  const [musicLinksLoading, setMusicLinksLoading] = useState(false);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(() => readStoredPlaylistLinkId(shouldPersistVolume));
  const [playlistTime, setPlaylistTime] = useState(0);
  const [playlistDuration, setPlaylistDuration] = useState(0);
  const [playlistIsLive, setPlaylistIsLive] = useState(false);
  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueTracks, setQueueTracks] = useState<QueueTrack[] | null>(null);
  const [playlistEnded, setPlaylistEnded] = useState(false);

  const disposeActiveAttempt = useCallback(() => {
    const cleanup = activeAttemptCleanupRef.current;
    activeAttemptCleanupRef.current = null;
    cleanup?.();
  }, []);

  const clearAudioSource = useCallback(() => {
    disposeActiveAttempt();
    const audio = audioRef.current;
    if (!audio?.hasAttribute("src")) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }, [disposeActiveAttempt]);

  const disconnect = useCallback(() => {
    wantsPlaybackRef.current = false;
    generationRef.current += 1;
    clearAudioSource();
    setStatus("idle");
  }, [clearAudioSource]);

  const connectAttempt = useCallback(async (streamIndex: 0 | 1, generation: number) => {
    const audio = audioRef.current;
    if (!audio || !wantsPlaybackRef.current || generation !== generationRef.current) return;

    disposeActiveAttempt();
    const attemptId = ++attemptIdRef.current;
    const streamUrl = runtime.platform.resolveExternalResource(STREAM_URLS[streamIndex]);
    if (!streamUrl) {
      wantsPlaybackRef.current = false;
      generationRef.current += 1;
      setStatus("unavailable");
      setTrack(runtime.kind === "demo" ? DEMO_LOCAL_REPLY : "Track details unavailable");
      return;
    }
    audio.volume = volume;
    audio.src = streamUrl;

    const fail = () => handleAttemptFailureRef.current({ attemptId, generation, streamIndex });
    const isCurrentAttempt = () => (
      wantsPlaybackRef.current &&
      generation === generationRef.current &&
      attemptId === attemptIdRef.current
    );
    let connectionTimer: number | null = null;
    const clearConnectionTimer = () => {
      if (connectionTimer !== null) window.clearTimeout(connectionTimer);
      connectionTimer = null;
    };
    const armConnectionTimer = () => {
      clearConnectionTimer();
      connectionTimer = window.setTimeout(fail, CONNECTION_TIMEOUT_MS);
    };
    const handlePlaying = () => {
      if (!isCurrentAttempt()) return;
      clearConnectionTimer();
      setStatus("playing");
    };
    const handleBuffering = () => {
      if (!isCurrentAttempt()) return;
      setStatus("connecting");
      armConnectionTimer();
    };
    const handleNativePause = () => {
      if (!isCurrentAttempt() || !audio.paused) return;
      disconnect();
    };
    audio.addEventListener("error", fail, { once: true });
    audio.addEventListener("ended", fail, { once: true });
    audio.addEventListener("playing", handlePlaying);
    audio.addEventListener("waiting", handleBuffering);
    audio.addEventListener("stalled", handleBuffering);
    audio.addEventListener("pause", handleNativePause);
    armConnectionTimer();
    activeAttemptCleanupRef.current = () => {
      clearConnectionTimer();
      audio.removeEventListener("error", fail);
      audio.removeEventListener("ended", fail);
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("waiting", handleBuffering);
      audio.removeEventListener("stalled", handleBuffering);
      audio.removeEventListener("pause", handleNativePause);
    };

    audio.load();
    try {
      await audio.play();
      if (!wantsPlaybackRef.current || generation !== generationRef.current || attemptId !== attemptIdRef.current) return;
      handlePlaying();
    } catch {
      fail();
    }
  }, [disconnect, disposeActiveAttempt, runtime, volume]);
  connectAttemptRef.current = (streamIndex, generation) => {
    void connectAttempt(streamIndex, generation);
  };

  const handleAttemptFailure = useCallback(({ attemptId, generation, streamIndex }: AttemptFailure) => {
    if (
      !wantsPlaybackRef.current ||
      generation !== generationRef.current ||
      attemptId !== attemptIdRef.current
    ) return;
    disposeActiveAttempt();
    if (streamIndex === 0) {
      setStatus("connecting");
      connectAttemptRef.current(1, generation);
      return;
    }
    wantsPlaybackRef.current = false;
    generationRef.current += 1;
    clearAudioSource();
    setStatus("unavailable");
  }, [clearAudioSource, disposeActiveAttempt]);
  handleAttemptFailureRef.current = handleAttemptFailure;

  const startPlayback = useCallback(() => {
    wantsPlaybackRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setStatus("connecting");
    connectAttemptRef.current(0, generation);
  }, []);

  const syncPlaylistTiming = useCallback((player: YouTubePlaylistPlayer) => {
    const rawTime = player.getCurrentTime();
    const rawDuration = player.getDuration();
    const seekable = isSeekablePlaylistDuration(rawDuration);
    setPlaylistIsLive(
      (Number.isFinite(rawDuration) && rawDuration > MAX_RESUMABLE_PLAYLIST_SECONDS) ||
      (Number.isFinite(rawTime) && rawTime > MAX_RESUMABLE_PLAYLIST_SECONDS)
    );
    setPlaylistTime(seekable && Number.isFinite(rawTime) ? Math.min(Math.max(0, rawTime), rawDuration) : 0);
    setPlaylistDuration(seekable ? rawDuration : 0);
  }, []);

  const persistCurrentPlaylistProgress = useCallback((player: YouTubePlaylistPlayer | null) => {
    const linkId = activePlaylistLinkIdRef.current;
    if (!player || !linkId) return;
    const current = player.getCurrent();
    const duration = player.getDuration();
    const rawSeconds = player.getCurrentTime();
    const seconds = isSeekablePlaylistDuration(duration) && Number.isFinite(rawSeconds)
      ? Math.min(Math.max(0, rawSeconds), duration)
      : 0;
    const progress: StoredPlaylistProgress = {
      linkId,
      trackIndex: Math.min(Math.max(0, current.index - 1), MAX_STORED_PLAYLIST_INDEX),
      seconds,
      videoId: player.getVideoId()
    };
    storedPlaylistProgressRef.current = progress;
    persistPlaylistProgress(progress, shouldPersistVolume);
  }, [shouldPersistVolume]);

  const stopPlaylist = useCallback(() => {
    persistCurrentPlaylistProgress(youtubePlayerRef.current);
    youtubeGenerationRef.current += 1;
    youtubePlayerRef.current?.destroy();
    youtubePlayerRef.current = null;
    setHasPlaylistSession(false);
    setPlaylistStatus("idle");
    setPlaylistTrack("Select a playlist to start listening");
    setPlaylistPosition(null);
    setPlaylistTime(0);
    setPlaylistDuration(0);
    setPlaylistIsLive(false);
    setCurrentVideoId(null);
    loopEnabledRef.current = true;
    setLoopEnabled(true);
    setQueueOpen(false);
    setQueueTracks(null);
    setPlaylistEnded(false);
  }, [persistCurrentPlaylistProgress]);

  const startPlaylist = useCallback((link: UserLink, playImmediately = false) => {
    const target = parseYouTubeLink(link.url);
    persistCurrentPlaylistProgress(youtubePlayerRef.current);
    setSelectedLinkId(link.id);
    persistPlaylistLinkId(link.id, shouldPersistVolume);
    activePlaylistLinkIdRef.current = link.id;
    youtubeGenerationRef.current += 1;
    youtubePlayerRef.current?.destroy();
    youtubePlayerRef.current = null;
    setHasPlaylistSession(false);
    setPlaylistTime(0);
    setPlaylistDuration(0);
    setPlaylistIsLive(false);
    setCurrentVideoId(null);
    setQueueTracks(null);
    setPlaylistEnded(false);
    if (!target) {
      setPlaylistStatus("unsupported");
      setPlaylistTrack("This link is not a YouTube playlist");
      setPlaylistPosition(null);
      return;
    }
    const stage = youtubeStageRef.current;
    if (!stage) return;
    const generation = youtubeGenerationRef.current;
    const storedProgress = storedPlaylistProgressRef.current?.linkId === link.id
      ? storedPlaylistProgressRef.current
      : null;
    loopEnabledRef.current = true;
    setLoopEnabled(true);
    setPlaylistStatus("connecting");
    setPlaylistTrack("Loading playlist…");
    setPlaylistPosition(null);
    void createYouTubePlaylistPlayer(stage, target, {
      onReady: () => {
        if (generation !== youtubeGenerationRef.current) return;
        const activePlayer = youtubePlayerRef.current;
        if (!activePlayer) return;
        activePlayer.setVolume(volume);
        activePlayer.setLoop(true);
        if (storedProgress?.seconds) activePlayer.seekTo(storedProgress.seconds);
        if (playImmediately) activePlayer.play();
      },
      onStateChange: (state) => {
        if (generation !== youtubeGenerationRef.current) return;
        const current = youtubePlayerRef.current?.getCurrent();
        if (current?.title) setPlaylistTrack(current.title);
        if (current) setPlaylistPosition({ index: current.index, total: current.total });
        const activePlayer = youtubePlayerRef.current;
        if (activePlayer) {
          syncPlaylistTiming(activePlayer);
          setCurrentVideoId(activePlayer.getVideoId());
          persistCurrentPlaylistProgress(activePlayer);
        }
        if (state === "playing") {
          setPlaylistStatus("playing");
        } else if (state === "paused") {
          setPlaylistStatus("paused");
        } else if (state === "ended") {
          const endedPlayer = youtubePlayerRef.current;
          if (endedPlayer && loopEnabledRef.current) {
            endedPlayer.playVideoAt(0);
            setPlaylistStatus("connecting");
            setPlaylistEnded(false);
          } else {
            setPlaylistStatus("idle");
            setPlaylistTrack("Playlist finished");
            setPlaylistEnded(true);
          }
        } else if (state === "buffering") {
          setPlaylistStatus((currentStatus) => (currentStatus === "playing" ? currentStatus : "connecting"));
        } else if (state === "unstarted" || state === "cued") {
          setPlaylistStatus((currentStatus) => (currentStatus === "playing" ? currentStatus : "idle"));
        }
      },
      onError: () => {
        if (generation !== youtubeGenerationRef.current) return;
        const player = youtubePlayerRef.current;
        if (!player) return;
        const current = player.getCurrent();
        if (target.kind === "playlist" || current.total > 1) {
          player.next();
          player.play();
          setPlaylistStatus("connecting");
        } else {
          setPlaylistStatus("unavailable");
          setPlaylistTrack("YouTube playback is unavailable");
        }
      }
    }, {
      autoplay: playImmediately,
      startIndex: storedProgress?.trackIndex ?? 0,
      startSeconds: storedProgress?.seconds ?? 0
    }).then((player) => {
      if (generation !== youtubeGenerationRef.current) {
        player.destroy();
        return;
      }
      youtubePlayerRef.current = player;
      setHasPlaylistSession(true);
      player.setVolume(volume);
      player.setLoop(true);
      if (playImmediately) player.play();
      setPlaylistStatus((currentStatus) => (
        currentStatus === "playing" || playImmediately ? currentStatus : "idle"
      ));
      const current = player.getCurrent();
      if (current?.title) setPlaylistTrack(current.title);
      if (current) setPlaylistPosition({ index: current.index, total: current.total });
      syncPlaylistTiming(player);
      setCurrentVideoId(player.getVideoId());
    }).catch(() => {
      if (generation !== youtubeGenerationRef.current) return;
      setPlaylistStatus("unavailable");
      setPlaylistTrack("YouTube playback is unavailable");
    });
  }, [persistCurrentPlaylistProgress, shouldPersistVolume, syncPlaylistTiming, volume]);

  const togglePlaylistPlayback = useCallback(() => {
    if (playlistStatus === "unavailable") {
      const link = musicLinks.find((entry) => entry.id === selectedLinkId) ?? musicLinks[0];
      if (link) startPlaylist(link, true);
      return;
    }
    const player = youtubePlayerRef.current;
    if (!player) {
      if (playlistStatus === "connecting") {
        youtubeGenerationRef.current += 1;
        setPlaylistStatus("idle");
        setPlaylistTrack("Playback stopped");
        return;
      }
      const link = musicLinks.find((entry) => entry.id === selectedLinkId) ?? musicLinks[0];
      if (link) startPlaylist(link, true);
      return;
    }
    if (playlistStatus === "playing" || playlistStatus === "connecting") {
      persistCurrentPlaylistProgress(player);
      player.pause();
      setPlaylistStatus("paused");
    } else {
      setPlaylistStatus("connecting");
      player.play();
    }
  }, [musicLinks, persistCurrentPlaylistProgress, playlistStatus, selectedLinkId, startPlaylist]);

  const nextSong = useCallback(() => {
    const player = youtubePlayerRef.current;
    if (!player) return;
    const current = player.getCurrent();
    if (current.total <= 1) return;
    setPlaylistStatus("connecting");
    if (current.index >= current.total) player.playVideoAt(0);
    else player.next();
    player.play();
  }, []);

  const previousSong = useCallback(() => {
    const player = youtubePlayerRef.current;
    if (!player) return;
    const current = player.getCurrent();
    setPlaylistStatus("connecting");
    if (current.total > 1 && current.index <= 1) player.playVideoAt(current.total - 1);
    else player.previous();
    player.play();
  }, []);

  const toggleLoop = useCallback(() => {
    const player = youtubePlayerRef.current;
    if (!player) return;
    const next = !loopEnabledRef.current;
    player.setLoop(next);
    loopEnabledRef.current = next;
    setLoopEnabled(next);
  }, []);

  const seekPlaylist = useCallback((seconds: number) => {
    const player = youtubePlayerRef.current;
    if (!player) return;
    player.seekTo(seconds);
    setPlaylistTime(seconds);
    persistCurrentPlaylistProgress(player);
  }, [persistCurrentPlaylistProgress]);

  const toggleQueue = useCallback(() => {
    setQueueOpen((open) => !open);
  }, []);

  const playQueueTrack = useCallback((index: number) => {
    const player = youtubePlayerRef.current;
    if (!player) return;
    player.playVideoAt(index);
    setPlaylistStatus("connecting");
  }, []);

  const switchSource = useCallback((next: MusicSource) => {
    if (next === source) return;
    if (next === "radio") {
      stopPlaylist();
    } else {
      disconnect();
    }
    setSource(next);
  }, [disconnect, source, stopPlaylist]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (source !== "playlist") return;
    youtubePlayerRef.current?.setVolume(volume);
  }, [source, volume]);

  useEffect(() => {
    if (source !== "playlist" || playlistStatus !== "playing") return;
    const timer = window.setInterval(() => {
      const player = youtubePlayerRef.current;
      if (!player) return;
      syncPlaylistTiming(player);
      setCurrentVideoId(player.getVideoId());
      persistCurrentPlaylistProgress(player);
    }, PLAYLIST_PROGRESS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [persistCurrentPlaylistProgress, source, playlistStatus, syncPlaylistTiming]);

  useEffect(() => {
    if (!queueOpen || !hasPlaylistSession || queueTracks !== null) return;
    let cancelled = false;
    const ids = youtubePlayerRef.current?.getPlaylistIds() ?? [];
    if (ids.length === 0) {
      setQueueTracks([]);
      return;
    }
    void Promise.all(ids.map(async (videoId, index) => {
      try {
        const response = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`
        );
        if (!response.ok) throw new Error("YouTube oEmbed failed.");
        const data = (await response.json()) as { title?: unknown };
        const title = typeof data.title === "string" && data.title.trim() ? data.title : `Track ${index + 1}`;
        return { videoId, title };
      } catch {
        return { videoId, title: `Track ${index + 1}` };
      }
    })).then((tracks) => {
      if (!cancelled) setQueueTracks(tracks);
    });
    return () => {
      cancelled = true;
    };
  }, [queueOpen, hasPlaylistSession, queueTracks]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      wantsPlaybackRef.current = false;
      generationRef.current += 1;
      disposeActiveAttempt();
      persistCurrentPlaylistProgress(youtubePlayerRef.current);
      youtubeGenerationRef.current += 1;
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      if (!audio?.hasAttribute("src")) return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [disposeActiveAttempt, persistCurrentPlaylistProgress]);

  useEffect(() => {
    if (status !== "playing") return;
    let disposed = false;
    let controller: AbortController | null = null;

    async function pollMetadata() {
      controller?.abort();
      controller = new AbortController();
      try {
        const metadataUrl = runtime.platform.resolveExternalResource(CODE_RADIO_METADATA_URL);
        if (!metadataUrl) throw new Error("Code Radio metadata is unavailable in this runtime.");
        const response = await runtime.platform.fetch(metadataUrl, {
          cache: "no-store",
          credentials: "omit",
          headers: { accept: "application/json" },
          referrerPolicy: "no-referrer",
          signal: controller.signal
        });
        const nextTrack = parseCodeRadioMetadata(await readMetadataPayload(response));
        if (!nextTrack) throw new Error("Code Radio metadata was invalid.");
        if (!disposed) setTrack(nextTrack);
      } catch (error) {
        if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) {
          setTrack("Track details unavailable");
        }
      }
    }

    void pollMetadata();
    const interval = window.setInterval(() => void pollMetadata(), METADATA_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [runtime, status]);

  useEffect(() => {
    if (!open || source !== "playlist") return;
    let disposed = false;

    async function loadMusicLibraryLinks() {
      setMusicLinksLoading(true);
      try {
        const result = await api.links({ page: 1, pageSize: MUSIC_LIBRARY_LINKS_PAGE_SIZE });
        if (disposed) return;
        setMusicLinks(result.data.filter((link) => link.category === "MUSIC_LIBRARY"));
      } catch {
        if (!disposed) setMusicLinks([]);
      } finally {
        if (!disposed) setMusicLinksLoading(false);
      }
    }

    void loadMusicLibraryLinks();
    window.addEventListener(USER_LINKS_UPDATED_EVENT, loadMusicLibraryLinks);
    return () => {
      disposed = true;
      window.removeEventListener(USER_LINKS_UPDATED_EVENT, loadMusicLibraryLinks);
    };
  }, [open, source]);

  useLayoutEffect(() => {
    if (!open || mobile) return;
    function updatePosition() {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const triggerRect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const width = panelRect.width || FALLBACK_PANEL_WIDTH_PX;
      const height = panelRect.height || FALLBACK_PANEL_HEIGHT_PX;
      const fitsBelow = triggerRect.bottom + ANCHOR_GAP_PX + height <= window.innerHeight - VIEWPORT_MARGIN_PX;
      const desiredTop = fitsBelow
        ? triggerRect.bottom + ANCHOR_GAP_PX
        : triggerRect.top - ANCHOR_GAP_PX - height;
      setPosition({
        left: Math.max(VIEWPORT_MARGIN_PX, Math.min(triggerRect.right - width, window.innerWidth - width - VIEWPORT_MARGIN_PX)),
        top: Math.max(VIEWPORT_MARGIN_PX, Math.min(desiredTop, window.innerHeight - height - VIEWPORT_MARGIN_PX)),
        ready: true
      });
    }
    updatePosition();
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    const geometryRoot = trigger?.closest(".board-toolbar") ?? trigger?.parentElement ?? null;
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    if (trigger) resizeObserver?.observe(trigger);
    if (panel) resizeObserver?.observe(panel);
    if (geometryRoot && geometryRoot !== trigger) resizeObserver?.observe(geometryRoot);
    const mutationObserver = geometryRoot && typeof MutationObserver !== "undefined"
      ? new MutationObserver(updatePosition)
      : null;
    mutationObserver?.observe(geometryRoot as Node, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [mobile, open, triggerRef]);

  useEffect(() => {
    if (!open || !mobile) return;
    const currentPanel = panelRef.current;
    if (!(currentPanel instanceof HTMLElement)) return;
    const focusPanel: HTMLElement = currentPanel;
    const layer = focusPanel.closest(".vibe-music-sheet-backdrop");
    if (!(layer instanceof HTMLElement)) return;
    const backgrounds = Array.from(document.body.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== layer
    );
    const previousInert = backgrounds.map((element) => [element, element.inert] as const);
    backgrounds.forEach((element) => {
      element.inert = true;
    });

    function keepFocusInside(event: FocusEvent) {
      if (focusPanel.contains(event.target as Node)) return;
      primaryControlRef.current?.focus();
    }
    function keepTabInside(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusable = focusableElements(focusPanel);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !focusPanel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !focusPanel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("focusin", keepFocusInside, true);
    focusPanel.addEventListener("keydown", keepTabInside, true);
    return () => {
      document.removeEventListener("focusin", keepFocusInside, true);
      focusPanel.removeEventListener("keydown", keepTabInside, true);
      previousInert.forEach(([element, inert]) => {
        element.inert = inert;
      });
    };
  }, [mobile, open]);

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => primaryControlRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open || mobile) return;
    function handleOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onOpenChange(false);
    }
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [mobile, onOpenChange, open, triggerRef]);

  function updateVolume(nextPercent: number) {
    const nextVolume = Math.min(1, Math.max(0, nextPercent / 100));
    setVolume(nextVolume);
    persistVolume(nextVolume, shouldPersistVolume);
  }

  const isActive = status === "connecting" || status === "playing";
  const controlLabel = status === "unavailable" ? "Retry Code Radio" : isActive ? "Pause Code Radio" : "Play Code Radio";
  const isPlaylistActive = playlistStatus === "connecting" || playlistStatus === "playing";
  const playlistControlLabel = isPlaylistActive
    ? "Pause playlist"
    : playlistStatus === "unavailable"
      ? "Retry playlist"
      : "Play playlist";
  const playlistStatusText = hasPlaylistSession && playlistStatus === "idle" && !playlistEnded
    ? "Ready"
    : playlistStatusLabel(playlistStatus);
  const panelStyle: CSSProperties | undefined = mobile
    ? undefined
    : { left: `${position.left}px`, top: `${position.top}px`, visibility: position.ready ? "visible" : "hidden" };

  const panel = open ? (
    <section
      ref={panelRef}
      id={VIBE_MUSIC_PANEL_ID}
      className={mobile ? "vibe-music-panel vibe-music-sheet vibe-music-theme" : "vibe-music-panel vibe-music-popover vibe-music-theme"}
      data-room-theme={roomTheme}
      role="dialog"
      aria-modal={mobile ? "true" : undefined}
      aria-label="Vibe Music"
      style={panelStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <header className="vibe-music-header">
        <span className="vibe-music-heading"><Radio aria-hidden="true" /><strong>Vibe Music</strong></span>
        <div className="vibe-music-source" role="group" aria-label="Music source">
          <button
            type="button"
            className={source === "radio" ? "is-active" : undefined}
            aria-pressed={source === "radio"}
            onClick={() => switchSource("radio")}
          >
            <Radio aria-hidden="true" />Radio
          </button>
          <button
            type="button"
            className={source === "playlist" ? "is-active" : undefined}
            aria-pressed={source === "playlist"}
            onClick={() => switchSource("playlist")}
          >
            <Youtube aria-hidden="true" />Playlist
          </button>
        </div>
        <button type="button" className="vibe-music-close" aria-label="Close Vibe Music" onClick={() => onOpenChange(false)}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="vibe-music-content">
        {source === "radio" ? (
          <div className="vibe-music-radio">
            <div className="vibe-music-now-playing">
              <span>Now playing</span>
              <strong data-testid="vibe-music-track">{track}</strong>
            </div>
            <div className="vibe-music-connection">
              <span className="vibe-music-status-dot" data-status={status} aria-hidden="true" />
              <span data-vibe-music-status={statusLabel(status)} role="status" aria-live="polite">{statusLabel(status)}</span>
            </div>
            {status === "unavailable" ? <p className="vibe-music-error" role="alert">Code Radio is unavailable</p> : null}
            <button
              ref={primaryControlRef}
              type="button"
              className="vibe-music-playback"
              aria-label={controlLabel}
              onClick={isActive ? disconnect : startPlayback}
            >
              {status === "unavailable" ? <RefreshCw aria-hidden="true" /> : isActive ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              <span>{status === "unavailable" ? "Retry" : isActive ? "Pause" : "Play"}</span>
            </button>
            <a className="vibe-music-attribution" href={runtime.platform.resolveExternalResource(CODE_RADIO_ATTRIBUTION_URL) ?? "#"} target="_blank" rel="noreferrer">
              freeCodeCamp Code Radio <ExternalLink aria-hidden="true" />
            </a>
          </div>
        ) : (
          <div className="vibe-music-playlist">
            {playlistStatus === "unavailable" ? <p className="vibe-music-error" role="alert">YouTube playback is unavailable</p> : null}
            {playlistStatus === "unsupported" ? <p className="vibe-music-error" role="alert">This link is not a YouTube playlist</p> : null}
            <div className="vibe-music-playlist-picker">
              <label className="vibe-music-playlist-picker-label" htmlFor="vibe-music-playlist-select">Playlist</label>
              <select
                id="vibe-music-playlist-select"
                aria-label="Music library playlist"
                value={selectedLinkId ?? ""}
                onChange={(event) => {
                  const linkId = event.currentTarget.value || null;
                  setSelectedLinkId(linkId);
                  const link = musicLinks.find((entry) => entry.id === linkId);
                  if (link) startPlaylist(link);
                }}
              >
                <option value="">Select a playlist…</option>
                {musicLinks.map((link) => (
                  <option key={link.id} value={link.id}>{link.title}</option>
                ))}
              </select>
            </div>
            {musicLinksLoading && musicLinks.length === 0 ? (
              <p className="vibe-music-playlist-empty">Loading playlists…</p>
            ) : null}
            {!musicLinksLoading && musicLinks.length === 0 ? (
              <p className="vibe-music-playlist-empty">No music library links yet. Mark a link as “Music library” in the Links dock to play it here.</p>
            ) : null}
            <div className="vibe-music-player-stage">
              <div className="vibe-music-player-art">
                {currentVideoId ? (
                  <img src={`${YOUTUBE_THUMBNAIL_BASE_URL}/${currentVideoId}/hqdefault.jpg`} alt="" />
                ) : (
                  <Music2 aria-hidden="true" />
                )}
              </div>
              <div className="vibe-music-player-track">
                <strong data-testid="vibe-music-playlist-track">{playlistTrack}</strong>
                {playlistPosition ? <span className="vibe-music-position">Track {playlistPosition.index} of {playlistPosition.total}</span> : null}
              </div>
              <div className="vibe-music-player-progress">
                {playlistIsLive ? (
                  <span className="vibe-music-player-live" role="status">Live stream</span>
                ) : (
                  <>
                    <output>{formatPlaybackTime(playlistTime)}</output>
                    <input
                      type="range"
                      min="0"
                      max={Math.max(1, Math.round(playlistDuration))}
                      step="1"
                      value={Math.min(Math.round(playlistTime), Math.max(1, Math.round(playlistDuration)))}
                      aria-label="Seek in playlist"
                      disabled={!hasPlaylistSession || playlistDuration <= 0}
                      onChange={(event) => seekPlaylist(Number(event.currentTarget.value))}
                    />
                    <output>{formatPlaybackTime(playlistDuration)}</output>
                  </>
                )}
              </div>
              <div className="vibe-music-player-controls">
                <button
                  type="button"
                  className="vibe-music-player-aux"
                  aria-label="Repeat playlist"
                  aria-pressed={loopEnabled}
                  disabled={!hasPlaylistSession}
                  onClick={toggleLoop}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="vibe-music-player-aux"
                  aria-label="Previous song"
                  disabled={!hasPlaylistSession}
                  onClick={previousSong}
                >
                  <ChevronLeft aria-hidden="true" />
                </button>
                <button
                  ref={primaryControlRef}
                  type="button"
                  className="vibe-music-player-main"
                  aria-label={playlistControlLabel}
                  disabled={!hasPlaylistSession && musicLinks.length === 0 && playlistStatus !== "connecting"}
                  onClick={togglePlaylistPlayback}
                >
                  {isPlaylistActive ? <Pause aria-hidden="true" /> : playlistStatus === "unavailable" ? <RefreshCw aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="vibe-music-player-aux"
                  aria-label="Next song"
                  disabled={!hasPlaylistSession}
                  onClick={nextSong}
                >
                  <ChevronRight aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="vibe-music-player-aux"
                  aria-label={queueOpen ? "Hide playlist queue" : "Show playlist queue"}
                  aria-expanded={queueOpen}
                  disabled={!hasPlaylistSession}
                  onClick={toggleQueue}
                >
                  <ListFilter aria-hidden="true" />
                </button>
              </div>
              {queueOpen && hasPlaylistSession ? (
                <div className="vibe-music-queue">
                  <span className="vibe-music-queue-label">Up next</span>
                  {queueTracks === null ? (
                    <p className="vibe-music-playlist-empty">Loading queue…</p>
                  ) : queueTracks.length === 0 ? (
                    <p className="vibe-music-playlist-empty">No tracks available.</p>
                  ) : (
                    <ul className="vibe-music-queue-list">
                      {queueTracks.map((queueTrack, index) => {
                        const current = playlistPosition ? playlistPosition.index - 1 : -1;
                        return (
                          <li key={queueTrack.videoId} className={index === current ? "vibe-music-queue-row is-active" : "vibe-music-queue-row"}>
                            <button
                              type="button"
                              aria-label={`Play ${queueTrack.title}`}
                              onClick={() => playQueueTrack(index)}
                            >
                              <span className="vibe-music-queue-index">{index + 1}</span>
                              <span className="vibe-music-queue-title">{queueTrack.title}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : null}
              <div className="vibe-music-connection">
                <span className="vibe-music-status-dot" data-status={playlistStatus} aria-hidden="true" />
                <span data-vibe-music-playlist-status={playlistStatusLabel(playlistStatus)} role="status" aria-live="polite">{playlistStatusText}</span>
              </div>
            </div>
          </div>
        )}
        <label className="vibe-music-volume">
          <span><Volume2 aria-hidden="true" />Volume</span>
          <input
            type="range"
            name="vibeMusicVolume"
            min="0"
            max="100"
            step="1"
            value={Math.round(volume * 100)}
            aria-label="Volume"
            onChange={(event) => updateVolume(Number(event.currentTarget.value))}
          />
          <output>{Math.round(volume * 100)}%</output>
        </label>
      </div>
    </section>
  ) : null;

  return (
    <>
      <audio ref={audioRef} data-vibe-music-audio="" preload="none" aria-hidden="true" />
      <div
        ref={youtubeStageRef}
        id={VIBE_MUSIC_YOUTUBE_STAGE_ID}
        className="vibe-music-youtube-stage"
        aria-hidden="true"
        tabIndex={-1}
      />
      {panel
        ? createPortal(
            mobile
              ? <div className="vibe-music-sheet-backdrop" onClick={() => onOpenChange(false)}>{panel}</div>
              : panel,
            document.body
          )
        : null}
    </>
  );
}
