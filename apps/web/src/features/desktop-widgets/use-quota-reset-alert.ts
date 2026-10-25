import { useCallback, useEffect, useRef, useState } from "react";
import { playChime } from "./audio-chime.js";
import { recordAlarmEvent } from "./alarm-log-service.js";
import type { QuotaAlertProvider, WatchedQuota } from "./quota-overview.js";

const alertRings = 5;
const dismissQuietMs = 120_000;
const earliestRecheckMs = 5_000;
const latestRecheckMs = 30 * 60_000;

export interface QuotaResetAlertOptions {
  watched: WatchedQuota | null;
  // Changes with every new quota sample, so each sample is judged once.
  sampleId: number | null;
  enabled: boolean;
  soundEnabled: boolean;
  provider: QuotaAlertProvider;
  proOnly: boolean;
  // Fetches a fresh sample; called when the earliest watched reset time passes.
  refresh: () => void;
}

// Rings once when every watched account was out of quota and one becomes usable again.
// The first sample after mounting or after a filter change only sets the baseline.
export function useQuotaResetAlert({ watched, sampleId, enabled, soundEnabled, provider, proOnly, refresh }: QuotaResetAlertOptions) {
  const [alertActive, setAlertActive] = useState(false);
  const baselineRef = useRef<{ key: string; available: number } | null>(null);
  const dismissedUntilRef = useRef(0);
  const ringTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchKey = `${provider}:${proOnly}`;

  const stopSound = useCallback(() => {
    if (ringTimerRef.current) clearInterval(ringTimerRef.current);
    ringTimerRef.current = null;
  }, []);

  const ring = useCallback(() => {
    stopSound();
    if (!soundEnabled) return;
    playChime("pushup-alert");
    let rings = 1;
    ringTimerRef.current = setInterval(() => {
      rings += 1;
      playChime("pushup-alert");
      if (rings >= alertRings) stopSound();
    }, 1000);
  }, [soundEnabled, stopSound]);

  const raise = useCallback((triggerSource: "quota_available_transition" | "manual_test") => {
    recordAlarmEvent({
      triggerSource,
      provider,
      proOnly,
      availableCount: watched?.available ?? 0,
      totalCount: watched?.total ?? 0,
      availableAccounts: watched?.availableAccounts ?? [],
      nextBack: watched?.next ?? null,
    });
    setAlertActive(true);
    ring();
  }, [provider, proOnly, watched, ring]);

  useEffect(() => {
    if (!watched || sampleId === null) return;
    const previous = baselineRef.current;
    baselineRef.current = { key: watchKey, available: watched.available };
    if (!previous || previous.key !== watchKey) return;
    if (enabled && previous.available === 0 && watched.available > 0 && Date.now() > dismissedUntilRef.current) {
      raise("quota_available_transition");
    }
    // Judge each sample once; `raise` and `enabled` changes must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId, watchKey]);

  // While nothing is usable, look again right after the earliest watched reset.
  const nextBackAt = watched && watched.available === 0 ? watched.next?.backAt ?? null : null;
  useEffect(() => {
    if (!enabled || !nextBackAt) return;
    const delay = Math.min(Math.max(Date.parse(nextBackAt) - Date.now() + earliestRecheckMs, earliestRecheckMs), latestRecheckMs);
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [enabled, nextBackAt, refresh]);

  useEffect(() => {
    if (!soundEnabled) stopSound();
  }, [soundEnabled, stopSound]);

  useEffect(() => stopSound, [stopSound]);

  const dismiss = useCallback(() => {
    stopSound();
    dismissedUntilRef.current = Date.now() + dismissQuietMs;
    setAlertActive(false);
  }, [stopSound]);

  const test = useCallback(() => raise("manual_test"), [raise]);

  return { alertActive, dismiss, test };
}
