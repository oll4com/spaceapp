/**
 * Coalesce source edits for 400 ms, retaining package rebuilds over API-only restarts.
 * stop() cancels pending work and permanently ignores later watcher notifications.
 * The supplied rebuild callback owns asynchronous failure handling.
 */
export function debounceSourceChanges(rebuild, observe = () => {}) {
  let pending = null, timer, stopped = false, generation = 0;
  const observed = () => observe({ requested: generation, pending: pending === null ? null : { generation, kind: pending }, stopped });
  return {
    change(kind) {
      if (stopped) return;
      pending = pending === 'packages' || kind === 'packages' ? 'packages' : 'api';
      generation++;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = pending, requested = generation; pending = null;
        observed();
        void rebuild(next, requested);
      }, 400);
      observed();
    },
    stop() { stopped = true; clearTimeout(timer); pending = null; observed(); },
  };
}

/**
 * Observe the existing debounce/restart queue without admitting or scheduling work.
 * A completed request is idle only after its active and queued work has ended;
 * later watcher notifications keep requested ahead of completed until rebuilt.
 */
export class ReloadReceipt {
  #state = { version: 1, revision: 0, requested: 0, pending: null, queued: null, active: null, completed: 0, stopping: false };

  debounced({ requested, pending, stopped }) {
    this.#state.requested = requested;
    this.#state.pending = pending;
    this.#state.stopping ||= stopped;
    this.#state.revision++;
  }

  started(kind, generation) { this.#state.active = { kind, generation }; this.#state.revision++; }
  enqueued(generation) { this.#state.queued = { kind: 'packages', generation }; this.#state.revision++; }
  finished(generation, rebuilt) {
    if (rebuilt) this.#state.completed = Math.max(this.#state.completed, generation);
    this.#state.active = null;
    this.#state.revision++;
  }
  releaseQueued() {
    const generation = this.#state.queued.generation;
    this.#state.queued = null;
    this.#state.revision++;
    return generation;
  }
  stop() { this.#state.stopping = true; this.#state.revision++; }
  snapshot() { return structuredClone(this.#state); }
}
