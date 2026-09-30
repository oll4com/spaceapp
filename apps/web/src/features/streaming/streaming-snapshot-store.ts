import type { StreamingOverlaySnapshot } from "@space/contracts";

let current: StreamingOverlaySnapshot | null = null;
const listeners = new Set<() => void>();

export function getStreamingSnapshot(): StreamingOverlaySnapshot | null { return current; }
export function subscribeStreamingSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishStreamingSnapshot(snapshot: StreamingOverlaySnapshot): void {
  current = snapshot;
  for (const listener of listeners) listener();
}
