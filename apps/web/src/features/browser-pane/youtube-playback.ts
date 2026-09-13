export interface YouTubePlayback {
  videoId: string;
  playlistId: string | null;
  index: number;
  seconds: number;
  title: string;
  updatedAt: number;
}

export function parseYouTubePlayback(raw: string): YouTubePlayback | null {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const videoId = host === 'youtu.be' ? parts[0]
      : ['shorts', 'live', 'embed'].includes(parts[0] ?? '') ? parts[1] : url.searchParams.get('v');
    const list = url.searchParams.get('list');
    if (videoId ? !/^[\w-]{11}$/.test(videoId) : !list || !/^[\w-]{8,150}$/.test(list)) return null;
    const time = url.searchParams.get('t') ?? url.searchParams.get('start') ?? '0';
    const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(time);
    const seconds = /^\d+(?:\.\d+)?$/.test(time) ? Number(time)
      : units ? Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0) : 0;
    return { videoId: videoId ?? '', playlistId: list && /^[\w-]{8,150}$/.test(list) ? list : null,
      index: Math.max(0, Math.min(10000, Math.floor(Number(url.searchParams.get('index') ?? 1)) - 1 || 0)),
      seconds: Math.min(604800, seconds), title: '', updatedAt: Date.now() };
  } catch { return null; }
}

export function youtubePlaybackUrl(value: YouTubePlayback): string {
  const url = new URL(value.videoId ? 'https://www.youtube.com/watch' : 'https://www.youtube.com/playlist');
  if (value.videoId) url.searchParams.set('v', value.videoId);
  if (value.playlistId) { url.searchParams.set('list', value.playlistId); url.searchParams.set('index', String(value.index + 1)); }
  url.searchParams.set('t', `${Math.floor(value.seconds)}s`);
  return url.toString();
}

export function validYouTubePlayback(value: unknown): value is YouTubePlayback {
  if (!value || typeof value !== 'object') return false;
  const p = value as YouTubePlayback;
  return typeof p.videoId === 'string' && (/^[\w-]{11}$/.test(p.videoId) || p.videoId === '' && Boolean(p.playlistId))
    && (p.playlistId === null || typeof p.playlistId === 'string' && /^[\w-]{8,150}$/.test(p.playlistId))
    && Number.isInteger(p.index) && p.index >= 0 && p.index <= 10000
    && Number.isFinite(p.seconds) && p.seconds >= 0 && p.seconds <= 604800
    && typeof p.title === 'string' && p.title.length <= 500
    && Number.isFinite(p.updatedAt) && p.updatedAt > 0;
}
