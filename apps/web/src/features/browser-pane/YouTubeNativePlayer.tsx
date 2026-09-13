import { getSpaceVolume, subscribeSpaceVolume } from '../../space-audio.js';
import { useEffect, useRef, useState } from 'react';
import { loadYouTubeIframeApi } from '../vibe-music/youtubePlaylistPlayer.js';
import type { YouTubePlayback } from './youtube-playback.js';

type Player = InstanceType<Awaited<ReturnType<typeof loadYouTubeIframeApi>>['Player']>;

export interface YouTubeNativePlayerHandle {
  currentVideo: () => { videoId: string; title: string } | null;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  previous: () => void;
  next: () => void;
  hasPlaylist: () => boolean;
  seek: (seconds:number) => boolean;
  volume: (percent:number) => boolean;
  volumeLevel: () => number|null;
  position: () => number | null;
}

export function YouTubeNativePlayer({
  autoPlay = false,
  initial,
  onProgress,
  playbackKey,
  onPlayingChange,
  playerRef
}: {
  autoPlay?: boolean;
  playbackKey?: string;
  initial: YouTubePlayback;
  onProgress: (value: YouTubePlayback) => void;
  onPlayingChange?: (playing: boolean) => void;
  playerRef?: React.MutableRefObject<YouTubeNativePlayerHandle | null>;
}) {
  const [reloadIntent] = useState(() => {
    if (!playbackKey) return false;
    try {
      const key = playbackKey + ':reload';
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return navigation?.type === 'reload' && saved?.playing === true && Date.now() - saved.savedAt >= 0 && Date.now() - saved.savedAt < 60000;
    } catch { return false; }
  });
  const pendingReload = useRef(reloadIntent);
  const playing = useRef(false);
  const resumeRef = useRef(initial);
  const previousInitial = useRef(initial);
  if (previousInitial.current !== initial) { resumeRef.current = initial; previousInitial.current = initial; }
  const container = useRef<HTMLDivElement>(null);
  const progress = useRef(onProgress);
  progress.current = onProgress;
  const activePlayer = useRef<Player | null>(null);
  const playerReadyRef = useRef<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!playerRef) return;
    playerRef.current = {
      seek(seconds) {
        if(!playerReadyRef.current||!activePlayer.current)return false;
        activePlayer.current.seekTo(seconds,true);return true;
      },
      volume(percent) {
        if(!playerReadyRef.current||!activePlayer.current)return false;
        activePlayer.current.setVolume(Math.max(0,Math.min(100,percent)));return true;
      },
      volumeLevel() {
        if(!playerReadyRef.current||!activePlayer.current)return null;
        return activePlayer.current.getVolume?.()??null;
      },
      position() {
        if(!playerReadyRef.current||!activePlayer.current)return null;
        return activePlayer.current.getCurrentTime();
      },
      currentVideo() {
        if (!playerReadyRef.current || !activePlayer.current) return null;
        try {
          const data = activePlayer.current.getVideoData();
          return /^[\w-]{11}$/.test(data.video_id ?? '')
            ? { videoId: data.video_id!, title: (data.title ?? '').slice(0, 500) } : null;
        } catch { return null; }
      },
      play() {
        if (!playerReadyRef.current || !activePlayer.current) return;
        activePlayer.current.playVideo();
      },
      pause() {
        if (!playerReadyRef.current || !activePlayer.current) return;
        activePlayer.current.pauseVideo();
      },
      togglePlay() {
        if (!playerReadyRef.current || !activePlayer.current) return;
        if (playing.current) {
          activePlayer.current.pauseVideo();
        } else {
          activePlayer.current.playVideo();
        }
      },
      previous() {
        if (!playerReadyRef.current || !activePlayer.current) return;
        const list = activePlayer.current.getPlaylist?.() ?? [];
        const index = activePlayer.current.getPlaylistIndex?.() ?? 0;
        if (Array.isArray(list) && list.length > 1) {
          if (index <= 0) {
            activePlayer.current.playVideoAt?.(list.length - 1);
          } else {
            activePlayer.current.previousVideo?.();
          }
          activePlayer.current.playVideo?.();
        } else {
          activePlayer.current.seekTo?.(0, true);
          activePlayer.current.playVideo?.();
        }
      },
      next() {
        if (!playerReadyRef.current || !activePlayer.current) return;
        const list = activePlayer.current.getPlaylist?.() ?? [];
        const index = activePlayer.current.getPlaylistIndex?.() ?? 0;
        if (Array.isArray(list) && list.length > 1) {
          if (index >= list.length - 1) {
            activePlayer.current.playVideoAt?.(0);
          } else {
            activePlayer.current.nextVideo?.();
          }
          activePlayer.current.playVideo?.();
        } else {
          activePlayer.current.seekTo?.(0, true);
          activePlayer.current.playVideo?.();
        }
      },
      hasPlaylist() {
        if (!playerReadyRef.current || !activePlayer.current) return Boolean(initial.playlistId);
        const list = activePlayer.current.getPlaylist?.() ?? [];
        return Array.isArray(list) && list.length > 1;
      }
    };
    return () => {
      if (playerRef) playerRef.current = null;
    };
  }, [playerRef, initial.playlistId]);

  useEffect(() => {
    const unsubscribeVolume = subscribeSpaceVolume(volume => {
      if (playerReady) player?.setVolume(volume * 100);
    });
    const restore = resumeRef.current;
    let confirmedPosition = restore.seconds === 0;
    let disposed = false;
    let player: Player | null = null;
    let playerReady = false;
    let timer: number | null = null;
    setReady(false);
    setError(null);
    const save = () => {
      if (!playerReady || !player) return;
      try {
        const data = player.getVideoData();
        const seconds = player.getCurrentTime();
        if (!data.video_id || !/^[\w-]{11}$/.test(data.video_id) || !Number.isFinite(seconds)) return;
        if (!confirmedPosition && seconds === 0 && data.video_id === restore.videoId) return;
        confirmedPosition = true;
        const index = player.getPlaylistIndex();
        const value = { ...restore, videoId: data.video_id,
          index: Number.isInteger(index) && index >= 0 ? index : restore.index,
          seconds: Math.max(0, seconds), title: (data.title ?? '').slice(0, 500), updatedAt: Date.now() };
        if (previousInitial.current === restore) {
          resumeRef.current = value;
        }
        progress.current(value);
      } catch { /* The iframe may be navigating to the next video. */ }
    };
    const onVisibility = () => { if (document.hidden) save(); };
    document.addEventListener('visibilitychange', onVisibility);
    const pagehide = () => {
      save();
      if (!playbackKey) return;
      try { sessionStorage.setItem(playbackKey + ':reload', JSON.stringify({ playing: playing.current, savedAt: Date.now() })); } catch {}
    };
    window.addEventListener('pagehide', pagehide);
    const stage = document.createElement('div');
    container.current?.replaceChildren(stage);
    void loadYouTubeIframeApi().then((yt) => {
      if (disposed || !stage.isConnected) return;
      player = new yt.Player(stage, {
        width: 1280, height: 720, videoId: restore.videoId || undefined,
        playerVars: {
          autoplay: autoPlay || pendingReload.current ? 1 : 0, controls: 1, fs: 1, playsinline: 1, rel: 0,
          origin: window.location.origin, start: Math.floor(restore.seconds),
          ...(restore.playlistId ? { listType: 'playlist', list: restore.playlistId, index: restore.index } : {})
        },
        events: {
          onReady: () => {
            if (disposed) return;
            playerReady = true;
            playerReadyRef.current = true;
            activePlayer.current = player;
            player?.setVolume(getSpaceVolume() * 100);
            try { player?.setLoop?.(true); } catch {}
            try { if (playbackKey) sessionStorage.removeItem(playbackKey + ':reload'); } catch {}
            setReady(true);
            // Preserve the saved point and restore playing intent only after a page reload.
            if (restore.seconds > 0) player?.seekTo(restore.seconds, true);
            if (autoPlay || pendingReload.current) {
              pendingReload.current = false;
              player?.playVideo();
              playing.current = true;
              onPlayingChange?.(true);
            }
            save();
            timer = window.setInterval(save, 1000);
          },
          onStateChange: (event) => {
            if (disposed) return;
            if (event.data === 1) {
              playing.current = true;
              onPlayingChange?.(true);
            }
            if (event.data === 0 || event.data === 2) {
              playing.current = false;
              onPlayingChange?.(false);
            }
            if (event.data === 0) {
              const list = player?.getPlaylist?.() ?? [];
              const index = player?.getPlaylistIndex?.() ?? 0;
              if (Array.isArray(list) && list.length > 1 && (index >= list.length - 1 || index < 0)) {
                player?.playVideoAt?.(0);
                player?.playVideo?.();
              }
            }
            if (event.data === 0 || event.data === 1 || event.data === 2) save();
          },
          onAutoplayBlocked: () => { if (!disposed) setError('Press Play in the video to continue.'); },
          onError: (event) => {
            if (disposed) return;
            const code = event.data ?? 0;
            setError([101, 150, 152].includes(code)
              ? 'This video cannot play in an embedded player. Use Browse YouTube to watch it with your saved pane account.'
              : `YouTube could not play this video (${code}). Retry or use Browse YouTube.`);
          }
        }
      });
    }).catch(() => { if (!disposed) setError('YouTube player could not connect. Retry when your connection is available.'); });
    return () => {
      save();
      disposed = true;
      unsubscribeVolume();
      activePlayer.current = null;
      playerReadyRef.current = false;
      onPlayingChange?.(false);
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', pagehide);
      try { player?.destroy(); } catch { /* The iframe may already be detached. */ }
      container.current?.replaceChildren();
    };
  }, [initial, generation, playbackKey]);

  return <div className="youtube-native-player" data-youtube-player-ready={ready}>
    <div ref={container} className="youtube-native-stage" />
    {!ready && !error ? <p className="youtube-player-loading" role="status">Loading YouTube…</p> : null}
    {error ? <div className="youtube-player-message" role="alert"><span>{error}</span>
      <button type="button" onClick={() => setGeneration((value) => value + 1)}>Retry player</button>
    </div> : null}
  </div>;
}
