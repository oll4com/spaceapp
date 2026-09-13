import { getSpaceRuntime } from './runtime/SpaceRuntime.js';

// Keep the existing preference when upgrading from Vibe-only volume.
export const SPACE_VOLUME_STORAGE_KEY = 'space.vibeMusic.volume';
export const DEFAULT_SPACE_VOLUME = 0.35;
const VOLUME_EVENT = 'space:volume-changed';

export function getSpaceVolume(): number {
  try {
    const stored = getSpaceRuntime().platform.localStorage.getItem(SPACE_VOLUME_STORAGE_KEY);
    const value = stored?.trim() ? Number(stored) : NaN;
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_SPACE_VOLUME;
  } catch { return DEFAULT_SPACE_VOLUME; }
}

export function setSpaceVolume(value: number): void {
  if (!Number.isFinite(value)) return;
  const volume = Math.max(0, Math.min(1, value));
  try { getSpaceRuntime().platform.localStorage.setItem(SPACE_VOLUME_STORAGE_KEY, String(volume)); } catch { /* Best effort persistence. */ }
  window.dispatchEvent(new CustomEvent(VOLUME_EVENT, { detail: volume }));
}

export function subscribeSpaceVolume(update: (volume: number) => void): () => void {
  const changed = (event: Event) => update((event as CustomEvent<number>).detail);
  const stored = (event: StorageEvent) => {
    if (event.key === SPACE_VOLUME_STORAGE_KEY || event.key === null) update(getSpaceVolume());
  };
  window.addEventListener(VOLUME_EVENT, changed);
  window.addEventListener('storage', stored);
  return () => {
    window.removeEventListener(VOLUME_EVENT, changed);
    window.removeEventListener('storage', stored);
  };
}

/** Covers media previews too, without changing their mute or playback state. */
export function bindSpaceMediaVolume(root: Document = document): () => void {
  let volume = getSpaceVolume();
  const apply = (node: Node) => {
    if (node instanceof HTMLMediaElement) node.volume = volume;
    if (node instanceof Element || node instanceof Document) {
      node.querySelectorAll<HTMLMediaElement>('audio, video').forEach(media => { media.volume = volume; });
    }
  };
  apply(root);
  const unsubscribe = subscribeSpaceVolume(next => { volume = next; apply(root); });
  const observer = new MutationObserver(records => {
    for (const record of records) record.addedNodes.forEach(apply);
  });
  observer.observe(root, { childList: true, subtree: true });
  const play = (event: Event) => { if (event.target instanceof HTMLMediaElement) event.target.volume = volume; };
  root.addEventListener('play', play, true);
  return () => { unsubscribe(); observer.disconnect(); root.removeEventListener('play', play, true); };
}
