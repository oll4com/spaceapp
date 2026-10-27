import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";

/** A bounded, redacted supervisor. Child process groups are owned for their live handle's lifetime. */
export class Processes {
  children = new Set();
  stopping = false;
  constructor(secrets, onFailure) { this.secrets = secrets; this.onFailure = onFailure; }
  redact(text) { for (const secret of this.secrets) text = text.replaceAll(secret, "[redacted]"); return text; }
  start(name, command, args, options = {}, required = false) {
    const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(child);
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", (line) => console.log(`[${name}] ${this.redact(line)}`));
    child.done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${name} exited (${signal ?? code}).`)));
    }).finally(() => this.children.delete(child));
    child.done.catch((error) => { if (required && !child.expectedStop && !this.stopping) this.onFailure(error); });
    if (required) child.once("exit", (code) => { if (code === 0 && !child.expectedStop && !this.stopping) this.onFailure(new Error(`${name} stopped unexpectedly.`)); });
    return child;
  }
  async run(name, command, args, options, timeout = 300_000) {
    const child = this.start(name, command, args, options);
    let timer;
    try { await Promise.race([child.done, new Promise((_, reject) => { timer = setTimeout(() => { this.signal(child, "SIGKILL"); reject(new Error(`${name} timed out.`)); }, timeout); })]); }
    finally { clearTimeout(timer); }
  }
  signal(child, signal) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  async stop() {
    this.stopping = true;
    await this.stopChildren([...this.children]);
  }
  async stopChildren(children) {
    for (const child of children) child.expectedStop = true;
    for (const child of children) this.signal(child, "SIGTERM");
    let timer;
    try { await Promise.race([Promise.allSettled(children.map((child) => child.done)), new Promise((resolve) => { timer = setTimeout(resolve, 8_000); })]); }
    finally { clearTimeout(timer); }
    for (const child of children) this.signal(child, "SIGKILL");
    await Promise.allSettled(children.map((child) => child.done));
  }
}

export async function waitFor(check, label, signal, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (!signal.aborted && Date.now() < deadline) {
    try { if (await check()) return; } catch { /* dependencies may still be starting */ }
    await delay(500, undefined, { signal });
  }
  throw new Error(`${label} did not become ready.`);
}
export async function assertPortsFree(ports) {
  for (const port of Object.values(ports)) {
    await new Promise((resolve, reject) => {
      const socket = net.createServer();
      socket.once("error", () => reject(new Error(`Port ${port} is already in use; configure SPACE_DEV_*_PORT before first start.`)));
      socket.listen(port, "127.0.0.1", () => socket.close(resolve));
    });
  }
}
export async function requestControl(state, action) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(`${state.sockets}/control.sock`);
    let data = "";
    socket.setTimeout(300_000, () => socket.destroy(new Error("Stack control timed out.")));
    socket.on("connect", () => socket.write(JSON.stringify({ id: state.id, action }) + "\n"));
    socket.on("data", (chunk) => { data += chunk; if (data.length > 4096) socket.destroy(new Error("Invalid control response.")); });
    socket.on("error", reject);
    socket.on("end", () => { try { const result = JSON.parse(data); if (result.ok) resolve(result); else reject(new Error(result.error)); } catch (error) { reject(error); } });
  });
}
