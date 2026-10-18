/**
 * Coalesce source edits for 400 ms, retaining package rebuilds over API-only restarts.
 * stop() cancels pending work and permanently ignores later watcher notifications.
 * The supplied rebuild callback owns asynchronous failure handling.
 */
export function debounceSourceChanges(rebuild) {
  let pending = null, timer, stopped = false;
  return {
    change(kind) {
      if (stopped) return;
      pending = pending === 'packages' || kind === 'packages' ? 'packages' : 'api';
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = pending; pending = null;
        void rebuild(next);
      }, 400);
    },
    stop() { stopped = true; clearTimeout(timer); pending = null; },
  };
}
