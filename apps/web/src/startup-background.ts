import { getSpaceRuntimeKind } from "./runtime/SpaceRuntime.js";

const NON_CRITICAL_STARTUP_DELAY_MS = 4_000;

// The demo answers locally, so it has no startup load to spread out, and its first render must equal the settled
// one: the stable deploy's demo parity gate compares them, and a readiness or storage notice landing 4 s later
// failed it at random viewports (2026-10-15).
export function startupBackgroundDelay(): number {
  if (getSpaceRuntimeKind() === "demo") return 0;
  return typeof navigator !== "undefined" && /\bjsdom\b/i.test(navigator.userAgent)
    ? 0
    : NON_CRITICAL_STARTUP_DELAY_MS;
}

export function scheduleStartupBackground(task: () => void, isMounted: () => boolean = () => true): number {
  return window.setTimeout(() => {
    if (!isMounted()) return;
    task();
  }, startupBackgroundDelay());
}

export function scheduleSetupOverviewProbe({
  isMounted,
  loadOverview,
  onIncomplete,
  onError
}: {
  isMounted: () => boolean;
  loadOverview: () => Promise<{ isComplete: boolean }>;
  onIncomplete: () => void;
  onError: () => void;
}): number {
  return scheduleStartupBackground(() => {
    void loadOverview()
      .then((overview) => {
        if (isMounted() && !overview.isComplete) onIncomplete();
      })
      .catch(() => {
        if (isMounted()) onError();
      });
  }, isMounted);
}
