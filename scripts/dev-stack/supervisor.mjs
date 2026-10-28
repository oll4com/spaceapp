// 龙娘 · 2026-10-26: SpaceApp #65 owned lifecycle, exclusive control and redacted contributor logs.
import net from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { constants, openSync, fstatSync, ftruncateSync, closeSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, rm, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, prepareState, assertOwnedState } from './state.mjs';
import { ProcessManager } from './processes.mjs';
import { START_CYCLE_TIMEOUT_MS } from './runtime.mjs';

function errorText(error) {
  const nested = error instanceof AggregateError ? [...error.errors].map(errorText) : [];
  return [...new Set([error?.message ?? String(error), error?.stderr, error?.stdout, ...nested].filter(Boolean))].join('\n');
}

function privateWrite(file, contents, append = true) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (append ? constants.O_APPEND : 0), 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe development log/audit file: ${path.basename(file)}`);
    if (!append) ftruncateSync(fd, 0);
    writeFileSync(fd, contents);
  } finally { closeSync(fd); }
}

export function redact(value, secrets = []) {
  return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
}

// Hold the longest possible incomplete secret across chunks, including split UTF-8.
export function createRedactedOutput(secrets, write) {
  const values = secrets.filter(Boolean);
  const keep = Math.max(1, ...values.map(value => value.length)) - 1;
  const streams = new Map();
  const emit = (name, stream, entry, flush = false) => {
    let cut = flush ? entry.pending.length : Math.max(0, entry.pending.length - keep);
    for (const secret of values) {
      let at = entry.pending.indexOf(secret);
      while (at !== -1) {
        if (at < cut && at + secret.length > cut) cut = at;
        at = entry.pending.indexOf(secret, at + 1);
      }
    }
    if (cut) write(name, redact(entry.pending.slice(0, cut), values), stream);
    entry.pending = entry.pending.slice(cut);
  };
  return {
    push(name, chunk, stream = 'stdout') {
      const key = `${name}:${stream}`;
      let entry = streams.get(key);
      if (!entry) { entry = { decoder: new StringDecoder('utf8'), pending: '', name, stream }; streams.set(key, entry); }
      entry.pending += entry.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      emit(name, stream, entry);
    },
    flush() {
      for (const entry of streams.values()) {
        entry.pending += entry.decoder.end();
        emit(entry.name, entry.stream, entry, true);
      }
      streams.clear();
    },
  };
}

export async function acquireLifetimeLock(repoRoot) {
  const lock = path.join(repoRoot, '.dev-stack-lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Development stack is already running or a previous shutdown was interrupted. Inspect ${lock}; do not kill a recorded/stale PID or remove the lock while another supervisor is active.`);
    throw error;
  }
  const owned = await lstat(lock);
  let released = false;
  return async () => {
    if (released) return;
    // Never recursively delete a lock directory, or follow a replacement symlink.
    const stat = await lstat(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino) throw new Error('Development lifetime lock was replaced; refusing cleanup');
    await rmdir(lock);
    released = true;
  };
}

// Longniang, 2026-10-28: rebuild can queue behind startup, then execute every serial build/readiness step again.
export function controlTimeoutMs(command) {
  return command === 'rebuild' ? 2 * START_CYCLE_TIMEOUT_MS + 60_000 : 600_000;
}

export async function requestControl(socketPath, command, { timeoutMs = controlTimeoutMs(command) } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    const timer = setTimeout(() => socket.destroy(new Error(`Timed out waiting for supervisor ${command}; shutdown/build may still be running, so do not reset its state.`)), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ command })}\n`));
    socket.on('data', chunk => {
      response += chunk;
      if (response.length > 65536) socket.destroy(new Error('Invalid oversized supervisor response'));
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(response);
        if (!result.ok) throw new Error(result.error || 'Supervisor command failed');
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

export async function listenControl(socketPath, execute) {
  const clients = new Set();
  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let input = '';
    let handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      input += chunk;
      if (input.length > 1024) { handled = true; socket.end(`${JSON.stringify({ ok: false, error: 'Oversized control command' })}\n`); return; }
      if (!input.includes('\n')) return;
      handled = true;
      socket.setTimeout(0);
      try {
        const { command } = JSON.parse(input);
        if (!['down', 'reset', 'rebuild'].includes(command)) throw new Error('Unknown supervisor command');
        await execute(command);
        socket.end(`${JSON.stringify({ ok: true, command })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  await chmod(socketPath, 0o600);
  return {
    // Stop accepting immediately; pending command replies may still drain.
    close() {
      server.close();
      // Idle or uncooperative local clients must not keep shutdown alive indefinitely.
      for (const client of clients) client.setTimeout(1000, () => client.destroy());
    },
    destroyClients() { for (const client of clients) client.destroy(); },
  };
}

