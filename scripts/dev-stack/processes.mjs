import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { chmod, lstat } from "node:fs/promises";

// node-pty 1.1.0 may install macOS spawn-helper without its execute bit
// (microsoft/node-pty#850). Repair the local dependency, not system files.
export async function ensureMacNodePtySpawnHelper(root, platform = process.platform, arch = process.arch) {
  if (platform !== "darwin") return false;
  const helper = join(root, "node_modules", "node-pty", "prebuilds", `darwin-${arch}`, "spawn-helper");
  const info = await lstat(helper);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Refusing invalid or symlinked node-pty spawn-helper.");
  }
  if ((info.mode & 0o111) !== 0) return false;
  await chmod(helper, info.mode | 0o111);
  return true;
}

export function startWeb(processes, root, env) {
  // npm workspaces hoists Vite to the checkout root, while its working
  // directory must remain apps/web so it loads the web configuration.
  return processes.start("web", process.execPath,
    [join(root, "node_modules/vite/bin/vite.js"), "--strictPort"],
    { cwd: join(root, "apps/web"), env }, true);
}

export function redact(value, secrets) {
  let result = String(value);
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  return result;
}

// Every child owns a process group: watch-mode subprocesses and PTYs are stopped too.
export class Processes {
  children = new Set();
  stopping = false;
  stopPromise;
  constructor({ secrets = [], output = (line) => process.stdout.write(`${line}\n`) } = {}) {
    this.secrets = secrets;
    this.output = output;
    this.abort = new AbortController();
  }
  start(name, command, args, options = {}, persistent = false) {
    if (this.stopping) throw new Error("Dev-stack is stopping.");
    const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const record = { name, child, exited: false };
    this.children.add(record);
    for (const stream of [child.stdout, child.stderr]) {
      const lines = createInterface({ input: stream });
      lines.on("line", (line) => this.output(`[${name}] ${redact(line, this.secrets)}`));
    }
    const done = new Promise((resolve, reject) => {
      child.once("error", (error) => { record.exited = true; reject(error); });
      child.once("exit", (code, signal) => {
        record.exited = true;
        if (!persistent && code === 0) this.children.delete(record);
        if (!this.stopping && (persistent || code !== 0)) {
          const error = new Error(`${name} exited unexpectedly (${code ?? signal}).`);
          this.abort.abort(error);
          reject(error);
        } else resolve();
      });
    });
    // Persistent failures also interrupt readiness waits; avoid unhandled rejections.
    done.catch((error) => { if (!this.stopping) this.abort.abort(error); });
    return { child, done };
  }
  async run(name, command, args, options) {
    await this.start(name, command, args, options).done;
  }
  stop() {
    this.stopPromise ??= this.stopAll();
    return this.stopPromise;
  }
  async stopAll() {
    this.stopping = true;
    for (const { child } of this.children) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    const deadline = Date.now() + 5000;
    while ([...this.children].some(({ exited }) => !exited) && Date.now() < deadline) await delay(50);
    // A parent can exit while a watcher/PTY remains in its process group.
    for (const { child } of this.children) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
}

export async function waitForReady(url, signal, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
      if (response.ok) {
        const status = await response.json();
        if (status.ok === true && status.dependencies?.database === "RUNNING"
          && status.dependencies?.worker === "RUNNING"
          && status.dependencies?.temporal === "enabled") return;
      }
    } catch (error) { if (signal.aborted) throw error; }
    await delay(500, undefined, { signal });
  }
  throw new Error(`Readiness timeout: ${url}`);
}
