import { useEffect, useState } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  registerRoomPlaybackTarget,
  waitForRoomPlaybackTarget,
  type PlaybackTarget
} from "../room-agent/room-playback-control.js";

// Lightweight Vibe Music state that must be available before the player code
// is loaded. The player itself is lazy-loaded on first use.
export const VIBE_MUSIC_PLAYBACK_STORAGE_KEY = "space.vibeMusic.playback.v1";
export const VIBE_MUSIC_PANEL_ID = "vibe-music-player";
export const VIBE_MUSIC_PLAYBACK_TARGET_ID = "vibe-music";

type VibeMusicSource = "radio" | "playlist";

export type SavedMusicPlayback = { source: VibeMusicSource; playing: boolean; linkId: string | null; savedAt: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readReloadPlayback(enabled: boolean): SavedMusicPlayback | null {
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
    return { source: value.source as VibeMusicSource, playing: value.playing, linkId, savedAt: value.savedAt };
  } catch {
    return null;
  }
}

/**
 * Decide when the Vibe Music player must be mounted. It mounts on first open
 * and then stays mounted so playback survives closing the panel. It also
 * mounts immediately after a reload that has a session to restore, and when a
 * Room Agent playback command targets it; until then a lightweight proxy keeps
 * the "vibe-music" playback target available to the Room Agent.
 */
export function useVibeMusicMount(activeRoomId: string | undefined, requested: boolean): boolean {
  const [mounted, setMounted] = useState(() => readReloadPlayback(true) !== null);
  const shouldMount = mounted || requested;

  useEffect(() => {
    if (requested && !mounted) setMounted(true);
  }, [mounted, requested]);

  useEffect(() => {
    if (shouldMount || !activeRoomId) return;
    const roomId = activeRoomId;
    const activate = () => {
      setMounted(true);
      return waitForRoomPlaybackTarget(VIBE_MUSIC_PLAYBACK_TARGET_ID, roomId, proxy);
    };
    const proxy: PlaybackTarget = {
      roomId,
      kind: "MUSIC",
      playing: false,
      async control(command) {
        const target = await activate();
        if (!target) return false;
        if (target.control) return target.control(command);
        return ["play", "pause", "next", "previous"].includes(command.operation)
          ? target.run({ type: "MUSIC", action: command.operation.toUpperCase() as "PLAY" | "PAUSE" | "NEXT" | "PREVIOUS", target: "AUTO" })
          : false;
      },
      async run(command) {
        const target = await activate();
        return target ? target.run(command) : false;
      }
    };
    return registerRoomPlaybackTarget(VIBE_MUSIC_PLAYBACK_TARGET_ID, proxy);
  }, [activeRoomId, shouldMount]);

  return shouldMount;
}
