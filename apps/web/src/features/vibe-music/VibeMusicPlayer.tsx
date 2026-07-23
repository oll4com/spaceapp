import { ExternalLink, Pause, Play, Radio, RefreshCw, Volume2, X } from "lucide-react";
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
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import "./vibe-music.css";

export const CODE_RADIO_PRIMARY_STREAM_URL = "https://coderadio-admin-v2.freecodecamp.org/listen/coderadio/radio.mp3";
export const CODE_RADIO_FALLBACK_STREAM_URL = "https://coderadio-admin-v2.freecodecamp.org/listen/coderadio/low.mp3";
export const CODE_RADIO_METADATA_URL = "https://coderadio-admin-v2.freecodecamp.org/api/nowplaying_static/coderadio.json";
export const CODE_RADIO_ATTRIBUTION_URL = "https://coderadio.freecodecamp.org/";
export const VIBE_MUSIC_VOLUME_STORAGE_KEY = "space.vibeMusic.volume";
export const VIBE_MUSIC_PANEL_ID = "vibe-music-player";

const DEFAULT_VOLUME = 0.35;
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

type PlaybackStatus = "idle" | "connecting" | "playing" | "unavailable";

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

export function VibeMusicPlayer({ mobile, open, onOpenChange, persistVolume: shouldPersistVolume = true, roomTheme, triggerRef }: VibeMusicPlayerProps) {
  const runtime = getSpaceRuntime();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const primaryControlRef = useRef<HTMLButtonElement | null>(null);
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

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      wantsPlaybackRef.current = false;
      generationRef.current += 1;
      disposeActiveAttempt();
      if (!audio?.hasAttribute("src")) return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [disposeActiveAttempt]);

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
        <button type="button" className="vibe-music-close" aria-label="Close Vibe Music" onClick={() => onOpenChange(false)}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="vibe-music-content">
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
        <a className="vibe-music-attribution" href={runtime.platform.resolveExternalResource(CODE_RADIO_ATTRIBUTION_URL) ?? "#"} target="_blank" rel="noreferrer">
          freeCodeCamp Code Radio <ExternalLink aria-hidden="true" />
        </a>
      </div>
    </section>
  ) : null;

  return (
    <>
      <audio ref={audioRef} data-vibe-music-audio="" preload="none" aria-hidden="true" />
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
