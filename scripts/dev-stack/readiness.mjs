// Readiness belongs to one deliberately launched service generation. Compilation
// pauses it; a late response from a stopped generation cannot affect its successor.
export class ReadinessEpoch {
  #sequence = 0;
  #current = null;

  pause() { this.#sequence++; this.#current = null; }

  start(now = Date.now()) {
    if (!Number.isFinite(now)) throw new Error('Readiness clock must be finite.');
    this.#current = { epoch: ++this.#sequence, deadline: now + 180000, lastReady: null, failures: 0, probe: null, observed: false };
  }

  beginProbe() {
    const current = this.#current;
    if (!current || current.probe) return null;
    current.observed = false;
    return current.probe = Object.freeze({ epoch: current.epoch });
  }

  settle(probe, outcome, now = Date.now()) {
    const current = this.#current;
    if (!probe || !current || current.probe !== probe || current.observed) return null;
    if (!['ready', 'unavailable', 'unreachable'].includes(outcome) || !Number.isFinite(now)) throw new Error('Invalid readiness observation.');
    current.observed = true;
    const ready = outcome === 'ready', previouslyReady = current.lastReady !== null;
    const changed = current.lastReady !== ready;
    let fatal = false;
    if (ready) current.failures = 0;
    else if (outcome === 'unreachable') {
      current.failures++;
      fatal = current.failures >= (previouslyReady ? 4 : 30);
    } else if (previouslyReady) fatal = ++current.failures >= 4;
    else fatal = now > current.deadline;
    if (ready || (outcome !== 'unreachable' && previouslyReady)) current.lastReady = ready;
    return Object.freeze({ epoch: current.epoch, outcome, changed, fatal, failures: current.failures });
  }

  release(probe) {
    const current = this.#current;
    if (current?.probe === probe) { current.probe = null; current.observed = false; }
  }

  diagnostic() {
    const current = this.#current;
    return current ? { epoch: current.epoch, deadline: current.deadline, lastReady: current.lastReady, failures: current.failures, checking: current.probe !== null } : { epoch: this.#sequence, paused: true };
  }
}
