// 龙娘 · 2026-10-26：为 SpaceApp #65 新建，仅管理本实例启动的 POSIX 进程组。
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const TERM_TIMEOUT_MS = 3_000;
const REAP_TIMEOUT_MS = 500;

export class ProcessManager extends EventEmitter {
  #processes = new Map();
  #onOutput;

  constructor({ onOutput } = {}) {
    super();
    if (process.platform === 'win32') {
      throw new Error('Native Windows is unsupported; run the development stack in WSL, Linux, or macOS.');
    }
    this.#onOutput = onOutput;
  }

  start(name, command, args = [], { cwd, env } = {}) {
    if (this.#processes.has(name)) {
      throw new Error(`Process ${name} is already tracked; stop it before starting it again.`);
    }
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolveExit;
    const entry = {
      child,
      stopping: false,
      failureEmitted: false,
      stopPromise: undefined,
      exitPromise: new Promise((resolve) => { resolveExit = resolve; }),
    };
    this.#processes.set(name, entry);
    const fail = (error, code, signal) => {
      if (!entry.stopping && !entry.failureEmitted) {
        entry.failureEmitted = true;
        this.emit('failure', { name, error, code, signal });
      }
    };
    child.on('error', (error) => {
      // A failed spawn has no process group and does not emit an exit event.
      if (child.pid === undefined) resolveExit();
      fail(error, null, null);
    });
    child.on('exit', (code, signal) => {
      resolveExit();
      fail(undefined, code, signal);
    });
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => this.#onOutput?.(name, chunk, stream));
    }
    return child;
  }

  get(name) {
    return this.#processes.get(name)?.child;
  }

  async stop(name) {
    const entry = this.#processes.get(name);
    if (!entry) return;
    if (entry.stopPromise) return entry.stopPromise;
    // Set this synchronously, before a TERM-induced exit can report failure.
    entry.stopping = true;
    entry.stopPromise = this.#terminate(entry).then(() => {
      if (this.#processes.get(name) === entry) this.#processes.delete(name);
    }).catch((error) => {
      entry.stopPromise = undefined;
      throw error;
    });
    return entry.stopPromise;
  }

  async stopAll() {
    // Mark and stop all groups together, so the grace period is bounded globally.
    const results = await Promise.allSettled([...this.#processes.keys()].map((name) => this.stop(name)));
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Failed to stop development processes');
  }

  #signal(pid, signal) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  }

  async #terminate(entry) {
    const pid = entry.child.pid;
    if (pid === undefined) return;
    // Never load PID files: this PID came directly from this manager's spawn.
    const deadline = performance.now() + TERM_TIMEOUT_MS;
    if (this.#signal(pid, 'SIGTERM')) {
      while (this.#signal(pid, 0)) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          this.#signal(pid, 'SIGKILL');
          break;
        }
        await delay(Math.min(25, remaining));
      }
    }
    // Descendants can hold inherited pipes open; never wait unboundedly for close.
    let timer;
    await Promise.race([
      entry.exitPromise,
      new Promise((resolve) => { timer = setTimeout(resolve, REAP_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    entry.child.stdout.destroy();
    entry.child.stderr.destroy();
  }
}