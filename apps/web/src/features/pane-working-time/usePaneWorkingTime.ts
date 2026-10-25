import { useState, useEffect, useRef } from "react";
import { api } from "../../api.js";

export interface UsePaneWorkingTimeOptions {
  paneId: string;
  paneCreatedAt?: string;
  isWorking: boolean;
  screenWorkingMs?: number | null;
}

export interface UsePaneWorkingTimeResult {
  workingMs: number;
  isWorking: boolean;
  formattedTime: string;
  hours: number;
  minutes: number;
  seconds: number;
}

interface StoredWorkingTime {
  paneId: string;
  completedWorkingMs: number;
  lastSavedAt: number;
}

const NON_CRITICAL_INITIAL_DELAY_MS = 4_000;

export function formatWorkingTime(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / (60 * 1000)));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function storageKey(paneId: string): string {
  return `space.paneWorkingTime.v2:${paneId}`;
}

function readStoredWorkingTime(paneId: string, paneCreatedAt?: string): StoredWorkingTime | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = localStorage.getItem(storageKey(paneId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredWorkingTime>;
    if (typeof parsed?.completedWorkingMs === "number" && parsed.completedWorkingMs >= 0) {
      let completedMs = parsed.completedWorkingMs;
      if (paneCreatedAt) {
        const paneAgeMs = Math.max(0, Date.now() - Date.parse(paneCreatedAt));
        if (Number.isFinite(paneAgeMs) && completedMs > paneAgeMs) {
          completedMs = paneAgeMs;
        }
      }
      return {
        paneId,
        completedWorkingMs: completedMs,
        lastSavedAt: parsed.lastSavedAt ?? Date.now()
      };
    }
  } catch {}
  return null;
}

function saveStoredWorkingTime(paneId: string, completedWorkingMs: number): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const data: StoredWorkingTime = {
      paneId,
      completedWorkingMs: Math.round(completedWorkingMs),
      lastSavedAt: Date.now()
    };
    localStorage.setItem(storageKey(paneId), JSON.stringify(data));
  } catch {}
}

