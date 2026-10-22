#!/usr/bin/env node
// One OpenCode 2 server per CLI container; every OpenCode pane attaches to it with --server, as Space's own installation does.
// Two --standalone servers on the one provider store fail: the second exits with "Standalone server exited before reporting
// readiness" (VM218 2026-10-20, two panes started together in the Getting Started room). The next pane start brings a dead
// server back, and changed OpenCode keys or config restart it so new panes see them.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const USERNAME = 'opencode';
const LOCK_STALE_MS = 60_000;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The record lives on the CLI state volume and survives a container restart, after which its PID can belong to any other
// process of the CLI user (pane host, credential agent): only a process that is this port's `opencode serve` is ours to
// reuse or stop (1.1.7 review). Without /proc nothing is ours.
async function ourServer(pid, port) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !alive(pid)) return false;
  const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
  const portAt = args.indexOf('--port');
  return args.includes('serve') && portAt !== -1 && args[portAt + 1] === String(port) && args.some((arg) => /(^|\/)opencode$/.test(arg));
}

async function healthy(port, password) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(2_000),
      headers: { authorization: `Basic ${Buffer.from(`${USERNAME}:${password}`).toString('base64')}` } });
    return response.status === 200;
  } catch { return false; }
}

/** The keys the wrapper exports for OpenCode and its config: a change means the running server is out of date. */
async function fingerprint(env) {
  const keys = Object.keys(env).filter((key) => /_API_KEY$/.test(key)).sort().map((key) => `${key}=${env[key]}`);
  const config = await readFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), 'utf8').catch(() => '');
  return createHash('sha256').update(JSON.stringify([keys, config])).digest('hex');
}

async function stop(pid) {
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 50 && alive(pid); i++) await delay(100);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  for (let i = 0; i < 20 && alive(pid); i++) await delay(100);
}

async function withLock(directory, timeoutMs, work) {
  const lock = join(directory, 'spaceapp-shared-server.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await mkdir(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A start killed mid-way leaves its lock; without this every pane start would wait for it.
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error('OpenCode is still starting for another pane. Reopen this pane in a moment.');
      await delay(150);
    }
  }
  try { return await work(); } finally { await rm(lock, { recursive: true, force: true }); }
}

/** Returns the shared server's URL and Basic auth; starts it when none is healthy or its keys and config changed. */
export async function ensureSharedServer({ env = process.env, port = 47047, timeoutMs = 60_000 } = {}) {
  const directory = join(env.XDG_STATE_HOME, 'opencode');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const recordPath = join(directory, 'spaceapp-shared-server.json');
  const url = `http://127.0.0.1:${port}`;
  const wanted = await fingerprint(env);
  return withLock(directory, timeoutMs, async () => {
    const record = JSON.parse(await readFile(recordPath, 'utf8').catch(() => 'null'));
    const ours = record?.port === port && await ourServer(record.pid, port);
    if (ours && record.fingerprint === wanted) {
      for (let i = 0; i < 20; i++) {
        if (await healthy(port, record.password)) return { url, username: USERNAME, password: record.password, pid: record.pid };
        if (!alive(record.pid)) break;
        await delay(250);
      }
    }
    if (ours) await stop(record.pid);
    const password = randomBytes(32).toString('hex');
    const log = await open(join(directory, 'spaceapp-shared-server.log'), 'a', 0o600);
    // `serve` is the server itself (no client of a per-user background service); it binds to loopback only.
    const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      env: { ...env, OPENCODE_SERVER_USERNAME: USERNAME, OPENCODE_SERVER_PASSWORD: password },
      cwd: env.HOME ?? directory, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref();
    await log.close();
    const next = { pid: child.pid, port, password, fingerprint: wanted, startedAt: new Date().toISOString() };
    await writeFile(`${recordPath}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${recordPath}.tmp`, recordPath);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await healthy(port, password)) return { url, username: USERNAME, password, pid: child.pid };
      if (!alive(child.pid)) break;
      await delay(250);
    }
    await stop(child.pid);
    throw new Error('OpenCode did not start. Reopen this pane; run spaceapp doctor if it keeps failing.');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureSharedServer().then(({ url, username, password }) => {
    process.stdout.write(`OPENCODE_SERVER_URL=${url}\nOPENCODE_SERVER_USERNAME=${username}\nOPENCODE_SERVER_PASSWORD=${password}\n`);
  }, (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
