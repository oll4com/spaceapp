import { registerRoomPlaybackTarget } from "../room-agent/room-playback-control.js";
import { Check, ChevronLeft, ChevronRight, Home, Maximize2, Music2, Pause, PictureInPicture2, Play, Plus, Users, Youtube } from "../ui-theme/app-icons.js";
import type { YouTubeAccounts } from "./youtube-accounts.js";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Pane, UserLink } from '@space/contracts';
import { api } from '../../api.js';
import type { UiTheme } from '../../ui-theme.js';
import { takeYouTubeBrowseIntent } from "./youtube-browse-intent.js";
import { ManagedYouTubeBrowser } from './ManagedYouTubeBrowser.js';
import { YouTubeNativePlayer, type YouTubeNativePlayerHandle } from './YouTubeNativePlayer.js';
import { parseYouTubePlayback, validYouTubePlayback, youtubePlaybackUrl, type YouTubePlayback } from './youtube-playback.js';
import { USER_LINKS_UPDATED_EVENT } from "../user-links/UserLinks.js";

interface YouTubePaneProps {
  pane: Pane;
  agentNumber: number;
  observerOnly?: boolean;
  uiTheme?: UiTheme;
  toolbarHidden?: boolean;
  onVideoTitleChange?: (title: string) => void;
  isFloating?: boolean;
  onToggleFloat?: () => void;
}

