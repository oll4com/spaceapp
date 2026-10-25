import { useEffect, useState } from "react";
import type { AppVersionStatus } from "../../live-api.js";
import { APP_VERSION_POLL_INTERVAL_MS, fetchAppVersion } from "./version-check.js";

export function useAppVersion(): AppVersionStatus | null {
  const [status, setStatus] = useState<AppVersionStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const update = () => {
      void fetchAppVersion().then((next) => {
        if (!cancelled) setStatus(next);
      });
    };
    update();
    const interval = setInterval(update, APP_VERSION_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return status;
}