import { railPopoverPosition, useMenuWheel } from "../rail-popover.js";
import { DEFAULT_SPACE_VOLUME, SPACE_VOLUME_STORAGE_KEY, getSpaceVolume, setSpaceVolume, subscribeSpaceVolume } from '../../space-audio.js';
import { registerRoomPlaybackTarget } from "../room-agent/room-playback-control.js";
import { ChevronLeft, ChevronRight, ExternalLink, ListFilter, Music2, Pause, Play, Radio, RefreshCw, RotateCcw, Trash2, Volume2, X, Youtube } from "../ui-theme/app-icons.js";
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
import { APP_DIAGNOSTICS_STATE_EVENT, getAppDiagnosticsClientState } from "../../app-diagnostics/app-diagnostics-bootstrap.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { USER_LINKS_UPDATED_EVENT } from "../user-links/UserLinks.js";
import {
  createYouTubePlaylistPlayer,
  parseYouTubeLink,
  type YouTubeLinkTarget,
  type YouTubePlaylistPlayer
} from "./youtubePlaylistPlayer.js";
import "./vibe-music.css";

export const CODE_RADIO_PRIMARY_STREAM_URL = "https://coderadio-admin-v2.freecodecamp.org/listen/coderadio/radio.mp3";
export const CODE_RADIO_FALLBACK_STREAM_URL = "https://coderadio-admin-v2.freecodecamp.org/listen/coderadio/low.mp3";
export const CODE_RADIO_METADATA_URL = "https://coderadio-admin-v2.freecodecamp.org/api/nowplaying_static/coderadio.json";
export const CODE_RADIO_ATTRIBUTION_URL = "https://coderadio.freecodecamp.org/";
export const VIBE_MUSIC_VOLUME_STORAGE_KEY = SPACE_VOLUME_STORAGE_KEY;
export const VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY = "space.vibeMusic.playlistLinkId";
export const VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY = "space.vibeMusic.playlistProgress";
export const VIBE_MUSIC_PLAYBACK_STORAGE_KEY = "space.vibeMusic.playback.v1";
export const VIBE_MUSIC_PANEL_ID = "vibe-music-player";
export const VIBE_MUSIC_YOUTUBE_STAGE_ID = "vibe-music-youtube-stage";

const DEFAULT_VOLUME = DEFAULT_SPACE_VOLUME;
const MUSIC_LIBRARY_LINKS_PAGE_SIZE = 100;
const METADATA_POLL_INTERVAL_MS = 30_000;
const METADATA_RESPONSE_LIMIT_BYTES = 64 * 1024;
const CONNECTION_TIMEOUT_MS = 12_000;
const YOUTUBE_OEMBED_TIMEOUT_MS = 2_500;
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
  activeRoomId?: string;
  mobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenYouTube?: (url: string) => void;
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

type QueueTrack =
  | { kind: "youtube"; videoId: string; title: string }
  | { kind: "library"; linkId: string; title: string };

type StoredPlaylistProgress = {
  linkId: string;
  trackIndex: number;
  seconds: number;
  videoId: string | null;
};

type SavedMusicPlayback = { source: MusicSource; playing: boolean; linkId: string | null; savedAt: number };

function readReloadPlayback(enabled: boolean): SavedMusicPlayback | null {
  if (!enabled || getSpaceRuntime().kind !== "live") return null;
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (navigation?.type !== "reload") return null;
    const raw = getSpaceRuntime().platform.sessionStorage.getItem(VIBE_MUSIC_PLAYBACK_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!isPlainObject(value) || !["radio", "playlist"].includes(String(value.source)) || typeof value.playing !== "boolean" || typeof value.savedAt !== "number" || Date.now() - value.savedAt > 60_000 || value.savedAt > Date.now()) return null;
    const linkId = typeof value.linkId === "string" ? value.linkId : null;
    if (value.source === "playlist" && !linkId) return null;
    return { source: value.source as MusicSource, playing: value.playing, linkId, savedAt: value.savedAt };
  } catch {
    return null;
  }
}

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

