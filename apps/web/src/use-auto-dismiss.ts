import { useEffect } from "react";

export const DEFAULT_NOTICE_DISMISS_MS = 6_000;

export function useAutoDismiss<T>(
  value: T | null | undefined,
  dismiss: (next: T | null) => void,
  delayMs = DEFAULT_NOTICE_DISMISS_MS
) {
  useEffect(() => {
    if (value === null || value === undefined) return;
    const timer = window.setTimeout(() => dismiss(null), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, dismiss, delayMs]);
}
