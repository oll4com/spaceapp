import { useEffect, useSyncExternalStore } from "react";
import type { CliUpdateAllRequest, CliUpdateAllResult } from "@space/contracts";
import { errorMessage } from "./admin-operation-utils.js";

// The CLI update-all run lives outside its panel, so it keeps going while the Manage window is minimized or
// closed; the minimized bar shows it until a panel has shown the outcome. The API notifies the end.

export interface CliUpdateRun {
  startedAt: number;
  label: string;
  result: CliUpdateAllResult | null;
  error: string | null;
  finished: boolean;
  /** A panel showed the outcome, so the minimized bar lets the run go. */
  seen: boolean;
}

let run: CliUpdateRun | null = null;
let openPanels = 0;
const listeners = new Set<() => void>();

function emit(next: CliUpdateRun | null = run) {
  run = next?.finished && !next.seen && openPanels > 0 ? { ...next, seen: true } : next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useCliUpdateRun() {
  return useSyncExternalStore(subscribe, () => run);
}

/** The run the minimized bar lists: one no panel shows, still running or with an outcome nobody saw. */
export function useMinimizedCliUpdateRun() {
  return useSyncExternalStore(subscribe, () => (openPanels === 0 && run && !run.seen ? run : null));
}

/** A mounted update panel shows the run, so it leaves the minimized bar. */
export function useCliUpdatePanelOpen() {
  useEffect(() => {
    openPanels += 1;
    emit();
    return () => {
      openPanels -= 1;
      emit();
    };
  }, []);
}

export async function startCliUpdateRun(
  runner: (input: CliUpdateAllRequest) => Promise<CliUpdateAllResult>,
  input: CliUpdateAllRequest,
  label: string
) {
  if (run && !run.finished) return;
  const started: CliUpdateRun = { startedAt: Date.now(), label, result: null, error: null, finished: false, seen: false };
  emit(started);
  try {
    emit({ ...started, result: await runner(input), finished: true });
  } catch (reason) {
    emit({ ...started, error: errorMessage(reason, "The update-all procedure could not be started."), finished: true });
  }
}

/** Tests only: forget the last run. */
export function resetCliUpdateRun() {
  emit(null);
}