export function VibeMusicPlayer({ activeRoomId, mobile, open, onOpenChange, onOpenYouTube, persistVolume: shouldPersistVolume = true, roomTheme, triggerRef }: VibeMusicPlayerProps) {
  const runtime = getSpaceRuntime();
  const [reloadPlayback] = useState(() => readReloadPlayback(shouldPersistVolume));
  const [resumeBlocked, setResumeBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  useMenuWheel(panelRef, "button:not(:disabled)", open, triggerRef);
  const primaryControlRef = useRef<HTMLButtonElement | null>(null);
  const youtubeStageRef = useRef<HTMLDivElement | null>(null);
  const youtubePlayerRef = useRef<YouTubePlaylistPlayer | null>(null);
  const activePlaylistLinkIdRef = useRef<string | null>(null);
  const activePlaylistTargetRef = useRef<YouTubeLinkTarget | null>(null);
  const playlistConnectionTimerRef = useRef<number | null>(null);
  const storedPlaylistProgressRef = useRef<StoredPlaylistProgress | null>(readStoredPlaylistProgress(shouldPersistVolume));
  const loopEnabledRef = useRef(true);
  const playlistWantsPlaybackRef = useRef(false);
  const failedPlaylistTracksRef = useRef(new Set<number>());
  const youtubeGenerationRef = useRef(0);
  const generationRef = useRef(0);
  const attemptIdRef = useRef(0);
  const activeAttemptCleanupRef = useRef<(() => void) | null>(null);
  const wantsPlaybackRef = useRef(false);
  const connectAttemptRef = useRef<(streamIndex: 0 | 1, generation: number) => void>(() => undefined);
  const handleAttemptFailureRef = useRef<(failure: AttemptFailure) => void>(() => undefined);
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [track, setTrack] = useState("Track details appear after playback starts");
  const [volume, setVolume] = useState(() => shouldPersistVolume ? getSpaceVolume() : DEFAULT_VOLUME);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  useEffect(() => {
    if (!shouldPersistVolume) return;
    setVolume(getSpaceVolume());
    return subscribeSpaceVolume(setVolume);
  }, [shouldPersistVolume]);
  const [position, setPosition] = useState<PanelPosition>({ left: VIEWPORT_MARGIN_PX, top: VIEWPORT_MARGIN_PX, ready: false });
  const [source, setSource] = useState<MusicSource>(reloadPlayback?.source ?? "radio");
  const [playlistStatus, setPlaylistStatus] = useState<PlaylistPlaybackStatus>("idle");
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [playlistTrack, setPlaylistTrack] = useState("Select a playlist to start listening");
  const [playlistPosition, setPlaylistPosition] = useState<{ index: number; total: number } | null>(null);
  const [hasPlaylistSession, setHasPlaylistSession] = useState(false);
  const [musicLinks, setMusicLinks] = useState<UserLink[]>([]);
  const [musicLinksLoading, setMusicLinksLoading] = useState(false);
  const [deletingLink, setDeletingLink] = useState(false);
  const [linkDeleteError, setLinkDeleteError] = useState<string | null>(null);
  const deletedLinkIdsRef = useRef(new Set<string>());
  const deletingLinkRef = useRef(false);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(() => reloadPlayback?.linkId ?? readStoredPlaylistLinkId(shouldPersistVolume));
  const [playlistTime, setPlaylistTime] = useState(0);
  const [playlistDuration, setPlaylistDuration] = useState(0);
  const [playlistIsLive, setPlaylistIsLive] = useState(false);
  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueTracks, setQueueTracks] = useState<QueueTrack[] | null>(null);
  const [playlistEnded, setPlaylistEnded] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(() => getAppDiagnosticsClientState().status?.isEnabled ?? false);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [debugCopied, setDebugCopied] = useState(false);
  const debugLogRef = useRef<string[]>([]);

  const copyDebugLog = useCallback(() => {
    const text = debugLogRef.current.join("\n") || "No debug events recorded yet.";
    const markCopied = () => {
      setDebugCopied(true);
      window.setTimeout(() => setDebugCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(markCopied).catch(() => {});
      return;
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      markCopied();
    } catch {
      // Clipboard access denied — nothing else we can do here.
    }
    area.remove();
  }, []);

  const pushDebug = useCallback((label: string, detail: Record<string, unknown>) => {
    const entry = `[${new Date().toISOString().slice(11, 23)}] ${label} ${JSON.stringify(detail)}`;
    const next = [...debugLogRef.current.slice(-59), entry];
    debugLogRef.current = next;
    setDebugLog(next);
    console.debug(`[VibeMusic] ${entry}`);
  }, []);

  useEffect(() => {
    const update = () => setDebugEnabled(getAppDiagnosticsClientState().status?.isEnabled ?? false);
    update();
    window.addEventListener(APP_DIAGNOSTICS_STATE_EVENT, update);
    return () => window.removeEventListener(APP_DIAGNOSTICS_STATE_EVENT, update);
  }, []);

  const clearPlaylistConnectionTimer = useCallback(() => {
    if (playlistConnectionTimerRef.current !== null) {
      window.clearTimeout(playlistConnectionTimerRef.current);
      playlistConnectionTimerRef.current = null;
    }
  }, []);

  const armPlaylistConnectionTimer = useCallback((generation = youtubeGenerationRef.current) => {
    clearPlaylistConnectionTimer();
    playlistConnectionTimerRef.current = window.setTimeout(() => {
      playlistConnectionTimerRef.current = null;
      if (generation !== youtubeGenerationRef.current) return;
      setPlaylistStatus("unavailable");
      setPlaylistError("YouTube playback is unavailable. Try again or choose another playlist.");
    }, CONNECTION_TIMEOUT_MS);
  }, [clearPlaylistConnectionTimer]);

  const clearYoutubeStage = useCallback(() => {
    youtubeStageRef.current?.replaceChildren();
  }, []);

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
    setResumeBlocked(false);
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
    } catch (error) {
      if (!isCurrentAttempt()) return;
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        disposeActiveAttempt();
        wantsPlaybackRef.current = false;
        setStatus("idle");
        setResumeBlocked(true);
      } else fail();
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
    setResumeBlocked(false);
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
    if (!player || !linkId || !player.isReady()) return;
    const current = player.getCurrent();
    const duration = player.getDuration();
    const rawSeconds = player.getCurrentTime();
    if (duration <= 0 && rawSeconds <= 0 && storedPlaylistProgressRef.current?.linkId === linkId) return;
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
    setResumeBlocked(false);
    persistCurrentPlaylistProgress(youtubePlayerRef.current);
    playlistWantsPlaybackRef.current = false;
    setPlaylistError(null);
    youtubeGenerationRef.current += 1;
    clearPlaylistConnectionTimer();
    youtubePlayerRef.current?.destroy();
    youtubePlayerRef.current = null;
    activePlaylistLinkIdRef.current = null;
    activePlaylistTargetRef.current = null;
    clearYoutubeStage();
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
  }, [clearPlaylistConnectionTimer, clearYoutubeStage, persistCurrentPlaylistProgress]);

  const deleteSelectedLink = useCallback(async () => {
    const link = musicLinks.find((entry) => entry.id === selectedLinkId);
    if (!link || deletingLinkRef.current) return;
    if (!window.confirm(`Delete "${link.title}" from your music library and saved Links?`)) return;
    deletingLinkRef.current = true;
    setDeletingLink(true);
    setLinkDeleteError(null);
    try {
      await api.deleteLink(link.id);
      deletedLinkIdsRef.current.add(link.id);
      if (activePlaylistLinkIdRef.current === link.id) stopPlaylist();
      setMusicLinks((links) => links.filter((entry) => entry.id !== link.id));
      setSelectedLinkId((selected) => selected === link.id ? null : selected);
      if (storedPlaylistProgressRef.current?.linkId === link.id) storedPlaylistProgressRef.current = null;
      if (shouldPersistVolume) {
        try {
          const storage = runtime.platform.localStorage;
          if (storage.getItem(VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY) === link.id) storage.removeItem(VIBE_MUSIC_PLAYLIST_LINK_STORAGE_KEY);
          const progress = readStoredPlaylistProgress(true);
          if (progress?.linkId === link.id) storage.removeItem(VIBE_MUSIC_PLAYLIST_PROGRESS_STORAGE_KEY);
        } catch {
          // Deletion remains successful when browser storage is unavailable.
        }
      }
      window.dispatchEvent(new Event(USER_LINKS_UPDATED_EVENT));
    } catch {
      setLinkDeleteError("Link could not be deleted. Please try again.");
    } finally {
      deletingLinkRef.current = false;
      setDeletingLink(false);
    }
  }, [musicLinks, runtime, selectedLinkId, shouldPersistVolume, stopPlaylist]);

  const startPlaylist = useCallback((link: UserLink, playImmediately = false) => {
    const target = parseYouTubeLink(link.url);
    pushDebug("startPlaylist", {
      linkId: link.id,
      url: link.url,
      kind: target?.kind ?? "invalid",
      playImmediately,
      status: playlistStatus
    });
    persistCurrentPlaylistProgress(youtubePlayerRef.current);
    setResumeBlocked(false);
    setLinkDeleteError(null);
    playlistWantsPlaybackRef.current = playImmediately;
    setSelectedLinkId(link.id);
    persistPlaylistLinkId(link.id, shouldPersistVolume);
    activePlaylistLinkIdRef.current = link.id;
    youtubeGenerationRef.current += 1;
    clearPlaylistConnectionTimer();
    youtubePlayerRef.current?.destroy();
    youtubePlayerRef.current = null;
    activePlaylistTargetRef.current = target;
    clearYoutubeStage();
    setHasPlaylistSession(false);
    failedPlaylistTracksRef.current.clear();
    setPlaylistError(null);
    setPlaylistTime(0);
    setPlaylistDuration(0);
    setPlaylistIsLive(false);
    setCurrentVideoId(null);
    setQueueTracks(null);
    setPlaylistEnded(false);
    if (!target) {
      activePlaylistTargetRef.current = null;
      setPlaylistStatus("unsupported");
      setPlaylistTrack("This link is not a YouTube playlist");
      setPlaylistPosition(null);
      return;
    }
    const stage = youtubeStageRef.current;
    if (!stage) return;
    const generation = youtubeGenerationRef.current;
    const playerHost = document.createElement("div");
    playerHost.id = `${VIBE_MUSIC_YOUTUBE_STAGE_ID}-player-${generation}`;
    stage.appendChild(playerHost);
    const storedProgress = storedPlaylistProgressRef.current?.linkId === link.id
      ? storedPlaylistProgressRef.current
      : null;
    loopEnabledRef.current = true;
    setLoopEnabled(true);
    setPlaylistStatus("connecting");
    setPlaylistTrack(link.title);
    setPlaylistPosition(null);
    armPlaylistConnectionTimer(generation);
    void createYouTubePlaylistPlayer(playerHost, target, {
      onReady: () => {
        if (generation !== youtubeGenerationRef.current) return;
        const activePlayer = youtubePlayerRef.current;
        pushDebug("youtube:onReady", {
          player: Boolean(activePlayer),
          current: activePlayer?.getCurrent() ?? null,
          videoId: activePlayer?.getVideoId() ?? null
        });
        if (!activePlayer) return;
        if (!playlistWantsPlaybackRef.current) {
          clearPlaylistConnectionTimer();
          syncPlaylistTiming(activePlayer);
          setPlaylistStatus("paused");
        }
      },
      onStateChange: (state) => {
        if (generation !== youtubeGenerationRef.current) return;
        const activePlayer = youtubePlayerRef.current;
        const current = activePlayer?.getCurrent();
        pushDebug("youtube:onStateChange", {
          state,
          current: current ?? null,
          videoId: activePlayer?.getVideoId() ?? null,
          playlistIds: activePlayer?.getPlaylistIds().length ?? 0,
          time: activePlayer?.getCurrentTime() ?? 0,
          duration: activePlayer?.getDuration() ?? 0,
          loop: activePlayer?.getLoop() ?? null
        });
        if (current?.title) setPlaylistTrack(current.title);
        if (current) setPlaylistPosition({ index: current.index, total: current.total });
        if (activePlayer) {
          syncPlaylistTiming(activePlayer);
          setCurrentVideoId(activePlayer.getVideoId());
          persistCurrentPlaylistProgress(activePlayer);
        }
        if (state === "playing") {
          playlistWantsPlaybackRef.current = true;
          setResumeBlocked(false);
          clearPlaylistConnectionTimer();
          failedPlaylistTracksRef.current.clear();
          setPlaylistError(null);
          setPlaylistEnded(false);
          setPlaylistStatus("playing");
        } else if (state === "paused") {
          playlistWantsPlaybackRef.current = false;
          clearPlaylistConnectionTimer();
          setPlaylistStatus("paused");
        } else if (state === "ended") {
          const endedPlayer = youtubePlayerRef.current;
          const endedCurrent = endedPlayer?.getCurrent();
          if (endedPlayer && endedCurrent && endedCurrent.index < endedCurrent.total) {
            // YouTube advances its own queue after each track's ENDED event.
            armPlaylistConnectionTimer(generation);
            setPlaylistStatus("connecting");
          } else if (endedPlayer && loopEnabledRef.current) {
            if (endedCurrent && endedCurrent.total <= 1 && target.kind === "video") {
              endedPlayer.seekTo(0);
              endedPlayer.play();
            } else {
              endedPlayer.playVideoAt(0);
            }
            armPlaylistConnectionTimer(generation);
            setPlaylistStatus("connecting");
            setPlaylistEnded(false);
          } else {
            clearPlaylistConnectionTimer();
            setPlaylistStatus("idle");
            setPlaylistEnded(true);
          }
        } else if (state === "buffering") {
          setPlaylistStatus("connecting");
          armPlaylistConnectionTimer(generation);
        } else if (state === "unstarted" || state === "cued") {
          setPlaylistStatus((currentStatus) => (currentStatus === "playing" ? currentStatus : "idle"));
        }
      },
      onMixFallback: () => {
        if (generation !== youtubeGenerationRef.current) return;
        pushDebug("youtube:mixFallback", { videoId: youtubePlayerRef.current?.getVideoId() ?? null });
        setQueueTracks(null);
        setPlaylistPosition(null);
        if (playlistWantsPlaybackRef.current) armPlaylistConnectionTimer(generation);
        else { clearPlaylistConnectionTimer(); setPlaylistStatus("paused"); }
      },
      onAutoplayBlocked: () => {
        if (generation !== youtubeGenerationRef.current) return;
        clearPlaylistConnectionTimer();
        playlistWantsPlaybackRef.current = false;
        setPlaylistStatus("paused");
        setPlaylistError("Your browser paused automatic playback. Press Play to continue.");
        setResumeBlocked(true);
      },
      onError: (code) => {
        if (generation !== youtubeGenerationRef.current) return;
        clearPlaylistConnectionTimer();
        const player = youtubePlayerRef.current;
        pushDebug("youtube:onError", {
          code,
          player: Boolean(player),
          current: player?.getCurrent() ?? null,
          videoId: player?.getVideoId() ?? null
        });
        const current = player?.getCurrent();
        const failedTracks = failedPlaylistTracksRef.current;
        const alreadyFailed = current ? failedTracks.has(current.index) : false;
        if (current) failedTracks.add(current.index);
        if (!alreadyFailed && player && current && [100, 101, 150].includes(code) && current.total > 1 && failedTracks.size < Math.min(current.total, 5)) {
          player.next();
          player.play();
          armPlaylistConnectionTimer(generation);
          setPlaylistStatus("connecting");
        } else {
          setPlaylistStatus("unavailable");
          setPlaylistError(code === 101 || code === 150
            ? "YouTube playback is unavailable here. The video owner may have disabled embedded playback."
            : code === 100
              ? "YouTube playback is unavailable. This video may be private or removed."
              : code === 153
                ? "YouTube playback is unavailable. YouTube could not verify this embedded player."
                : "YouTube playback is unavailable. Try again or choose another playlist.");
        }
      }
    }, {
      autoplay: playImmediately,
      startIndex: storedProgress?.trackIndex ?? 0,
      startSeconds: storedProgress?.seconds ?? 0,
      startVideoId: storedProgress?.videoId ?? undefined
    }).then((player) => {
      if (generation !== youtubeGenerationRef.current) {
        player.destroy();
        return;
      }
      youtubePlayerRef.current = player;
      setHasPlaylistSession(true);
      player.setVolume(volumeRef.current);
      player.setLoop(true);
      if (storedProgress?.seconds) player.seekTo(storedProgress.seconds);
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
      clearPlaylistConnectionTimer();
      setPlaylistStatus("unavailable");
      setPlaylistError("YouTube playback is unavailable. Try again or choose another playlist.");
    });
  }, [armPlaylistConnectionTimer, clearPlaylistConnectionTimer, clearYoutubeStage, persistCurrentPlaylistProgress, playlistStatus, pushDebug, shouldPersistVolume, syncPlaylistTiming]);

  const togglePlaylistPlayback = useCallback(() => {
    const player = youtubePlayerRef.current;
    pushDebug("togglePlaylistPlayback", {
      status: playlistStatus,
      hasSession: hasPlaylistSession,
      player: Boolean(player),
      selectedLinkId,
      links: musicLinks.length
    });
    try {
      setResumeBlocked(false);
      setPlaylistError(null);
      if (playlistStatus === "unavailable") {
        const link = musicLinks.find((entry) => entry.id === selectedLinkId) ?? musicLinks[0];
        if (link) startPlaylist(link, true);
        return;
      }
      if (!player) {
        if (playlistStatus === "connecting") {
          youtubeGenerationRef.current += 1;
          clearPlaylistConnectionTimer();
          clearYoutubeStage();
          setPlaylistStatus("idle");
          setPlaylistTrack("Playback stopped");
          return;
        }
        const link = musicLinks.find((entry) => entry.id === selectedLinkId) ?? musicLinks[0];
        if (link) startPlaylist(link, true);
        return;
      }
      if (playlistStatus === "playing" || playlistStatus === "connecting") {
        clearPlaylistConnectionTimer();
        persistCurrentPlaylistProgress(player);
        playlistWantsPlaybackRef.current = false;
        player.pause();
        setPlaylistStatus("paused");
      } else {
        setPlaylistStatus("connecting");
        armPlaylistConnectionTimer();
        playlistWantsPlaybackRef.current = true;
        if (playlistEnded) {
          if (player.getCurrent().total > 1) player.playVideoAt(0);
          else player.seekTo(0);
          setPlaylistEnded(false);
        }
        player.play();
      }
    } catch (error) {
      pushDebug("togglePlaylistPlayback:ERROR", { message: error instanceof Error ? error.message : String(error) });
    }
  }, [armPlaylistConnectionTimer, clearPlaylistConnectionTimer, musicLinks, persistCurrentPlaylistProgress, playlistEnded, playlistStatus, pushDebug, selectedLinkId, startPlaylist]);

  const nextSong = useCallback(() => {
    const player = youtubePlayerRef.current;
    pushDebug("nextSong", {
      player: Boolean(player),
      ready: player?.isReady() ?? null,
      session: hasPlaylistSession,
      current: player?.getCurrent() ?? null,
      status: playlistStatus
    });
    if (!player) return;
    failedPlaylistTracksRef.current.clear();
    setPlaylistError(null);
    const current = player.getCurrent();
    if (activePlaylistTargetRef.current?.kind === "video" && current.total <= 1) {
      const currentIndex = musicLinks.findIndex((link) => link.id === activePlaylistLinkIdRef.current);
      if (currentIndex < 0 || musicLinks.length === 0) return;
      startPlaylist(musicLinks[(currentIndex + 1) % musicLinks.length]!, true);
      return;
    }
    setPlaylistStatus("connecting");
    armPlaylistConnectionTimer();
    if (current.total > 1 && current.index >= current.total) player.playVideoAt(0);
    else player.next();
    player.play();
  }, [armPlaylistConnectionTimer, hasPlaylistSession, musicLinks, playlistStatus, pushDebug, startPlaylist]);

  const previousSong = useCallback(() => {
    const player = youtubePlayerRef.current;
    pushDebug("previousSong", {
      player: Boolean(player),
      ready: player?.isReady() ?? null,
      session: hasPlaylistSession,
      current: player?.getCurrent() ?? null,
      status: playlistStatus
    });
    if (!player) return;
    failedPlaylistTracksRef.current.clear();
    setPlaylistError(null);
    const current = player.getCurrent();
    if (activePlaylistTargetRef.current?.kind === "video" && current.total <= 1) {
      const currentIndex = musicLinks.findIndex((link) => link.id === activePlaylistLinkIdRef.current);
      if (currentIndex < 0 || musicLinks.length === 0) return;
      startPlaylist(musicLinks[(currentIndex - 1 + musicLinks.length) % musicLinks.length]!, true);
      return;
    }
    setPlaylistStatus("connecting");
    armPlaylistConnectionTimer();
    if (current.total > 1 && current.index <= 1) player.playVideoAt(current.total - 1);
    else player.previous();
    player.play();
  }, [armPlaylistConnectionTimer, hasPlaylistSession, musicLinks, playlistStatus, pushDebug, startPlaylist]);

  const toggleLoop = useCallback(() => {
    const player = youtubePlayerRef.current;
    pushDebug("toggleLoop", {
      player: Boolean(player),
      ready: player?.isReady() ?? null,
      loop: loopEnabledRef.current,
      status: playlistStatus
    });
    if (!player) return;
    const next = !loopEnabledRef.current;
    // Best effort: the YouTube IFrame API frequently ignores setLoop(true)
    // mid-playback and getLoop() then reports stale values. Our own
    // "ended" state handler performs the actual playlist repeat, so the
    // ref below is the single source of truth for the UI.
    player.setLoop(next);
    loopEnabledRef.current = next;
    setLoopEnabled(next);
    window.setTimeout(() => {
      pushDebug("toggleLoop:ytreport", { desired: next, ytReports: player.getLoop(), effective: loopEnabledRef.current });
    }, 400);
  }, [playlistStatus, pushDebug]);

  const seekPlaylist = useCallback((seconds: number) => {
    const player = youtubePlayerRef.current;
    pushDebug("seekPlaylist", {
      player: Boolean(player),
      seconds,
      status: playlistStatus
    });
    if (!player) return;
    player.seekTo(seconds);
    setPlaylistTime(seconds);
    persistCurrentPlaylistProgress(player);
  }, [persistCurrentPlaylistProgress, playlistStatus, pushDebug]);

  const toggleQueue = useCallback(() => {
    const player = youtubePlayerRef.current;
    pushDebug("toggleQueue", {
      player: Boolean(player),
      open: queueOpen,
      hasSession: hasPlaylistSession,
      status: playlistStatus
    });
    setQueueOpen((open) => !open);
  }, [hasPlaylistSession, playlistStatus, pushDebug, queueOpen]);

  const playQueueTrack = useCallback((index: number) => {
    const queueTrack = queueTracks?.[index];
    if (!queueTrack) return;
    if (queueTrack.kind === "library") {
      const link = musicLinks.find((entry) => entry.id === queueTrack.linkId);
      if (link) startPlaylist(link, true);
      return;
    }
    const player = youtubePlayerRef.current;
    failedPlaylistTracksRef.current.clear();
    setPlaylistError(null);
    pushDebug("playQueueTrack", {
      player: Boolean(player),
      index,
      status: playlistStatus
    });
    if (!player) return;
    player.playVideoAt(index);
    player.play();
    setPlaylistStatus("connecting");
    armPlaylistConnectionTimer();
  }, [armPlaylistConnectionTimer, musicLinks, playlistStatus, pushDebug, queueTracks, startPlaylist]);

  const switchSource = useCallback((next: MusicSource) => {
    pushDebug("switchSource", { next, current: source, status: playlistStatus });
    if (next === source) return;
    if (next === "radio") {
      stopPlaylist();
    } else {
      disconnect();
    }
    setSource(next);
  }, [disconnect, pushDebug, source, stopPlaylist, playlistStatus]);

  const lastControlVolume = useRef(0.5);
  const directPlaybackState = useRef({ status, playlistStatus, source });
  directPlaybackState.current = { status, playlistStatus, source };
  useEffect(() => {
    if (!activeRoomId) return;
    return registerRoomPlaybackTarget("vibe-music", { roomId: activeRoomId, kind: "MUSIC",
      playing: source === "playlist" ? playlistStatus === "playing" : status === "playing",
      async control(command) {
        if (command.operation === "volume" || command.operation === "mute" || command.operation === "unmute") {
          const read=()=>source==="playlist"?youtubePlayerRef.current?.getVolume?.()??null:audioRef.current?.volume??null;
          const prior=read();if(prior===null)return false;
          if(command.operation==="mute"&&prior>0)lastControlVolume.current=prior;
          const next=command.operation==="mute"?0:command.operation==="unmute"?lastControlVolume.current:(command.value??50)/100;
          setVolume(next);if(audioRef.current)audioRef.current.volume=next;youtubePlayerRef.current?.setVolume(next);
          const until=Date.now()+2000;
          while(Date.now()<until){if(Math.abs((read()??-1)-next)<0.01)return true;await new Promise(r=>setTimeout(r,50));}return false;
        }
        if(command.operation === "seek") {
          const player=youtubePlayerRef.current;if(source!=="playlist"||!player?.isReady())return false;
          const position=command.value??0;player.seekTo(position);const until=Date.now()+3000;
          while(Date.now()<until){if(Math.abs(player.getCurrentTime()-position)<3)return true;await new Promise(r=>setTimeout(r,50));}return false;
        }
        return this.run({type:"MUSIC",action:command.operation.toUpperCase() as "PLAY"|"PAUSE"|"NEXT"|"PREVIOUS",target:"AUTO"});
      },
      async run(command) {
        onOpenChange(true);
        if (command.action === "NEXT" || command.action === "PREVIOUS") {
          if (source !== "playlist" || !youtubePlayerRef.current?.isReady()) return false;
          const before=youtubePlayerRef.current.getVideoId();
          if (command.action === "NEXT") nextSong(); else previousSong();
          const until=Date.now()+4000;
          while(Date.now()<until){const after=youtubePlayerRef.current?.getVideoId();if(after&&after!==before)return true;await new Promise(r=>setTimeout(r,50));}return false;
        }
        if (source === "playlist") {
          if (command.action === "PLAY" && playlistStatus !== "playing") togglePlaylistPlayback();
          if (command.action === "PAUSE") youtubePlayerRef.current?.pause();
        } else {
          if (command.action === "PLAY" && status !== "playing") startPlayback();
          if (command.action === "PAUSE") disconnect();
        }
        const until = Date.now() + 8000;
        while (Date.now() < until) {
          const state = directPlaybackState.current;
          const playing = state.source === "playlist" ? state.playlistStatus === "playing" : state.status === "playing";
          if (playing === (command.action === "PLAY")) return true;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
      }
    });
  }, [activeRoomId, source, status, playlistStatus, onOpenChange, nextSong, previousSong, togglePlaylistPlayback, startPlayback, disconnect]);

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
      const current = player.getCurrent();
      if (current.title) setPlaylistTrack(current.title);
      setPlaylistPosition((position) => position?.index === current.index && position.total === current.total ? position : { index: current.index, total: current.total });
      setCurrentVideoId(player.getVideoId());
      persistCurrentPlaylistProgress(player);
    }, PLAYLIST_PROGRESS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [persistCurrentPlaylistProgress, source, playlistStatus, syncPlaylistTiming]);

  useEffect(() => {
    if (!queueOpen || !hasPlaylistSession) return;
    let cancelled = false;
    let retryTimer: number | null = null;
    let retries = 0;
    const controllers = new Set<AbortController>();
    const loadQueue = () => {
      if (cancelled) return;
      const ids = youtubePlayerRef.current?.getPlaylistIds() ?? [];
      if (ids.length <= 1 && activePlaylistTargetRef.current?.kind === "video") {
        setQueueTracks(musicLinks.map((link) => ({ kind: "library", linkId: link.id, title: link.title })));
        return;
      }
      if (ids.length === 0 && retries++ < 6) {
        retryTimer = window.setTimeout(loadQueue, 1000);
        return;
      }
      // Show usable queue controls immediately; hydrate titles with bounded requests.
      setQueueTracks(ids.map((videoId, index) => ({ kind: "youtube", videoId, title: `Track ${index + 1}` })));
      let nextIndex = 0;
      const loadTitles = async () => {
        while (!cancelled && nextIndex < ids.length) {
          const index = nextIndex++;
          const videoId = ids[index]!;
          const controller = new AbortController();
          controllers.add(controller);
          const timeout = window.setTimeout(() => controller.abort(), YOUTUBE_OEMBED_TIMEOUT_MS);
          try {
            const response = await fetch(
              `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
              { signal: controller.signal, credentials: "omit" }
            );
            if (!response.ok) continue;
            const data = await response.json() as { title?: unknown };
            const title = normalizeMetadataText(data.title, MAX_TRACK_CODE_POINTS);
            if (!cancelled && title) setQueueTracks((tracks) => tracks?.map((track, position) => position === index ? { ...track, title } : track) ?? null);
          } catch {
            // Positional titles and playback controls remain usable without metadata.
          } finally {
            window.clearTimeout(timeout);
            controllers.delete(controller);
          }
        }
      };
      for (let worker = 0; worker < Math.min(4, ids.length); worker++) void loadTitles();
    };
    loadQueue();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      controllers.forEach((controller) => controller.abort());
    };
  }, [queueOpen, hasPlaylistSession, musicLinks, selectedLinkId, playlistPosition?.total]);

  useEffect(() => {
    if (!shouldPersistVolume || runtime.kind !== "live") return;
    const save = () => {
      persistCurrentPlaylistProgress(youtubePlayerRef.current);
      const playing = source === "radio" ? status === "playing" || status === "connecting" : playlistStatus === "playing" || playlistStatus === "connecting";
      try {
        runtime.platform.sessionStorage.setItem(VIBE_MUSIC_PLAYBACK_STORAGE_KEY, JSON.stringify({ source, playing, linkId: selectedLinkId, savedAt: Date.now() } satisfies SavedMusicPlayback));
      } catch {
        // Music remains usable when session storage is unavailable.
      }
    };
    save();
    const timer = window.setInterval(save, 1000);
    window.addEventListener("pagehide", save);
    return () => { window.clearInterval(timer); window.removeEventListener("pagehide", save); };
  }, [persistCurrentPlaylistProgress, playlistStatus, runtime, selectedLinkId, shouldPersistVolume, source, status]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      wantsPlaybackRef.current = false;
      generationRef.current += 1;
      disposeActiveAttempt();
      persistCurrentPlaylistProgress(youtubePlayerRef.current);
      youtubeGenerationRef.current += 1;
      clearPlaylistConnectionTimer();
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      activePlaylistTargetRef.current = null;
      clearYoutubeStage();
      if (!audio?.hasAttribute("src")) return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [clearPlaylistConnectionTimer, clearYoutubeStage, disposeActiveAttempt, persistCurrentPlaylistProgress]);

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
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

    const isRadio = source === "radio";
    const isPlaying = isRadio ? status === "playing" : playlistStatus === "playing";
    const isConnecting = isRadio ? status === "connecting" : playlistStatus === "connecting";
    const title = isRadio ? track : (playlistTrack || "YouTube Playlist");
    const artist = isRadio ? "Code Radio" : "Vibe Music";

    try {
      if (typeof MediaMetadata !== "undefined") {
        navigator.mediaSession.metadata = new MediaMetadata({
          title,
          artist,
          album: "Space App",
          artwork: [
            { src: "/brand/space-logo-2048.png", sizes: "512x512", type: "image/png" },
            { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }
          ]
        });
      }
      navigator.mediaSession.playbackState = isPlaying
        ? "playing"
        : (isConnecting ? "none" : "paused");

      navigator.mediaSession.setActionHandler("play", () => {
        if (source === "radio") {
          startPlayback();
        } else {
          playlistWantsPlaybackRef.current = true;
          setPlaylistError(null);
          setPlaylistStatus("connecting");
          armPlaylistConnectionTimer();
          youtubePlayerRef.current?.play();
        }
      });

      navigator.mediaSession.setActionHandler("pause", () => {
        if (source === "radio") {
          disconnect();
        } else {
          playlistWantsPlaybackRef.current = false;
          youtubePlayerRef.current?.pause();
          setPlaylistStatus("paused");
        }
      });

      if (source === "playlist") {
        navigator.mediaSession.setActionHandler("previoustrack", () => {
          previousSong();
        });
        navigator.mediaSession.setActionHandler("nexttrack", () => {
          nextSong();
        });
      } else {
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
      }
    } catch {
      // MediaSession might fail in restricted execution contexts
    }

    return () => {
      try {
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
      } catch {}
    };
  }, [
    armPlaylistConnectionTimer,
    disconnect,
    nextSong,
    playlistStatus,
    playlistTrack,
    previousSong,
    source,
    startPlayback,
    status,
    track
  ]);

  useEffect(() => {
    if (source !== "playlist") return;
    let disposed = false;
    let loaded = false;
    let request = 0;

    async function loadMusicLibraryLinks() {
      const current = ++request;
      if (!loaded) setMusicLinksLoading(true);
      try {
        const result = await api.links({ page: 1, pageSize: MUSIC_LIBRARY_LINKS_PAGE_SIZE });
        if (disposed || current !== request) return;
        loaded = true;
        const links = result.data.filter((link) => !deletedLinkIdsRef.current.has(link.id) && link.category === "MUSIC_LIBRARY" && parseYouTubeLink(link.url) !== null);
        setMusicLinks(links);
      } catch {
        if (!disposed && current === request && !loaded) setMusicLinks([]);
      } finally {
        if (!disposed && current === request) setMusicLinksLoading(false);
      }
    }

    void loadMusicLibraryLinks();
    window.addEventListener(USER_LINKS_UPDATED_EVENT, loadMusicLibraryLinks);
    return () => {
      disposed = true;
      window.removeEventListener(USER_LINKS_UPDATED_EVENT, loadMusicLibraryLinks);
    };
  }, [source]);

  useEffect(() => {
    if (
      !open ||
      source !== "playlist" ||
      musicLinksLoading ||
      musicLinks.length === 0 ||
      playlistStatus !== "idle" ||
      activePlaylistLinkIdRef.current !== null ||
      youtubePlayerRef.current
    ) return;
    const selectedLink = musicLinks.find((link) => link.id === selectedLinkId);
    if (selectedLink) {
      startPlaylist(selectedLink, false);
    }
  }, [musicLinks, musicLinksLoading, open, playlistStatus, selectedLinkId, source, startPlaylist]);

  useLayoutEffect(() => {
    if (!open || mobile) return;
    function updatePosition() {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!panel) return;
      // Autoplay recovery can open the panel before its menu trigger mounts.
      const triggerRect = trigger?.getBoundingClientRect() ?? {
        top: VIEWPORT_MARGIN_PX, bottom: VIEWPORT_MARGIN_PX, right: window.innerWidth - VIEWPORT_MARGIN_PX
      };
      const panelRect = panel.getBoundingClientRect();
      const width = panelRect.width || FALLBACK_PANEL_WIDTH_PX;
      const height = panelRect.height || FALLBACK_PANEL_HEIGHT_PX;
      const railPosition = railPopoverPosition(trigger, width);
      if (railPosition) {
        setPosition({ left: railPosition.left, top: Math.max(VIEWPORT_MARGIN_PX, window.innerHeight - railPosition.bottom - height), ready: true });
        return;
      }
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
    pushDebug("volume", { percent: nextPercent });
    setVolume(nextVolume);
    if (shouldPersistVolume) setSpaceVolume(nextVolume);
  }

  const isActive = status === "connecting" || status === "playing";
  const controlLabel = status === "unavailable" ? "Retry Code Radio" : isActive ? "Pause Code Radio" : "Play Code Radio";
  const isPlaylistActive = playlistStatus === "connecting" || playlistStatus === "playing";
  const playlistControlLabel = isPlaylistActive
    ? "Pause playlist"
    : playlistStatus === "unavailable"
      ? "Retry playlist"
      : "Play playlist";
  const selectedMusicLink = musicLinks.find((link) => link.id === selectedLinkId);
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
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement;
        const control = target.closest("button, input, select") as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | null;
        pushDebug("pointerdown", {
          tag: target.tagName.toLowerCase(),
          label: control?.getAttribute("aria-label") ?? target.textContent?.slice(0, 40) ?? "",
          disabled: control instanceof HTMLButtonElement ? control.disabled : undefined
        });
      }}
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
        <button type="button" className="vibe-music-close" aria-label="Close Vibe Music" onClick={() => { pushDebug("close", {}); onOpenChange(false); }}>
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
            {resumeBlocked ? <p className="vibe-music-error" role="status">Press Play to resume your music.</p> : null}
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
            {playlistError ? (
              <p className="vibe-music-error" role="alert">
                {playlistError}
                {playlistStatus === "unavailable" && selectedMusicLink ? <> <a href={selectedMusicLink.url} onClick={(event) => {
                  if (!onOpenYouTube) return;
                  event.preventDefault();
                  onOpenYouTube(selectedMusicLink.url);
                }}>Open in YouTube</a></> : null}
              </p>
            ) : null}
            {playlistStatus === "unsupported" ? <p className="vibe-music-error" role="alert">This link is not a YouTube playlist</p> : null}
            <div className="vibe-music-playlist-picker">
              <label className="vibe-music-playlist-picker-label" htmlFor="vibe-music-playlist-select">Playlist</label>
              <select
                id="vibe-music-playlist-select"
                aria-label="Music library playlist"
                value={selectedLinkId ?? ""}
                onChange={(event) => {
                  const linkId = event.currentTarget.value || null;
                  const link = musicLinks.find((entry) => entry.id === linkId);
                  pushDebug("selectPlaylist", { linkId, found: Boolean(link), url: link?.url ?? null });
                  setSelectedLinkId(linkId);
                  if (link) startPlaylist(link, playlistStatus === "playing" || playlistStatus === "connecting");
                }}
              >
                <option value="">Select a playlist…</option>
                {musicLinks.map((link) => (
                  <option key={link.id} value={link.id}>{link.title}</option>
                ))}
              </select>
              <button
                type="button"
                className="vibe-music-player-aux vibe-music-delete-link"
                aria-label="Delete selected playlist link"
                title="Delete selected playlist link"
                disabled={!selectedMusicLink || deletingLink}
                onClick={() => void deleteSelectedLink()}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
            {linkDeleteError ? <p className="vibe-music-error" role="alert">{linkDeleteError}</p> : null}
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
                <strong title={playlistTrack} data-testid="vibe-music-playlist-track">{playlistTrack}</strong>
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
                        const active = queueTrack.kind === "library"
                          ? queueTrack.linkId === activePlaylistLinkIdRef.current
                          : index === (playlistPosition ? playlistPosition.index - 1 : -1);
                        const queueKey = queueTrack.kind === "library"
                          ? `library-${queueTrack.linkId}`
                          : `youtube-${queueTrack.videoId}`;
                        return (
                          <li key={`${queueKey}-${index}`} className={active ? "vibe-music-queue-row is-active" : "vibe-music-queue-row"}>
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
        <label className="vibe-music-volume" title="Controls all Space audio, including YouTube panes">
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
        {debugEnabled && source === "playlist" ? (
          <div className="vibe-music-debug" data-testid="vibe-music-debug">
            <div className="vibe-music-debug-bar">
              <span className="vibe-music-debug-label">Player debug (live)</span>
              <button type="button" className="vibe-music-debug-copy" aria-label="Copy debug log" onClick={copyDebugLog}>
                {debugCopied ? "Copied ✓" : "Copy"}
              </button>
            </div>
            <pre>{debugLog.length > 0 ? debugLog.join("\n") : "No events yet — press the player buttons."}</pre>
          </div>
        ) : null}
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
