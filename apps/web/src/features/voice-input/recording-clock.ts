import { useEffect, useState } from "react";

const COUNTDOWN_WINDOW_MS = 10_000;

// Elapsed recording time in ms, refreshed every second while a recording runs.
export function useRecordingElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

// "0:42" while recording; "Stops in 8s" during the last ten seconds before the automatic stop.
export function formatRecordingClock(elapsedMs: number, maxDurationMs?: number | null): string {
  if (maxDurationMs && maxDurationMs - elapsedMs <= COUNTDOWN_WINDOW_MS) {
    return `Stops in ${Math.max(0, Math.ceil((maxDurationMs - elapsedMs) / 1_000))}s`;
  }
  const seconds = Math.floor(elapsedMs / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Long live previews keep their newest words visible.
export function previewTail(text: string, maxLength = 90): string {
  return text.length > maxLength ? `…${text.slice(text.length - maxLength + 1).trimStart()}` : text;
}
