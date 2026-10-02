import { useEffect, useRef } from "react";
import type { YouTubePlayback } from "../features/browser-pane/youtube-playback.js";
import type { YouTubeNativePlayerHandle } from "../features/browser-pane/YouTubeNativePlayer.js";

export function YouTubeNativePlayer({ initial, onProgress, onPlayingChange, playerRef, autoPlay = false }: {
  initial: YouTubePlayback; onProgress: (value: YouTubePlayback) => void;
  onPlayingChange?: (playing: boolean) => void; autoPlay?: boolean; playbackKey?: string;
  playerRef?: React.MutableRefObject<YouTubeNativePlayerHandle | null>;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const latest = useRef({ initial, onProgress, onPlayingChange });
  latest.current = { initial, onProgress, onPlayingChange };
  useEffect(() => {
    if (!playerRef) return;
    const play = () => { void ref.current?.play().catch(() => undefined); };
    playerRef.current = {
      currentVideo: () => ({ videoId: initial.videoId || "SpacePromo1", title: "Discover Space" }),
      play, pause: () => ref.current?.pause(), togglePlay: () => ref.current?.paused ? play() : ref.current?.pause(),
      previous: () => { if (ref.current) ref.current.currentTime = 0; }, next: () => { if (ref.current) ref.current.currentTime = 0; },
      hasPlaylist: () => Boolean(initial.playlistId),
      seek: seconds => { if (!ref.current) return false; ref.current.currentTime = Math.max(0, Math.min(ref.current.duration || 20, seconds)); return true; },
      volume: percent => { if (!ref.current) return false; ref.current.volume = Math.max(0, Math.min(1, percent / 100)); return true; },
      volumeLevel: () => ref.current ? ref.current.volume * 100 : null,
      position: () => ref.current?.currentTime ?? null
    };
    return () => { playerRef.current = null; };
  }, [playerRef, initial.videoId, initial.playlistId]);
  return <video ref={ref} data-demo-video="true" controls playsInline autoPlay={autoPlay}
    src={`${import.meta.env.BASE_URL}demo/media/discover-space.mp4`} poster={`${import.meta.env.BASE_URL}demo/media/discover-space.jpg`}
    style={{ width: "100%", height: "100%", objectFit: "contain", background: "#080d16" }}
    onLoadedMetadata={() => { if (ref.current && initial.seconds < ref.current.duration) ref.current.currentTime = initial.seconds; }}
    onPlay={() => latest.current.onPlayingChange?.(true)} onPause={() => latest.current.onPlayingChange?.(false)}
    onTimeUpdate={() => { if (ref.current) latest.current.onProgress({ ...latest.current.initial, seconds: ref.current.currentTime, title: "Discover Space", updatedAt: Date.now() }); }} />;
}
