import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 2) return null;
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return ['Z', 'X'].includes(fields[0]) ? null : `linux:${fields[19]}`;
    } catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return null; throw e; }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart=']);
      const [status, ...start] = stdout.trim().split(/\s+/);
      return !status || /^[ZX]/.test(status) ? null : `darwin:${start.join(' ')}`;
    } catch (e) { if (e.code === 1) return null; throw e; }
  }
  throw new Error('Dev-stack processes require Linux, macOS or Windows11 WSL2.');
}
export async function sameProcess(record, identity = processIdentity) { return Boolean(record?.identity && await identity(record.pid) === record.identity); }
export async function descendants(root, { identity = processIdentity, list = () => exec('ps', ['-axo', 'pid=,ppid=']) } = {}) {
  if (!await sameProcess(root, identity)) throw new Error('Owned process root changed before descendant collection; recovery state retained.');
  const { stdout } = await list();
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const found = new Set([root.pid]);
  for (let changed = true; changed;) { changed = false; for (const [child, parent] of rows) if (found.has(parent) && !found.has(child)) { found.add(child); changed = true; } }
  const records = [];
  for (const child of [...found].reverse()) { const value = await identity(child); if (value) records.push({ pid: child, identity: value }); }
  if (!await sameProcess(root, identity)) throw new Error('Owned process root changed during descendant collection; refusing to adopt its replacement tree.');
  return records;
}
/** Stop admission first, then drain every spawn-to-registration critical section. */
export class LaunchBarrier {
  pending = new Set();
  stopping = false;
  track(register) {
    if (this.stopping) return Promise.reject(new Error('Launch interrupted by shutdown.'));
    // Register the promise before running any spawn code, even synchronous callbacks.
    const job = Promise.resolve().then(register);
    this.pending.add(job);
    return job.finally(() => this.pending.delete(job));
  }
  async stop() { this.stopping = true; await Promise.allSettled([...this.pending]); }
}
export async function stopRecorded(records, { signal = process.kill, identity = processIdentity, timeout = 10000 } = {}) {
  for (const r of records) if (await sameProcess(r, identity)) { try { signal(r.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && (await Promise.all(records.map(r => sameProcess(r, identity)))).some(Boolean)) await delay(100);
  for (const r of records) if (await sameProcess(r, identity)) { try { signal(r.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  await delay(100);
  if ((await Promise.all(records.map(r => sameProcess(r, identity)))).some(Boolean)) throw new Error('An owned process did not stop; recovery state retained.');
}
export function redact(text, secretValues) { let out = String(text); for (const value of secretValues.filter(Boolean)) out = out.split(value).join('[redacted]'); return out; }
export function lineRedactor(secretValues, write) {
  let pending = '';
  return {
    chunk(value) { pending += value.toString('utf8'); let index; while ((index = pending.indexOf('\n')) !== -1) { write(redact(pending.slice(0, index + 1), secretValues)); pending = pending.slice(index + 1); } },
    end() { if (pending) write(redact(pending, secretValues)); pending = ''; }
  };
}