export async function waitForReady(config, { signal, fetchFn = fetch, timeoutMs = 120_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'API has not answered';
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await fetchFn(`http://127.0.0.1:${config.ports.api}/readyz?strict=1`, {
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.min(5000, Math.max(1, deadline - Date.now())))]),
      });
      const body = await response.json();
      const dependencies = body.dependencies;
      if (response.ok && body.ok === true && dependencies?.database === 'RUNNING' && dependencies?.worker === 'RUNNING' && dependencies?.cliHost === 'RUNNING') return body;
      last = `HTTP ${response.status}, ok=${body.ok}, database=${dependencies?.database}, worker=${dependencies?.worker}, cliHost=${dependencies?.cliHost}`;
    } catch (error) { signal?.throwIfAborted(); last = error.message; }
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new Error(`Development stack strict readiness timed out: ${last}`);
}

export class StackSupervisor {
  constructor({ config, secrets, runtime, manager, output, ready = waitForReady, removeState = () => rm(config.stateDir, { recursive: true, force: false }), verifyState = assertOwnedState }) {
    Object.assign(this, { config, secrets, runtime, manager, output, ready, removeState, verifyState });
    this.controller = new AbortController();
    this.stopping = false;
    this.watchCleanup = undefined;
    this.work = Promise.resolve();
    this.finished = new Promise((resolve, reject) => { this.finish = resolve; this.fail = reject; });
    // Attach a rejection observer before a process can fail during initial startup.
    this.finished.catch(() => {});
    manager.on('failure', event => {
      const error = new Error(`Service ${event.name} exited unexpectedly (${event.error?.message ?? `code ${event.code}, signal ${event.signal}`})`);
      try { this.output(error.message); } catch (logError) { error.message += '; logging failed: ' + logError.message; }
      void this.stop('down', error).catch(() => {});
    });
  }

  start() {
    this.work = this.startCycle(true);
    this.work.catch(error => { if (!this.stopping) void this.stop('down', error).catch(() => {}); });
    return this.work;
  }

  async startCycle(initial) {
    const signal = this.controller.signal;
    if (initial) {
      this.output('Preparing isolated development state...');
      const prepared = await this.runtime.prepareRuntime(this.config, this.secrets, { signal });
      this.env = prepared.env;
    }
    signal.throwIfAborted();
    this.output('Building checkout dependencies, worker and isolated OpenCode...');
    await this.runtime.buildRuntime(this.config, this.env, { signal });
    signal.throwIfAborted();
    this.output('Starting development PostgreSQL/Temporal and applying migrations...');
    await this.runtime.prepareInfrastructure(this.config, this.env, { signal });
    signal.throwIfAborted();
    this.output('Starting shared OpenCode server, CLI host, worker, API and web...');
    this.watchCleanup = await this.runtime.startServices(this.config, this.env, this.manager, { signal });
    signal.throwIfAborted();
    this.output('Waiting for strict readiness (database, workflows and CLI host)...');
    await this.ready(this.config, { signal });
    signal.throwIfAborted();
    this.output(`Ready: http://127.0.0.1:${this.config.ports.web}\nOwner setup token: ${this.secrets.setupToken}`, { setupToken: true });
  }

  async haltServices() {
    const errors = [];
    try { await this.watchCleanup?.(); } catch (error) { errors.push(error); }
    this.watchCleanup = undefined;
    try { await this.manager.stopAll(); this.childrenStopped = true; } catch (error) { this.childrenStopped = false; errors.push(error); }
    this.servicesStopped = errors.length === 0;
    if (errors.length) throw new AggregateError(errors, errors.map(error => errorText(error)).join('; '));
  }

  command(command) {
    if (command === 'down' || command === 'reset') return this.stop(command);
    if (this.stopping) return Promise.reject(new Error('Shutdown is already pending; state cannot be rebuilt or reset until it completes.'));
    if (this.rebuilding) return Promise.reject(new Error('A rebuild is already pending.'));
    this.rebuilding = true;
    const previous = this.work;
    this.work = (async () => {
      await previous;
      this.controller.signal.throwIfAborted();
      await this.haltServices();
      this.controller.signal.throwIfAborted();
      await this.startCycle(false);
    })().finally(() => { this.rebuilding = false; });
    this.work.catch(error => { if (!this.stopping) void this.stop('down', error).catch(() => {}); });
    return this.work;
  }

  stop(command = 'down', cause) {
    if (this.stopping) {
      if (command === 'reset' && this.stopCommand !== 'reset') return Promise.reject(new Error('Shutdown is already pending; wait for it to complete before resetting state.'));
      return this.stopPromise;
    }
    this.stopping = true;
    this.stopCommand = command;
    this.controller.abort(new Error('Development stack shutdown requested'));
    this.stopPromise = (async () => {
      const errors = cause ? [cause] : [];
      // Await cancellation of one-shot builds before touching state or containers.
      try { await this.work; } catch (error) {
        const cancelled = error === this.controller.signal.reason || (error?.name === 'AbortError' && error.cause === this.controller.signal.reason);
        if (!cancelled && !errors.includes(error)) errors.push(error);
      }
      let safeToRemove = true;
      try { await this.haltServices(); } catch (error) { safeToRemove = false; errors.push(error); }
      try {
        await this.verifyState(this.config);
        await this.runtime.compose(this.config, command === 'reset' ? ['down', '--volumes', '--remove-orphans'] : ['stop']);
      } catch (error) { safeToRemove = false; errors.push(error); }
      if (command === 'reset' && safeToRemove) {
        try { await this.verifyState(this.config); await this.removeState(); } catch (error) { errors.push(error); }
      }
      if (errors.length) {
        const failure = new AggregateError(errors, redact(errors.map(error => errorText(error)).join('; '), Object.values(this.secrets)));
        this.fail(failure);
        throw failure;
      }
      this.finish();
    })();
    return this.stopPromise;
  }
}