export function usePaneWorkingTime({
  paneId,
  paneCreatedAt,
  isWorking,
  screenWorkingMs
}: UsePaneWorkingTimeOptions): UsePaneWorkingTimeResult {
  const [completedWorkingMs, setCompletedWorkingMs] = useState<number>(() => {
    const stored = readStoredWorkingTime(paneId, paneCreatedAt);
    return stored?.completedWorkingMs ?? 0;
  });

  const [currentTurnElapsedMs, setCurrentTurnElapsedMs] = useState<number>(0);

  const activeIntervalStartRef = useRef<number | null>(null);
  const completedWorkingMsRef = useRef(completedWorkingMs);
  completedWorkingMsRef.current = completedWorkingMs;
  const currentTurnElapsedMsRef = useRef(currentTurnElapsedMs);
  currentTurnElapsedMsRef.current = currentTurnElapsedMs;

  // Reset when paneId or paneCreatedAt changes
  useEffect(() => {
    activeIntervalStartRef.current = null;
    setCurrentTurnElapsedMs(0);
    const stored = readStoredWorkingTime(paneId, paneCreatedAt);
    setCompletedWorkingMs(stored?.completedWorkingMs ?? 0);
  }, [paneId, paneCreatedAt]);

  // Hydrate from server API on mount or paneId change, and periodically sync
  useEffect(() => {
    // An optimistic pane has no server record yet; its real id arrives with the created pane.
    if (paneId.startsWith("pane:optimistic-")) return;
    let cancelled = false;
    const syncWithServer = async () => {
      try {
        const response = await api.paneWorkingTime(paneId);
        if (!cancelled && typeof response?.cumulativeWorkingMs === "number" && response.cumulativeWorkingMs >= 0) {
          const serverMs = response.cumulativeWorkingMs;
          setCompletedWorkingMs((current) => {
            // Server task timeline is authoritative when it reports cumulative task history (> 0).
            // This prevents compounding local drift and resolves cross-device discrepancies (e.g. laptop vs PC).
            const targetMs = serverMs > 0 ? serverMs : current;
            saveStoredWorkingTime(paneId, targetMs);
            return targetMs;
          });
        }
      } catch {}
    };

    let started = false;
    let interval: number | null = null;
    let timeoutHandle: number | null = null;
    const start = () => {
      if (cancelled || started) return;
      started = true;
      void syncWithServer();
      interval = window.setInterval(syncWithServer, 15_000);
    };
    timeoutHandle = window.setTimeout(start, NON_CRITICAL_INITIAL_DELAY_MS);
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState !== "hidden") start();
    };
    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    return () => {
      cancelled = true;
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      if (interval !== null) window.clearInterval(interval);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, [paneId]);

  // Sync with terminal screen text working time if present (e.g. "Working (35m 55s)" or "Thought for 10m 16s")
  useEffect(() => {
    if (typeof screenWorkingMs === "number" && screenWorkingMs > 0 && isWorking) {
      // Adjust current turn duration if terminal screen reports a longer duration
      if (screenWorkingMs > currentTurnElapsedMsRef.current) {
        setCurrentTurnElapsedMs(screenWorkingMs);
        activeIntervalStartRef.current = Date.now() - screenWorkingMs;
      }
    }
  }, [paneId, isWorking, screenWorkingMs]);

  // Handle active execution intervals and live ticking
  useEffect(() => {
    if (isWorking) {
      if (activeIntervalStartRef.current === null) {
        const initialTurnMs = typeof screenWorkingMs === "number" && screenWorkingMs > 0 ? screenWorkingMs : 0;
        activeIntervalStartRef.current = Date.now() - initialTurnMs;
        setCurrentTurnElapsedMs(initialTurnMs);
      }

      const interval = window.setInterval(() => {
        if (activeIntervalStartRef.current !== null) {
          const elapsed = Math.max(0, Date.now() - activeIntervalStartRef.current);
          const currentTotal = completedWorkingMsRef.current + currentTurnElapsedMsRef.current;
          const nextTotal = completedWorkingMsRef.current + elapsed;
          if (
            Math.floor(nextTotal / 60_000) !== Math.floor(currentTotal / 60_000) ||
            Math.abs(elapsed - currentTurnElapsedMsRef.current) >= 5_000
          ) {
            setCurrentTurnElapsedMs(elapsed);
          }
        }
      }, 1_000);

      return () => {
        window.clearInterval(interval);
      };
    } else {
      // Transitioned to idle (waiting for user command)
      if (activeIntervalStartRef.current !== null) {
        const finalTurnElapsed = Math.max(0, Date.now() - activeIntervalStartRef.current);
        const newTotal = completedWorkingMsRef.current + finalTurnElapsed;
        setCompletedWorkingMs(newTotal);
        saveStoredWorkingTime(paneId, newTotal);
        activeIntervalStartRef.current = null;
        setCurrentTurnElapsedMs(0);
        // Refresh server authoritative metrics upon turn completion
        void api.paneWorkingTime(paneId).then((response) => {
          if (typeof response?.cumulativeWorkingMs === "number" && response.cumulativeWorkingMs > 0) {
            setCompletedWorkingMs(response.cumulativeWorkingMs);
            saveStoredWorkingTime(paneId, response.cumulativeWorkingMs);
          }
        }).catch(() => {});
      }
    }
  }, [paneId, isWorking, screenWorkingMs]);

  const rawTotalWorkingMs = isWorking
    ? completedWorkingMs + currentTurnElapsedMs
    : completedWorkingMs;

  const paneAgeMs = paneCreatedAt ? Math.max(0, Date.now() - Date.parse(paneCreatedAt)) : Infinity;
  const totalWorkingMs = Number.isFinite(paneAgeMs) ? Math.min(rawTotalWorkingMs, paneAgeMs) : rawTotalWorkingMs;

  const totalSeconds = Math.max(0, Math.floor(totalWorkingMs / 1000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const seconds = totalSeconds % 60;

  return {
    workingMs: totalWorkingMs,
    isWorking,
    formattedTime: formatWorkingTime(totalWorkingMs),
    hours,
    minutes,
    seconds
  };
}
