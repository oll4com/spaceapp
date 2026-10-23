import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class Processes {
  constructor({ root, state, project, env, secrets = [], onFailure = () => {} }) {
    Object.assign(this, { root, state, project, env, secrets, onFailure });
    this.children = new Map();
    mkdirSync(join(state, 'logs'), { recursive: true, mode: 0o700 });
  }
  start(name, command, args, { temporary = false, env = this.env, cwd = this.root } = {}) {
    const path = join(this.state, 'logs', `${name}.log`);
    writeFileSync(path, '', { mode: 0o600 });
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { child, stopping: false, finished: false, done: null };
    this.children.set(name, entry);
    this.record();
    const output = line => {
      for (const secret of this.secrets) if (secret) line = line.replaceAll(secret, '[redacted]');
      appendFileSync(path, line);
      process.stdout.write(`[${name}] ${line}`);
    };
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) !== -1) { output(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
        if (pending.length > 1024 * 1024) { output('[output line too large]\n'); pending = ''; }
      });
      stream.on('end', () => { if (pending) output(`${pending}\n`); });
    }
    entry.done = new Promise(resolve => {
      let settled = false;
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        entry.finished = true;
        this.children.delete(name);
        this.record();
        if (!entry.stopping && (!temporary || code !== 0)) this.onFailure(new Error(`${name} exited unexpectedly (${code ?? signal}). See .dev-stack/logs/${name}.log.`));
        resolve(code ?? 1);
      };
      child.once('error', () => finish(1, 'spawn error'));
      child.once('close', finish);
    });
    return entry;
  }
  async run(name, command, args, options = {}) {
    const code = await this.start(name, command, args, { ...options, temporary: true }).done;
    if (code !== 0) throw new Error(`${name} failed (${code}); see .dev-stack/logs/${name}.log.`);
  }
  record() {
    writeFileSync(join(this.state, 'runtime.json'), JSON.stringify({ supervisorPid: process.pid,
      services: Object.fromEntries([...this.children].map(([name, entry]) => [name, entry.child.pid])) }), { mode: 0o600 });
  }
  async stop(names = [...this.children.keys()]) {
    const entries = names.map(name => this.children.get(name)).filter(Boolean);
    for (const entry of entries) {
      if (entry.finished) continue;
      entry.stopping = true;
      try { process.kill(-entry.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await Promise.race([Promise.all(entries.map(entry => entry.done)), delay(5000, undefined, { ref: false })]);
    for (const entry of entries) {
      if (entry.finished) continue;
      // The process group also contains watch-mode grandchildren.
      try { process.kill(-entry.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await Promise.all(entries.map(entry => entry.done));
  }
}