export async function runDevStack({ repoRoot, command = 'up', env = process.env, runtime: suppliedRuntime } = {}) {
  if (process.platform === 'win32') throw new Error('Run dev:stack in WSL, Linux, or macOS. Native Windows is unsupported.');
  if (!['up', 'down', 'reset', 'rebuild'].includes(command)) throw new Error(`Unknown dev stack command: ${command}`);
  const config = await loadConfig(repoRoot, env);
  if (command !== 'up') {
    try {
      await requestControl(config.controlSocket, command);
      console.log(`[dev-stack] ${command} completed`);
      return;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      if (command === 'rebuild') throw new Error('No running development supervisor. Start npm run dev:stack first.');
    }
  }
  const release = await acquireLifetimeLock(config.repoRoot);
  let control;
  let supervisor;
  let startupInvoked = false;
  let redacted;
  const signalListeners = [];
  try {
    const runtime = suppliedRuntime ?? await import('./runtime.mjs');
    if (command !== 'up') {
      try { await lstat(config.stateDir); } catch (error) {
        if (error.code === 'ENOENT') { console.log('[dev-stack] No development state exists; nothing to stop.'); return; }
        throw error;
      }
      await assertOwnedState(config);
      await runtime.compose(config, command === 'reset' ? ['down', '--volumes', '--remove-orphans'] : ['stop']);
      if (command === 'reset') { await assertOwnedState(config); await rm(config.stateDir, { recursive: true }); }
      console.log(`[dev-stack] ${command} completed`);
      return;
    }
    const secrets = await prepareState(config);
    const secretValues = Object.values(secrets);
    const logPath = path.join(config.stateDir, 'logs', 'dev-stack.log');
    const output = (message, { setupToken = false } = {}) => {
      const safe = redact(message, setupToken ? [secrets.databasePassword, secrets.sessionSecret] : secretValues);
      console.log(`[dev-stack] ${safe}`);
      // The token is deliberately shown once to the operator, but never persisted in logs.
      privateWrite(logPath, `[dev-stack] ${redact(message, secretValues)}\n`);
    };
    redacted = createRedactedOutput(secretValues, (name, chunk, stream) => {
      const line = `[${name}:${stream}] ${chunk}`;
      process.stdout.write(line);
      privateWrite(logPath, line);
    });
    const manager = new ProcessManager({ onOutput: (...args) => {
      try { redacted.push(...args); } catch (error) { void supervisor?.stop('down', error).catch(() => {}); }
    } });
    const started = [];
    const originalStart = manager.start.bind(manager);
    manager.start = (...args) => {
      const child = originalStart(...args);
      if (child.pid) {
        started.push({ name: args[0], pid: child.pid });
        // Audit only. Lifecycle cleanup uses live ChildProcess references, never this file.
        privateWrite(path.join(config.stateDir, 'processes.json'), `${JSON.stringify({ processes: started })}\n`, false);
      }
      return child;
    };
    supervisor = new StackSupervisor({ config, secrets, runtime, manager, output, removeState: async () => { redacted.flush(); await rm(config.stateDir, { recursive: true }); } });
    // Do not unlink existing sockets: listen is exclusive, even for a stale socket.
    control = await listenControl(config.controlSocket, async request => {
      try { return await supervisor.command(request); } catch (error) { throw new Error(redact(error.message, secretValues)); }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const listener = () => { void supervisor.stop().catch(() => {}); };
      process.on(signal, listener);
      signalListeners.push([signal, listener]);
    }
    startupInvoked = true;
    void supervisor.start().catch(() => {});
    await supervisor.finished;
  } catch (error) {
    if (startupInvoked && supervisor && !supervisor.stopping) {
      try { await supervisor.stop('down', error); } catch { /* Preserve the original startup error. */ }
    }
    // Suppress generated secrets even when a runtime error contains a DSN or env fragment.
    throw new Error(redact(errorText(error), supervisor ? Object.values(supervisor.secrets) : []), { cause: error });
  } finally {
    for (const [signal, listener] of signalListeners) process.removeListener(signal, listener);
    try { redacted?.flush(); } finally {
      control?.close();
      if (supervisor?.stopping && supervisor.servicesStopped === false) {
        console.error('[dev-stack] Service cleanup failed; retaining .dev-stack-lock for manual investigation.');
      } else {
        await release();
      }
    }
  }
}