export function YouTubePane(props: YouTubePaneProps) {
  const { pane, observerOnly = false, toolbarHidden = false, onVideoTitleChange, isFloating = false, onToggleFloat } = props;
  const [accounts, setAccounts] = useState<YouTubeAccounts | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountSwitching, setAccountSwitching] = useState(false);
  const [accountRevision, setAccountRevision] = useState(0);
  const accountButton = useRef<HTMLButtonElement | null>(null);
  const accountMenu = useRef<HTMLDivElement | null>(null);
  const [accountPosition, setAccountPosition] = useState({ left: 8, top: 8, maxHeight: 320 });

  useEffect(() => {
    if (toolbarHidden || pane.isMinimized || pane.isClosed) setAccountMenuOpen(false);
  }, [toolbarHidden, pane.isMinimized, pane.isClosed]);

  useLayoutEffect(() => {
    if (!accountMenuOpen) return;
    const place = () => {
      const button = accountButton.current;
      if (!button) { setAccountMenuOpen(false); return; }
      const box = button.getBoundingClientRect();
      const width = Math.min(230, window.innerWidth - 16);
      const height = Math.min(accountMenu.current?.scrollHeight || 320, window.innerHeight - 16);
      const below = window.innerHeight - box.bottom - 14;
      const top = below >= height || below >= box.top - 14 ? box.bottom + 6 : Math.max(8, box.top - height - 6);
      setAccountPosition({ left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), top,
        maxHeight: Math.max(60, window.innerHeight - top - 8) });
    };
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !accountMenu.current?.contains(event.target) && !accountButton.current?.contains(event.target)) setAccountMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      setAccountMenuOpen(false); accountButton.current?.focus();
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !accountMenu.current?.contains(event.target)) setAccountMenuOpen(false);
    };
    place();
    accountMenu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', scroll, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (!accountButton.current?.getClientRects().length) setAccountMenuOpen(false);
      else place();
    });
    if (accountButton.current) observer?.observe(accountButton.current);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', scroll, true);
      observer?.disconnect();
    };
  }, [accountMenuOpen]);
  const [mode, setMode] = useState<'loading' | 'browse' | 'player'>('loading');
  const [initial, setInitial] = useState<YouTubePlayback | null>(null);
  const [playerRevision, setPlayerRevision] = useState(0);
  const [autoPlay, setAutoPlay] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const playerRef = useRef<YouTubeNativePlayerHandle | null>(null);
  const [targetUrl, setTargetUrl] = useState<string | undefined>();
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState('');
  const [reload, setReload] = useState(0);
  const latest = useRef<YouTubePlayback | null>(null);
  const localKey = useRef<string | null>(null);
  const queuedSave = useRef<YouTubePlayback | null>(null);
  const saving = useRef(false);
  const saveGeneration = useRef(0);
  const mounted = useRef(true);

  const [playlists, setPlaylists] = useState<UserLink[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>('');
  const [currentVideo, setCurrentVideo] = useState<{ videoId: string; title: string } | null>(null);
  const [addingToPlaylist, setAddingToPlaylist] = useState(false);
  const addingToPlaylistRef = useRef(false);
  const [addedVideoId, setAddedVideoId] = useState<string | null>(null);

  useEffect(() => {
    onVideoTitleChange?.(mode === 'player' ? currentVideo?.title ?? '' : '');
  }, [mode, currentVideo?.title, onVideoTitleChange]);

  async function addToPlaylist() {
    if (observerOnly || mode !== 'player' || addingToPlaylistRef.current) return;
    // Read the player at click time: autoplay may have just advanced the video.
    const video = playerRef.current?.currentVideo() ?? currentVideo;
    if (!video?.videoId) return;
    setCurrentVideo(video);
    addingToPlaylistRef.current = true;
    setAddingToPlaylist(true);
    setError(null);
    try {
      const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
      const existing = playlists.some(link => link.category === 'MUSIC_LIBRARY'
        && !parseYouTubePlayback(link.url)?.playlistId
        && parseYouTubePlayback(link.url)?.videoId === video.videoId);
      if (!existing) {
        const link = await api.createLink({ title: (video.title.trim() || `YouTube ${video.videoId}`).slice(0, 160),
          url: videoUrl, description: '', openMode: 'EMBEDDED', category: 'MUSIC_LIBRARY', isQuick: false });
        if (mounted.current) setPlaylists(items => [...items.filter(item => item.id !== link.id), link]);
        window.dispatchEvent(new Event(USER_LINKS_UPDATED_EVENT));
      }
      if (mounted.current) setAddedVideoId(video.videoId);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'The video could not be added to the playlist. Try again.');
    } finally {
      addingToPlaylistRef.current = false;
      if (mounted.current) setAddingToPlaylist(false);
    }
  }

  useEffect(() => {
    if (observerOnly || typeof api.youtubeAccounts !== 'function') return;
    let disposed = false;
    void api.youtubeAccounts(pane.id).then(value => { if (!disposed) setAccounts(value); }).catch(() => { if (!disposed) setAccounts(null); });
    return () => { disposed = true; };
  }, [pane.id, observerOnly]);

  useEffect(() => {
    if (observerOnly || typeof api.links !== 'function') return;
    let disposed = false;
    async function loadPlaylists() {
      try {
        const result = await api.links({ page: 1, pageSize: 100 });
        if (disposed) return;
        const list = Array.isArray(result?.data) ? result.data : [];
        const links = list.filter((link) =>
          (link.category === 'MUSIC_LIBRARY' || Boolean(parseYouTubePlayback(link.url)?.playlistId))
          && parseYouTubePlayback(link.url) !== null
        );
        setPlaylists(links);
      } catch {
        if (!disposed) setPlaylists([]);
      }
    }
    void loadPlaylists();
    window.addEventListener(USER_LINKS_UPDATED_EVENT, loadPlaylists);
    return () => {
      disposed = true;
      window.removeEventListener(USER_LINKS_UPDATED_EVENT, loadPlaylists);
    };
  }, [observerOnly]);

  async function selectAccount(profileId: string | null) {
    if (pending || accountSwitching) return;
    const previousMode = mode;
    setAccountMenuOpen(false); setAccountSwitching(true); setPending(true); setError(null); setMode('loading');
    try {
      const result = await api.selectYouTubeAccount(pane.id, profileId);
      if (!mounted.current) return;
      setAccounts(current => current ? { ...current, selectedProfileId: result.selectedProfileId } : current);
      setTargetUrl(result.targetUrl);
      setAccountRevision(value => value + 1);
      setMode('browse');
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : 'The Google account could not be selected.'); setMode(previousMode); }
    } finally { if (mounted.current) { setPending(false); setAccountSwitching(false); } }
  }
  const selectedAccountName = accounts?.selectedProfileId
    ? accounts.profiles.find(profile => profile.profileId === accounts.selectedProfileId)?.displayName ?? 'Unavailable account'
    : 'Saved pane account';

  function save(value: YouTubePlayback) {
    if (observerOnly || !validYouTubePlayback(value)) return;
    if (latest.current?.videoId !== value.videoId) {
      setUrl(youtubePlaybackUrl(value));
    }
    latest.current = value;
    setCurrentVideo(current => current?.videoId === value.videoId && current.title === value.title
      ? current : { videoId: value.videoId, title: value.title });
    let cached = false;
    try {
      if (localKey.current) { localStorage.setItem(localKey.current, JSON.stringify(value)); cached = true; }
    } catch { /* Server persistence still works when local storage is unavailable. */ }
    ++saveGeneration.current;
    queuedSave.current = value;
    if (saving.current) return;
    saving.current = true;
    void (async () => {
      try {
        while (queuedSave.current) {
          const next = queuedSave.current;
          queuedSave.current = null;
          const generation = saveGeneration.current;
          try {
            await api.saveYouTubePlayback(pane.id, next);
            if (mounted.current && generation === saveGeneration.current) setSaveState('Progress saved');
          } catch {
            if (mounted.current && generation === saveGeneration.current) setSaveState(cached ? 'Saved on this device · sync pending' : 'Progress could not be saved');
          }
        }
      } finally { saving.current = false; }
    })();
  }

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    setMode('loading');
    setError(null);
    const load = async () => {
      if (observerOnly) { setMode('browse'); return; }
      try {
        const me = await api.me();
        if (disposed) return;
        if (!me.user?.id) throw new Error('Sign in to Space to restore YouTube.');
        localKey.current = `space.youtube.playback.v1:${me.user.id}:${pane.id}`;
        const browseUrl = takeYouTubeBrowseIntent(pane.id);
        if (browseUrl) {
          setTargetUrl(browseUrl);
          setUrl(browseUrl);
          setMode('browse');
          return;
        }
        let cached: YouTubePlayback | null = null;
        try {
          const parsed: unknown = JSON.parse(localStorage.getItem(localKey.current) ?? 'null');
          if (validYouTubePlayback(parsed)) cached = parsed;
        } catch { /* Missing or invalid cache is ignored. */ }
        const { playback } = await api.youtubePlayback(pane.id);
        if (disposed) return;
        const stored = validYouTubePlayback(playback) ? playback : null;
        const restored = cached && (!stored || cached.updatedAt > stored.updatedAt) ? cached : stored;
        if (restored) {
          // A restored player owns no managed Chrome process, even after a tab crash.
          await api.stopBrowserSession(pane.id);
          if (disposed) return;
          latest.current = restored;
          setInitial(restored);
          setUrl(youtubePlaybackUrl(restored));
          setMode('player');
          save(restored);
        } else setMode('browse');
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : 'YouTube could not restore.');
      }
    };
    void load();
    return () => { disposed = true; mounted.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, observerOnly, reload]);

  useEffect(() => {
    if (mode !== 'loading' || !error || !/UPSTREAM_UNAVAILABLE|BROWSER_HOST_UNAVAILABLE|network|fetch|502|503/i.test(error)) return;
    const timer = window.setTimeout(() => setReload((value) => value + 1), 5000);
    return () => window.clearTimeout(timer);
  }, [mode, error]);

  async function playLink(targetUrl?: string) {
    const nextUrl = (typeof targetUrl === 'string' ? targetUrl : url).trim();
    const parsed = parseYouTubePlayback(nextUrl);
    if (!parsed) { setError('Enter a YouTube video or playlist link.'); return; }
    setUrl(nextUrl);
    setPending(true); setError(null);
    try {
      await api.stopBrowserSession(pane.id);
      latest.current = parsed;
      setInitial(parsed);
      setAutoPlay(true);
      setIsPlaying(true);
      setPlayerRevision(r => r + 1);
      setMode('player');
      save(parsed);
    } catch { setError('The YouTube browser could not stop. Retry to release its resources before playing.'); }
    finally { setPending(false); }
  }

  async function selectPlaylist(linkId: string) {
    if (pending || mode === 'loading') return;
    setSelectedPlaylistId(linkId);
    const chosen = playlists.find(item => item.id === linkId);
    if (!chosen) return;
    await playLink(chosen.url);
  }

  const currentPlaylistId = playlists.find(p => p.id === selectedPlaylistId && p.url === url)?.id
    ?? playlists.find(p => p.url === url || (Boolean(url) && Boolean(parseYouTubePlayback(p.url)?.playlistId) && parseYouTubePlayback(p.url)?.playlistId === parseYouTubePlayback(url)?.playlistId))?.id
    ?? '';

  async function watchCurrent() {
    setPending(true); setError(null);
    try {
      const pages = await api.browserPages(pane.id);
      const current = pages.pages.find((page) => page.isActive);
      if (!current?.url || !parseYouTubePlayback(current.url)) {
        setError('Select a video in YouTube first, then choose Play current video.'); return;
      }
      const stopped = await api.watchYouTube(pane.id);
      const parsed = parseYouTubePlayback(stopped.currentUrl ?? current.url);
      if (!parsed) throw new Error('The selected video could not be opened.');
      latest.current = parsed; setInitial(parsed); setAutoPlay(true); setIsPlaying(true); setPlayerRevision(r => r + 1); setUrl(youtubePlaybackUrl(parsed)); setMode('player'); save(parsed);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The selected video could not be opened.'); }
    finally { setPending(false); }
  }

  function browse() {
    if (latest.current) setTargetUrl(youtubePlaybackUrl(latest.current));
    setIsPlaying(false);
    setMode('browse'); setError(null);
  }

  async function goHome() {
    if (pending || mode === 'loading') return;
    const previousMode = mode;
    setPending(true); setError(null); setAccountMenuOpen(false);
    setIsPlaying(false);
    if (mode !== 'browse') setMode('loading');
    try {
      if (previousMode !== 'browse') {
        await api.startBrowserSession(pane.id, { viewport: 'wide', targetUrl: 'https://www.youtube.com/', includeInitialFrame: false });
      }
      await api.navigateBrowser(pane.id, 'https://www.youtube.com/');
      setTargetUrl('https://www.youtube.com/');
      setUrl('');
      setMode('browse');
    } catch {
      setMode(previousMode);
      setError('YouTube Home could not open. Try again.');
    } finally { setPending(false); }
  }

  const lastControlVolume = useRef(50);
  const directState = useRef({ mode, pending, isPlaying });
  directState.current = { mode, pending, isPlaying };
  useEffect(() => {
    if (observerOnly) return;
    return registerRoomPlaybackTarget(pane.id, { roomId: pane.roomId, kind: "YOUTUBE", playing: isPlaying,
      async control(command) {
        const player=playerRef.current;if(pending||mode!=="player"||!player)return false;
        if(["volume","mute","unmute"].includes(command.operation)){
          const prior=player.volumeLevel();if(prior===null)return false;
          if(command.operation==="mute"&&prior>0)lastControlVolume.current=prior;
          const next=command.operation==="mute"?0:command.operation==="unmute"?lastControlVolume.current:command.value??50;
          if(!player.volume(next))return false;
          const until=Date.now()+2000;
          while(Date.now()<until){if(Math.abs((player.volumeLevel()??-100)-next)<1)return true;await new Promise(r=>setTimeout(r,50));}return false;
        }
        if(command.operation==="seek"){
          const seconds=command.value??0;if(!player.seek(seconds))return false;
          const until=Date.now()+3000;
          while(Date.now()<until){if(Math.abs((player.position()??-100)-seconds)<3)return true;await new Promise(r=>setTimeout(r,100));}return false;
        }
        const before=player.currentVideo()?.videoId;
        const ok=await this.run({type:"MUSIC",action:command.operation.toUpperCase() as "PLAY"|"PAUSE"|"NEXT"|"PREVIOUS",target:"YOUTUBE"});
        if(!ok||!["next","previous"].includes(command.operation))return ok;
        const until=Date.now()+5000;
        while(Date.now()<until){const after=playerRef.current?.currentVideo()?.videoId;if(after&&after!==before)return true;await new Promise(r=>setTimeout(r,100));}return false;
      },
      async run(command) {
        if (pending || mode !== "player" || !playerRef.current) return false;
        if (command.action === "NEXT" || command.action === "PREVIOUS") {
          if (!playerRef.current.hasPlaylist() && playlists.length < 2) return false;
          if (command.action === "NEXT") handleNext(); else handlePrevious();
          return true;
        }
        if (command.action === "PLAY") playerRef.current.play(); else playerRef.current.pause();
        const until = Date.now() + 8000;
        while (Date.now() < until) {
          if (directState.current.isPlaying === (command.action === "PLAY")) return true;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
      }
    });
  }, [pane.id, pane.roomId, observerOnly, mode, pending, isPlaying, playlists, currentPlaylistId]);

  const isPlayerPlaying = mode === 'player' && isPlaying;
  const canNavigate = (mode === 'player' && (playerRef.current?.hasPlaylist() ?? Boolean(initial?.playlistId))) || playlists.length > 1;

  function handleTogglePlay() {
    if (pending || mode === 'loading') return;
    if (mode === 'player' && playerRef.current) {
      const trimmed = url.trim();
      const currentUrl = latest.current ? youtubePlaybackUrl(latest.current) : '';
      const isSameUrl = !trimmed || (latest.current && (
        trimmed === currentUrl ||
        (Boolean(latest.current.videoId) && trimmed.includes(latest.current.videoId)) ||
        (latest.current.playlistId !== null && trimmed.includes(latest.current.playlistId))
      ));
      if (isSameUrl) {
        playerRef.current.togglePlay();
        return;
      }
    }
    void playLink();
  }

  function handlePrevious() {
    if (pending || mode === 'loading') return;
    if (mode === 'player' && playerRef.current?.hasPlaylist()) {
      playerRef.current.previous();
      return;
    }
    if (playlists.length > 0) {
      const currentIndex = playlists.findIndex(p => p.id === currentPlaylistId);
      const prevIndex = currentIndex <= 0 ? playlists.length - 1 : currentIndex - 1;
      void selectPlaylist(playlists[prevIndex]!.id);
    }
  }

  function handleNext() {
    if (pending || mode === 'loading') return;
    if (mode === 'player' && playerRef.current?.hasPlaylist()) {
      playerRef.current.next();
      return;
    }
    if (playlists.length > 0) {
      const currentIndex = playlists.findIndex(p => p.id === currentPlaylistId);
      const nextIndex = (currentIndex + 1) % playlists.length;
      void selectPlaylist(playlists[nextIndex]!.id);
    }
  }

  return <section className="youtube-experience" aria-label={`${pane.title} YouTube`} data-youtube-mode={mode}>
    {!observerOnly && !toolbarHidden ? <div className="youtube-toolbar">
      {accounts ? <div className="youtube-account-picker">
        <button ref={accountButton} type="button" className="youtube-account-trigger youtube-tool-btn" aria-label={`Google account for ${pane.title}`}
          title={`Browser account: ${selectedAccountName}`} aria-haspopup="menu" aria-expanded={accountMenuOpen}
          disabled={pending || mode === 'loading'} onClick={() => setAccountMenuOpen(value => !value)}><Users aria-hidden="true" /></button>
        {accountMenuOpen ? createPortal(<div ref={accountMenu} className="youtube-account-menu" role="menu" aria-label="YouTube Google accounts" style={accountPosition}>
          <strong>Google account</strong>
          {[{ profileId: null, displayName: 'Saved pane account' }, ...accounts.profiles].map(profile => <button key={profile.profileId ?? 'pane-account'}
            type="button" role="menuitemradio" aria-checked={accounts.selectedProfileId === profile.profileId}
            onClick={() => void selectAccount(profile.profileId)}>
            <span>{profile.displayName}</span>{accounts.selectedProfileId === profile.profileId ? <Check aria-hidden="true" /> : null}
          </button>)}
          <small>Sign in once for each Google account. Your saved sign-in is reused when opening it in another YouTube pane.</small>
        </div>, document.body) : null}
      </div> : null}
      <button type="button" className="youtube-tool-btn" title="YouTube Home" aria-label="YouTube Home" disabled={pending || mode === 'loading'} onClick={() => void goHome()}>
        <Home aria-hidden="true" />
        <span className="youtube-btn-label">Home</span>
      </button>
      <div className="youtube-playlist-picker">
        <Music2 aria-hidden="true" className="youtube-playlist-icon" />
        <select
          className="youtube-playlist-select"
          aria-label="YouTube playlist"
          title={playlists.length === 0 ? "No playlists" : "Select a playlist"}
          value={currentPlaylistId}
          disabled={pending || mode === 'loading' || playlists.length === 0}
          onChange={(event) => void selectPlaylist(event.target.value)}
        >
          <option value="">{playlists.length === 0 ? 'No playlists' : 'Playlists…'}</option>
          {playlists.map((link) => (
            <option key={link.id} value={link.id}>{link.title}</option>
          ))}
        </select>
      </div>
      <form className="youtube-link-form" onSubmit={(event) => { event.preventDefault(); void playLink(); }}>
        <input aria-label="YouTube video or playlist link" placeholder="Paste a YouTube link" value={url} onChange={(event) => setUrl(event.target.value)} />
      </form>
      <button
        type="button"
        className="youtube-tool-btn youtube-nav-btn"
        title="Previous track"
        aria-label="Previous track"
        disabled={pending || mode === 'loading' || !canNavigate}
        onClick={handlePrevious}
      >
        <ChevronLeft aria-hidden="true" />
      </button>
      <button
        type="button"
        className="youtube-tool-btn youtube-play-btn"
        title={isPlayerPlaying ? "Pause" : "Play"}
        aria-label={isPlayerPlaying ? "Pause" : "Play"}
        disabled={pending || mode === 'loading'}
        onClick={handleTogglePlay}
      >
        {isPlayerPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        <span className="youtube-btn-label">{isPlayerPlaying ? 'Pause' : 'Play'}</span>
      </button>
      <button
        type="button"
        className="youtube-tool-btn youtube-nav-btn"
        title="Next track"
        aria-label="Next track"
        disabled={pending || mode === 'loading' || !canNavigate}
        onClick={handleNext}
      >
        <ChevronRight aria-hidden="true" />
      </button>
      <button type="button" className="youtube-tool-btn" title="Add current video to Space playlist"
        aria-label={addedVideoId === currentVideo?.videoId ? 'Added to Playlist' : 'Add to Playlist'}
        disabled={pending || mode !== 'player' || !currentVideo?.videoId || addingToPlaylist || addedVideoId === currentVideo?.videoId}
        onClick={() => void addToPlaylist()}>
        {addedVideoId === currentVideo?.videoId ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
        <span className="youtube-btn-label">{addingToPlaylist ? 'Adding…' : addedVideoId === currentVideo?.videoId ? 'Added to Playlist' : 'Add to Playlist'}</span>
      </button>
      {mode === 'browse' ? (
        <button type="button" className="youtube-tool-btn" title="Play current video" aria-label="Play current video" disabled={pending} onClick={() => void watchCurrent()}>
          <Play aria-hidden="true" />
          <span className="youtube-btn-label">Play current</span>
        </button>
      ) : (
        <button type="button" className="youtube-tool-btn" title="Browse YouTube" aria-label="Browse YouTube" disabled={pending || mode === 'loading'} onClick={browse}>
          <Youtube aria-hidden="true" />
          <span className="youtube-btn-label">Browse YouTube</span>
        </button>
      )}
      {onToggleFloat ? (
        <button
          type="button"
          className="youtube-tool-btn youtube-float-btn"
          title={isFloating ? "Restore pane to grid" : "Float mini player"}
          aria-label={isFloating ? "Restore pane to grid" : "Float mini player"}
          disabled={pending || mode === 'loading'}
          onClick={onToggleFloat}
        >
          {isFloating ? <Maximize2 aria-hidden="true" /> : <PictureInPicture2 aria-hidden="true" />}
          <span className="youtube-btn-label">{isFloating ? "Restore" : "Float"}</span>
        </button>
      ) : null}
    </div> : null}
    {error ? <div className="youtube-player-message" role="alert"><span>{error}</span>
      <button type="button" onClick={() => { setError(null); if (mode === 'loading') setReload((value) => value + 1); }}> {mode === 'loading' ? 'Retry' : 'Dismiss'} </button>
    </div> : null}
    <div className="youtube-content">
      {mode === 'loading' ? <p role="status">{accountSwitching ? 'Switching Google account…' : 'Restoring YouTube…'}</p> : null}
      {mode === 'browse' ? <ManagedYouTubeBrowser key={accountRevision} {...props} targetUrl={targetUrl} /> : null}
      {mode === 'player' && initial && !pane.isClosed ? (
        <YouTubeNativePlayer
          key={`player-${playerRevision}`}
          playbackKey={localKey.current ?? undefined}
          initial={initial}
          autoPlay={autoPlay}
          onProgress={save}
          onPlayingChange={setIsPlaying}
          playerRef={playerRef}
        />
      ) : null}
    </div>
  </section>;
}
